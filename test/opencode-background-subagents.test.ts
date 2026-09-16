import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  AgentProvider,
  type AgentExecutionRequest,
  type AgentRunSink,
  type BackgroundTasksEvent,
  type NormalizedAgentEvent,
  type Sandbox,
} from "../src";
import { OpenCodeAgentAdapter } from "../src/agents/providers/opencode";

// Trimmed copy of the fake server in opencode-prompt-async.test.ts: the
// routes execute() touches, an SSE bus that replays queued frames to late
// subscribers, a record of `POST /session/:id/abort` calls, and the
// `GET /session/status` map (non-idle sessions only, like opencode's).
type SseFrame = { event: string; data: unknown };

interface FakeOpenCodeServer {
  baseUrl: string;
  promptAsyncRequests: unknown[];
  abortedSessions: string[];
  statuses: Record<string, { type: string }>;
  /** Serve `GET /session/status`; a 404 stands for an older server. */
  statusRoute: boolean;
  pushEvent(frame: SseFrame): void;
  close(): Promise<void>;
}

async function startFakeOpenCodeServer(): Promise<FakeOpenCodeServer> {
  const promptAsyncRequests: unknown[] = [];
  const abortedSessions: string[] = [];
  const eventClients: NodeJS.WritableStream[] = [];
  const queuedFrames: SseFrame[] = [];
  const writeFrame = (res: NodeJS.WritableStream, frame: SseFrame) =>
    res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
  const readJson = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () =>
        resolve(
          chunks.length
            ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
            : {},
        ),
      );
    });
  const fake: FakeOpenCodeServer = {
    baseUrl: "",
    promptAsyncRequests,
    abortedSessions,
    statuses: {},
    statusRoute: true,
    pushEvent(frame) {
      queuedFrames.push(frame);
      for (const client of eventClients) writeFrame(client, frame);
    },
    close: async () => {},
  };
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";
    if (method === "POST" && url === "/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ses_test" }));
      return;
    }
    if (method === "GET" && url === "/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (method === "GET" && url === "/session/status") {
      if (!fake.statusRoute) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(fake.statuses));
      return;
    }
    if (method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(url)) {
      promptAsyncRequests.push(await readJson(req));
      res.writeHead(204);
      res.end();
      return;
    }
    const abortMatch = url.match(/^\/session\/([^/]+)\/abort$/);
    if (method === "POST" && abortMatch) {
      abortedSessions.push(abortMatch[1]!);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("true");
      return;
    }
    if (method === "GET" && url === "/event") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      eventClients.push(res);
      for (const frame of queuedFrames) writeFrame(res, frame);
      req.on("close", () => {
        const idx = eventClients.indexOf(res);
        if (idx >= 0) eventClients.splice(idx, 1);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}

function makeFakeSandbox(baseUrl: string): Sandbox {
  return {
    getPreviewLink: async () => baseUrl,
    previewHeaders: {},
    run: async () => ({
      exitCode: 0,
      stdout: "test-capability-token",
      stderr: "",
      combinedOutput: "test-capability-token",
    }),
  } as unknown as Sandbox;
}

type Settled = { kind: "complete" | "cancel" | "fail"; payload: unknown };

function makeCapturingSink() {
  const events: NormalizedAgentEvent[] = [];
  let abort: (() => Promise<void>) | undefined;
  let resolve!: (v: Settled) => void;
  const finished = new Promise<Settled>((r) => {
    resolve = r;
  });
  const sink: AgentRunSink = {
    setRaw: () => {},
    setAbort: (fn) => {
      abort = fn;
    },
    setSessionId: () => {},
    emitRaw: () => {},
    emitEvent: (e) => {
      events.push(e);
    },
    requestPermission: async () => ({
      requestId: "",
      decision: "allow" as const,
    }),
    onMessage: () => {},
    complete: (payload) => resolve({ kind: "complete", payload }),
    cancel: (payload) => resolve({ kind: "cancel", payload }),
    fail: (payload) => resolve({ kind: "fail", payload }),
  };
  return { sink, events, finished, abort: () => abort!() };
}

function makeRequest(
  fake: FakeOpenCodeServer,
  options: Record<string, unknown> = {},
): AgentExecutionRequest<"open-code"> {
  return {
    runId: "run-test",
    provider: AgentProvider.OpenCode,
    options: {
      cwd: "/tmp",
      approvalMode: "auto",
      sandbox: makeFakeSandbox(fake.baseUrl),
      ...options,
    },
    run: { input: "hello" },
  } as AgentExecutionRequest<"open-code">;
}

// Frames shaped like opencode 1.18.30's SSE bus (see design note): only the
// fields the adapter reads.
const status = (
  sessionID: string,
  type: "busy" | "idle" | "retry",
): SseFrame => ({
  event: "session.status",
  data: { type: "session.status", properties: { sessionID, status: { type } } },
});
const idle = (sessionID: string): SseFrame => ({
  event: "session.idle",
  data: { type: "session.idle", properties: { sessionID } },
});
const sessionError = (): SseFrame => ({
  event: "session.error",
  data: {
    type: "session.error",
    properties: {
      sessionID: "ses_test",
      error: { name: "UnknownError", data: { message: "boom" } },
    },
  },
});
const delta = (messageID: string, text: string): SseFrame => ({
  event: "message.part.delta",
  data: {
    type: "message.part.delta",
    properties: {
      sessionID: "ses_test",
      messageID,
      field: "text",
      delta: text,
    },
  },
});
const assistantDone = (id: string): SseFrame => ({
  event: "message.updated",
  data: {
    type: "message.updated",
    properties: {
      info: {
        id,
        sessionID: "ses_test",
        role: "assistant",
        time: { created: 1, completed: 2 },
      },
    },
  },
});
const childCreated = (id: string, title: string): SseFrame => ({
  event: "session.created",
  data: {
    type: "session.created",
    properties: { info: { id, parentID: "ses_test", title } },
  },
});
const taskPart = (
  jobId: string,
  title: string,
  background: boolean,
): SseFrame => ({
  event: "message.part.updated",
  data: {
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_task",
        sessionID: "ses_test",
        messageID: "msg_a",
        type: "tool",
        tool: "task",
        callID: "call_1",
        state: {
          status: background ? "completed" : "running",
          input: { description: title, ...(background ? { background } : {}) },
          title,
          output: background ? "Background task started" : undefined,
          metadata: {
            parentSessionId: "ses_test",
            sessionId: jobId,
            ...(background ? { background: true, jobId } : {}),
          },
        },
      },
    },
  },
});
// TaskTool.injectBackgroundResult: a synthetic user message on the parent.
const injected = (): SseFrame[] => [
  {
    event: "message.updated",
    data: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_inject",
          sessionID: "ses_test",
          role: "user",
          time: { created: 3 },
        },
      },
    },
  },
  {
    event: "message.part.updated",
    data: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_inject",
          sessionID: "ses_test",
          messageID: "msg_inject",
          type: "text",
          synthetic: true,
          text: '<task id="ses_child" state="completed">\n<summary>Background task completed: Audit the tests</summary>\n<task_result>\ndone\n</task_result>\n</task>',
        },
      },
    },
  },
];

