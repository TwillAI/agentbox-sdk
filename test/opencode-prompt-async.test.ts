import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  AgentProvider,
  type AgentExecutionRequest,
  type AgentRunSink,
  type NormalizedAgentEvent,
  type RawAgentEvent,
} from "../src";
import { OpenCodeAgentAdapter } from "../src/agents/providers/opencode";
import type { Sandbox } from "../src";

type SseFrame = { event: string; data: unknown; id?: string };

interface FakeOpenCodeServer {
  baseUrl: string;
  promptAsyncRequests: Array<{ body: unknown; sessionId: string }>;
  pushEvent(frame: SseFrame): void;
  close(): Promise<void>;
  /** Set this to make the next prompt_async call respond with the given status. */
  promptAsyncStatusOverride?: number;
  /** When true, the server forcibly closes the next /event connection mid-stream. */
  dropNextEventConnection?: boolean;
}

async function startFakeOpenCodeServer(): Promise<FakeOpenCodeServer> {
  const promptAsyncRequests: FakeOpenCodeServer["promptAsyncRequests"] = [];
  const eventClients: Array<NodeJS.WritableStream & { end?: () => void }> = [];
  const queuedFrames: SseFrame[] = [];

  const writeFrame = (
    res: NodeJS.WritableStream,
    frame: SseFrame,
  ): void => {
    const lines: string[] = [];
    if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
    lines.push(`event: ${frame.event}`);
    lines.push(`data: ${JSON.stringify(frame.data)}`);
    res.write(`${lines.join("\n")}\n\n`);
  };

  const fake: FakeOpenCodeServer = {
    baseUrl: "",
    promptAsyncRequests,
    pushEvent(frame) {
      queuedFrames.push(frame);
      for (const client of eventClients) {
        try {
          writeFrame(client, frame);
        } catch {
          // client gone; ignore
        }
      }
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve(body.length === 0 ? {} : JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  };

  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    if (method === "POST" && url === "/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ses_test" }));
      return;
    }

    const promptMatch = url.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (method === "POST" && promptMatch) {
      const body = await readJson(req).catch(() => ({}));
      promptAsyncRequests.push({
        body,
        sessionId: decodeURIComponent(promptMatch[1] ?? ""),
      });
      const status = fake.promptAsyncStatusOverride ?? 204;
      fake.promptAsyncStatusOverride = undefined;
      res.writeHead(status);
      res.end();
      return;
    }

    if (method === "POST" && /^\/session\/[^/]+\/abort$/.test(url)) {
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
      // Replay queued frames so a late subscriber still sees them.
      for (const frame of queuedFrames) writeFrame(res, frame);
      if (fake.dropNextEventConnection) {
        fake.dropNextEventConnection = false;
        setTimeout(() => res.destroy(), 30);
      }
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
  const port = (server.address() as AddressInfo).port;
  fake.baseUrl = `http://127.0.0.1:${port}`;
  return fake;
}

function makeFakeSandbox(baseUrl: string): Sandbox {
  return {
    getPreviewLink: async () => baseUrl,
    previewHeaders: {} as Record<string, string>,
  } as unknown as Sandbox;
}

interface CapturedSink {
  sink: AgentRunSink;
  raws: RawAgentEvent[];
  events: NormalizedAgentEvent[];
  finished: Promise<{
    kind: "complete" | "cancel" | "fail";
    payload: unknown;
  }>;
}