const child = {
  id: "ses_child",
  type: "subagent",
  description: "Audit the tests",
};
const backgroundEvents = (events: NormalizedAgentEvent[]) =>
  events
    .filter((e): e is BackgroundTasksEvent => e.type === "background.tasks")
    .map((e) => ({ tasks: e.tasks, waiting: e.waiting }));
const stillRunning = (finished: Promise<Settled>) =>
  Promise.race([
    finished.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), 150)),
  ]);

/** First turn: an answer, a child started, the parent idles with the child busy. */
async function firstTurn(
  fake: FakeOpenCodeServer,
  background = true,
): Promise<void> {
  await vi.waitFor(() => expect(fake.promptAsyncRequests).toHaveLength(1));
  fake.statuses.ses_child = { type: "busy" };
  fake.pushEvent(delta("msg_a", "First answer"));
  fake.pushEvent(childCreated("ses_child", "Audit the tests"));
  fake.pushEvent(taskPart("ses_child", "Audit the tests", background));
  fake.pushEvent(status("ses_child", "busy"));
  fake.pushEvent(assistantDone("msg_a"));
  fake.pushEvent(status("ses_test", "idle"));
  fake.pushEvent(idle("ses_test"));
}

/** The parent's re-run after the injection: a second answer, then idle. */
function secondTurn(fake: FakeOpenCodeServer): void {
  fake.pushEvent(delta("msg_b", "Second answer"));
  fake.pushEvent(assistantDone("msg_b"));
  fake.pushEvent(status("ses_test", "idle"));
  fake.pushEvent(idle("ses_test"));
}

describe("opencode background subagents", () => {
  let fake: FakeOpenCodeServer | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it("stays open for a busy child and completes with the re-run parent's answer", async () => {
    fake = await startFakeOpenCodeServer();
    const { sink, events, finished } = makeCapturingSink();
    const executing = new OpenCodeAgentAdapter().execute(
      makeRequest(fake),
      sink,
    );
    await firstTurn(fake);

    await vi.waitFor(() =>
      expect(backgroundEvents(events)).toEqual([
        { tasks: [child], waiting: true },
      ]),
    );
    expect(await stillRunning(finished)).toBe(true);

    // The child finishes; opencode injects its result and re-runs the parent.
    delete fake.statuses.ses_child;
    fake.pushEvent(status("ses_child", "idle"));
    fake.pushEvent(idle("ses_child"));
    await vi.waitFor(() => expect(backgroundEvents(events)).toHaveLength(2));
    for (const frame of injected()) fake.pushEvent(frame);
    // Never streamed by opencode for user parts; guards the run text anyway.
    fake.pushEvent(delta("msg_inject", "<task id=ses_child state=completed>"));
    fake.pushEvent(status("ses_test", "busy"));
    await vi.waitFor(() => expect(backgroundEvents(events)).toHaveLength(3));
    expect(await stillRunning(finished)).toBe(true);

    secondTurn(fake);
    const result = await finished;
    await executing;
    expect(result.kind).toBe("complete");
    expect((result.payload as { text?: string }).text).toBe("Second answer");
    expect(backgroundEvents(events)).toEqual([
      { tasks: [child], waiting: true },
      { tasks: [], waiting: true },
      { tasks: [], waiting: false },
    ]);
    expect(events.filter((e) => e.type === "run.completed")).toHaveLength(1);
    expect(
      events
        .filter((e) => e.type === "text.delta")
        .map((e) => (e as { delta: string }).delta),
    ).toEqual(["First answer", "Second answer"]);
    // The re-run is opencode's own; the adapter dispatched nothing extra.
    expect(fake.promptAsyncRequests).toHaveLength(1);
    expect(fake.abortedSessions).toEqual([]);
  });

  it("settles at the parent's first idle when no child ran in the background", async () => {
    fake = await startFakeOpenCodeServer();
    const { sink, events, finished } = makeCapturingSink();
    const executing = new OpenCodeAgentAdapter().execute(
      makeRequest(fake),
      sink,
    );
    // A foreground child whose idle frame this listener never sees: without
    // a background child the server will not re-prompt the parent.
    await firstTurn(fake, false);
    const result = await finished;
    await executing;
    expect(result.kind).toBe("complete");
    expect((result.payload as { text?: string }).text).toBe("First answer");
    expect(backgroundEvents(events)).toEqual([]);
    expect(fake.abortedSessions).toEqual([]);
  });

  it("keeps the legacy first-idle settle when backgroundTaskTimeoutMs is 0", async () => {
    fake = await startFakeOpenCodeServer();
    const { sink, events, finished } = makeCapturingSink();
    const executing = new OpenCodeAgentAdapter().execute(
      makeRequest(fake, { backgroundTaskTimeoutMs: 0 }),
      sink,
    );
    await firstTurn(fake);
    const result = await finished;
    await executing;
    expect(result.kind).toBe("complete");
    expect((result.payload as { text?: string }).text).toBe("First answer");
    expect(backgroundEvents(events)).toEqual([]);
  });

  it("completes with the first answer and stops the children when the ceiling expires", async () => {
    fake = await startFakeOpenCodeServer();
    const { sink, events, finished } = makeCapturingSink();
    const executing = new OpenCodeAgentAdapter().execute(
      makeRequest(fake, { backgroundTaskTimeoutMs: 300 }),
      sink,
    );
    await firstTurn(fake);
    const result = await finished;
    await executing;
    expect(result.kind).toBe("complete");
    expect((result.payload as { text?: string }).text).toBe("First answer");
    expect(backgroundEvents(events)).toEqual([
      { tasks: [child], waiting: true },
      { tasks: [], waiting: false },
    ]);
    expect(fake.abortedSessions).toEqual(["ses_test"]);
  });

  it("cancels when aborted while waiting on a child", async () => {
    fake = await startFakeOpenCodeServer();
    const { sink, events, finished, abort } = makeCapturingSink();
    const executing = new OpenCodeAgentAdapter().execute(
      makeRequest(fake),
      sink,
    );
    await firstTurn(fake);
    await vi.waitFor(() => expect(backgroundEvents(events)).toHaveLength(1));
    await abort();
    const result = await finished;
    await executing;
    expect(result.kind).toBe("cancel");
    expect(fake.abortedSessions).toEqual(["ses_test"]);
    expect(backgroundEvents(events).at(-1)).toEqual({
      tasks: [],
      waiting: false,
    });
  });

  it("reconciles a child whose idle frame was lost against the server's status map", async () => {
    fake = await startFakeOpenCodeServer();
    const { sink, events, finished } = makeCapturingSink();
    const executing = new OpenCodeAgentAdapter().execute(
      makeRequest(fake),
      sink,
    );
    await firstTurn(fake);
    await vi.waitFor(() => expect(backgroundEvents(events)).toHaveLength(1));

    // The child's idle and the injection fall into an SSE gap; only the
    // parent's resumption and its second answer get through.
    delete fake.statuses.ses_child;
    fake.pushEvent(status("ses_test", "busy"));
    await vi.waitFor(() =>
      expect(backgroundEvents(events).at(-1)).toEqual({
        tasks: [child],
        waiting: false,
      }),
    );
    secondTurn(fake);
    const result = await finished;
    await executing;
    expect(result.kind).toBe("complete");
    expect((result.payload as { text?: string }).text).toBe("Second answer");
    expect(backgroundEvents(events).at(-1)).toEqual({
      tasks: [],
      waiting: false,
    });
    expect(fake.abortedSessions).toEqual([]);
  });

  it("takes the injected task result as the child's completion when its own frames were lost", async () => {
    fake = await startFakeOpenCodeServer();
    // An older server without the status route: only the frames can tell.
    fake.statusRoute = false;
    const { sink, events, finished } = makeCapturingSink();
    const executing = new OpenCodeAgentAdapter().execute(
      makeRequest(fake),
      sink,
    );
    await firstTurn(fake);
    await vi.waitFor(() => expect(backgroundEvents(events)).toHaveLength(1));

    for (const frame of injected()) fake.pushEvent(frame);
    await vi.waitFor(() =>
      expect(backgroundEvents(events).at(-1)).toEqual({
        tasks: [],
        waiting: false,
      }),
    );
    fake.pushEvent(status("ses_test", "busy"));
    secondTurn(fake);
    const result = await finished;
    await executing;
    expect(result.kind).toBe("complete");
    expect((result.payload as { text?: string }).text).toBe("Second answer");
    expect(fake.abortedSessions).toEqual([]);
  });

  it("stops a child still live when the run fails after the parent resumed", async () => {
    fake = await startFakeOpenCodeServer();
    const { sink, events, finished } = makeCapturingSink();
    const executing = new OpenCodeAgentAdapter().execute(
      makeRequest(fake),
      sink,
    );
    await firstTurn(fake);
    await vi.waitFor(() => expect(backgroundEvents(events)).toHaveLength(1));

    fake.pushEvent(status("ses_test", "busy"));
    await vi.waitFor(() => expect(backgroundEvents(events)).toHaveLength(2));
    fake.pushEvent(sessionError());
    const result = await finished;
    await executing;
    expect(result.kind).toBe("fail");
    expect(fake.abortedSessions).toEqual(["ses_test"]);
    expect(backgroundEvents(events)).toEqual([
      { tasks: [child], waiting: true },
      { tasks: [child], waiting: false },
      { tasks: [], waiting: false },
    ]);
  });
});