function makeCapturingSink(): CapturedSink {
  const raws: RawAgentEvent[] = [];
  const events: NormalizedAgentEvent[] = [];
  let resolve!: (v: {
    kind: "complete" | "cancel" | "fail";
    payload: unknown;
  }) => void;
  const finished = new Promise<{
    kind: "complete" | "cancel" | "fail";
    payload: unknown;
  }>((r) => {
    resolve = r;
  });
  const sink: AgentRunSink = {
    setRaw: () => {},
    setAbort: () => {},
    setSessionId: () => {},
    emitRaw: (e) => {
      raws.push(e);
    },
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
  return { sink, raws, events, finished };
}

function makeRequest(
  overrides?: Partial<AgentExecutionRequest<"open-code">>,
): AgentExecutionRequest<"open-code"> {
  return {
    runId: "run-test",
    provider: AgentProvider.OpenCode,
    options: {
      cwd: "/tmp",
      approvalMode: "auto",
      ...overrides?.options,
    },
    run: {
      input: "hello",
      ...overrides?.run,
    },
  } as AgentExecutionRequest<"open-code">;
}

describe("opencode prompt_async + SSE", () => {
  let fake: FakeOpenCodeServer | undefined;

  afterEach(async () => {
    if (fake) {
      await fake.close();
      fake = undefined;
    }
  });

  it("runs a turn end-to-end via prompt_async and SSE session.idle", async () => {
    fake = await startFakeOpenCodeServer();
    const adapter = new OpenCodeAgentAdapter();
    const { sink, events, finished } = makeCapturingSink();

    const request = makeRequest({
      options: {
        cwd: "/tmp",
        approvalMode: "auto",
        sandbox: makeFakeSandbox(fake.baseUrl),
      },
    });

    const executePromise = adapter.execute(request, sink);

    // Wait briefly for the SSE subscription to attach + dispatch to fire.
    await new Promise((r) => setTimeout(r, 100));

    // Stream a small turn: text deltas, then session.idle.
    fake.pushEvent({
      event: "message.part.delta",
      data: {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_test",
          messageID: "msg_a",
          field: "text",
          delta: "Hello ",
        },
      },
    });
    fake.pushEvent({
      event: "message.part.delta",
      data: {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_test",
          messageID: "msg_a",
          field: "text",
          delta: "world",
        },
      },
    });
    fake.pushEvent({
      event: "session.idle",
      data: {
        type: "session.idle",
        properties: { sessionID: "ses_test" },
      },
    });

    const result = await finished;
    await executePromise;

    expect(result.kind).toBe("complete");
    expect((result.payload as { text?: string }).text).toBe("Hello world");
    expect(fake.promptAsyncRequests).toHaveLength(1);
    expect(fake.promptAsyncRequests[0]!.sessionId).toBe("ses_test");

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("text.delta");
    expect(eventTypes).toContain("run.completed");
  });

  it("emits message.completed per assistant message and resolves to the LAST message text", async () => {
    fake = await startFakeOpenCodeServer();
    const adapter = new OpenCodeAgentAdapter();
    const { sink, events, finished } = makeCapturingSink();

    const request = makeRequest({
      options: {
        cwd: "/tmp",
        approvalMode: "auto",
        sandbox: makeFakeSandbox(fake.baseUrl),
      },
    });

    const executePromise = adapter.execute(request, sink);
    await new Promise((r) => setTimeout(r, 100));

    // First assistant message: intermediate narration.
    fake.pushEvent({
      event: "message.part.delta",
      data: {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_test",
          messageID: "msg_a",
          field: "text",
          delta: "Let me find the logo component in the codebase.",
        },
      },
    });
    fake.pushEvent({
      event: "message.updated",
      data: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_a",
            sessionID: "ses_test",
            role: "assistant",
            time: { created: 1, completed: 2 },
          },
        },
      },
    });

    // Second assistant message: the actual final answer.
    fake.pushEvent({
      event: "message.part.delta",
      data: {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_test",
          messageID: "msg_b",
          field: "text",
          delta: "Done. Changed the default logo fill.",
        },
      },
    });
    fake.pushEvent({
      event: "message.updated",
      data: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_b",
            sessionID: "ses_test",
            role: "assistant",
            time: { created: 3, completed: 4 },
          },
        },
      },
    });

    fake.pushEvent({
      event: "session.idle",
      data: {
        type: "session.idle",
        properties: { sessionID: "ses_test" },
      },
    });

    const result = await finished;
    await executePromise;

    expect(result.kind).toBe("complete");
    // sink.complete carries the LAST message text — not the concatenation.
    expect((result.payload as { text?: string }).text).toBe(
      "Done. Changed the default logo fill.",
    );

    // Two message.completed events, in order, each carrying its message text.
    const completedTexts = events
      .filter((e) => e.type === "message.completed")
      .map((e) => (e as { text?: string }).text);
    expect(completedTexts).toEqual([
      "Let me find the logo component in the codebase.",
      "Done. Changed the default logo fill.",
    ]);
  });

  it("retries prompt_async once on transport failure", async () => {
    fake = await startFakeOpenCodeServer();
    fake.promptAsyncStatusOverride = 502;
    const adapter = new OpenCodeAgentAdapter();
    const { sink, finished } = makeCapturingSink();

    const request = makeRequest({
      options: {
        cwd: "/tmp",
        approvalMode: "auto",
        sandbox: makeFakeSandbox(fake.baseUrl),
      },
    });

    const executePromise = adapter.execute(request, sink);
    await new Promise((r) => setTimeout(r, 200));

    fake.pushEvent({
      event: "session.idle",
      data: {
        type: "session.idle",
        properties: { sessionID: "ses_test" },
      },
    });

    const result = await finished;
    await executePromise;

    expect(result.kind).toBe("complete");
    // First attempt 502, retry succeeds with default 204.
    expect(fake.promptAsyncRequests.length).toBeGreaterThanOrEqual(2);
  });

  it("survives an SSE drop mid-stream and completes via the reconnected stream", async () => {
    fake = await startFakeOpenCodeServer();
    fake.dropNextEventConnection = true;
    const adapter = new OpenCodeAgentAdapter();
    const { sink, finished } = makeCapturingSink();

    const request = makeRequest({
      options: {
        cwd: "/tmp",
        approvalMode: "auto",
        sandbox: makeFakeSandbox(fake.baseUrl),
      },
    });

    const executePromise = adapter.execute(request, sink);
    await new Promise((r) => setTimeout(r, 100));

    // Push frame after drop — only the reconnected client receives it,
    // since the server replays queued frames on each subscription.
    fake.pushEvent({
      event: "message.part.delta",
      data: {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_test",
          messageID: "msg_a",
          field: "text",
          delta: "after-reconnect",
        },
      },
    });

    // Wait for resilient reconnect to land (default backoff 500ms + safety).
    await new Promise((r) => setTimeout(r, 1500));

    fake.pushEvent({
      event: "session.idle",
      data: {
        type: "session.idle",
        properties: { sessionID: "ses_test" },
      },
    });

    const result = await finished;
    await executePromise;

    expect(result.kind).toBe("complete");
    expect((result.payload as { text?: string }).text).toContain(
      "after-reconnect",
    );
  }, 15_000);
});
