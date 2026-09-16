import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { Agent } from "../src/agents/Agent";
import { CodexAgentAdapter } from "../src/agents/providers/codex";
import type { Sandbox } from "../src";
import type {
  AgentAttachRequest,
  AgentResult,
  AgentRun,
} from "../src/agents/types";
import type { NormalizedAgentEvent } from "../src/events";

// Payload shapes from the codex-cli 0.154 app-server experiment: unified exec
// returns to the model early, the turn ends with the command `inProgress`,
// and `item/completed` lands ~30s later against the OLD turn id with nothing
// else — no turn/started, the thread stays idle.
const command = "/bin/zsh -lc 'sleep 30; echo CODEX_BG_DONE'";

type FixtureOptions = {
  /** Script run right after the first turn completed. */
  afterFirstTurn?: string;
  /** Script run at the start of every later turn, before its answer. */
  duringLaterTurn?: string;
  /** Delay before `turn/interrupt` is answered. */
  interruptDelayMs?: number;
};

async function fixture(directory: string, options: FixtureOptions) {
  const binary = path.join(directory, "codex-fixture");
  await mkdir(path.join(directory, "codex"), { recursive: true });
  await writeFile(
    binary,
    `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const record = (value) => fs.appendFileSync(process.env.RECORD_FILE, JSON.stringify(value) + '\\n');
const threadId = 'thread-test';
const exec = { type: 'commandExecution', id: 'exec-1', command: ${JSON.stringify(command)}, cwd: '/tmp/work', processId: '85638', source: 'unifiedExecStartup', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
const agentMessage = (turnId, id, text) => {
  send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: id, delta: text } });
  send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id, text, phase: 'final_answer' } } });
};
const completeTurn = (turnId) => send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
const finishCommand = () => {
  send({ method: 'item/commandExecution/outputDelta', params: { itemId: 'exec-1', delta: 'CODEX_BG_DONE\\n' } });
  send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { ...exec, status: 'completed', aggregatedOutput: 'CODEX_BG_DONE\\n', exitCode: 0, durationMs: 30412 } } });
};
let turns = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: threadId } } });
  else if (message.method === 'turn/interrupt') setTimeout(() => send({ id: message.id, result: {} }), ${options.interruptDelayMs ?? 0});
  else if (message.method === 'thread/backgroundTerminals/list') { record(message); send({ id: message.id, result: { data: [{ itemId: 'exec-1', processId: '85638', command: exec.command, cwd: exec.cwd }], nextCursor: null } }); }
  else if (message.method === 'thread/backgroundTerminals/terminate') { record(message); send({ id: message.id, result: { terminated: true } }); }
  else if (message.method === 'turn/start') {
    record(message);
    const turnId = 'turn-' + (++turns);
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
    if (turns === 1) {
      send({ method: 'item/started', params: { threadId, turnId, item: exec } });
      agentMessage(turnId, 'msg-1', 'STARTED');
      completeTurn(turnId);
      ${options.afterFirstTurn ?? ""}
    } else {
      ${options.duringLaterTurn ?? ""}
      agentMessage(turnId, 'msg-' + turns, 'DONE');
      completeTurn(turnId);
    }
  }
});
`,
    { mode: 0o700 },
  );
  return binary;
}

const finishCommandAfter = (delayMs: number) =>
  `setTimeout(finishCommand, ${delayMs});`;
// What the originating run sees when a stateless attachAbort finds the thread
// idle: a turn started only to be interrupted.
const interruptedTurnAfter = (delayMs: number) => `setTimeout(() => {
  send({ method: 'turn/started', params: { threadId, turn: { id: 'turn-cancel', status: 'inProgress' } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-cancel', status: 'interrupted' } } });
}, ${delayMs});`;

type Recorded = { method: string; params: Record<string, unknown> };

async function setup(name: string, options: FixtureOptions = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), `agentbox-codex-bg-${name}-`),
  );
  const record = path.join(directory, "requests.jsonl");
  const binary = await fixture(directory, options);
  const agent = (options: { backgroundTaskTimeoutMs?: number } = {}) =>
    new Agent("codex", {
      cwd: directory,
      stateDirectory: directory,
      provider: { binary },
      env: { RECORD_FILE: record },
      ...options,
    });
  const requests = async (): Promise<Recorded[]> =>
    (await readFile(record, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Recorded);
  return { directory, agent, requests };
}

async function collect(
  run: AgentRun,
  onEvent?: (event: NormalizedAgentEvent) => Promise<void>,
): Promise<AgentResult> {
  for await (const event of run) await onEvent?.(event);
  return run.finished;
}

const backgroundEvents = (events: NormalizedAgentEvent[]) =>
  events.flatMap((event) =>
    event.type === "background.tasks"
      ? [{ waiting: event.waiting, ids: event.tasks.map((task) => task.id) }]
      : [],
  );
const ofType = <T extends NormalizedAgentEvent["type"]>(
  events: NormalizedAgentEvent[],
  type: T,
) =>
  events.filter(
    (event): event is Extract<NormalizedAgentEvent, { type: T }> =>
      event.type === type,
  );

it("wakes Codex with the result of a command that outlived its turn and settles on the follow-up turn", async () => {
  const { directory, agent, requests } = await setup("follow-up", {
    afterFirstTurn: finishCommandAfter(150),
  });
  try {
    const result = await collect(
      agent().stream({ input: "Start the build in the background" }),
    );
    expect(result.isCancelled).toBe(false);
    expect(result.text).toBe("DONE");
    const starts = (await requests()).filter(
      (request) => request.method === "turn/start",
    );
    expect(starts).toHaveLength(2);
    const input = starts[1]?.params.input as
      | Array<{ type: string; text: string }>
      | undefined;
    expect(input).toHaveLength(1);
    const text = String(input?.[0]?.text);
    expect(input?.[0]?.type).toBe("text");
    expect(text).toMatch(
      /^Background command finished while you were idle\.\n\n/,
    );
    expect(text).toContain(
      `\`${command}\` exited with code 0 after 30s.\nOutput (last 4000 chars):\n\`\`\`\nCODEX_BG_DONE\n\`\`\``,
    );
    expect(text).toMatch(
      /\nContinue from here: verify the outcome and finish the task\. Do not restart the command\.$/,
    );
    // Same params builder as sendMessage: thread id and policies come along.
    expect(starts[1]?.params).toMatchObject({
      threadId: "thread-test",
      approvalPolicy: starts[0]?.params.approvalPolicy,
    });
    // Membership changes are reported while waiting; the empty set stays
    // `waiting` until the follow-up turn actually starts.
    expect(backgroundEvents(result.events)).toEqual([
      { waiting: true, ids: ["exec-1"] },
      { waiting: true, ids: [] },
      { waiting: false, ids: [] },
    ]);
    expect(ofType(result.events, "message.injected")).toEqual([
      expect.objectContaining({ content: text, messageId: "turn-2" }),
    ]);
    expect(
      ofType(result.events, "message.started").map((event) => event.messageId),
    ).toEqual(["turn-1", "turn-2"]);
    expect(ofType(result.events, "run.completed")).toHaveLength(1);
    const indexOf = (type: NormalizedAgentEvent["type"]) =>
      result.events.findIndex((event) => event.type === type);
    expect(indexOf("message.injected")).toBeGreaterThan(
      indexOf("background.tasks"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps the legacy settle-at-first-turn behaviour when backgroundTaskTimeoutMs is 0", async () => {
  const { directory, agent, requests } = await setup("legacy", {
    afterFirstTurn: finishCommandAfter(150),
  });
  try {
    const result = await collect(
      agent({ backgroundTaskTimeoutMs: 0 }).stream({
        input: "Start the build in the background",
      }),
    );
    expect(result.isCancelled).toBe(false);
    expect(result.text).toBe("STARTED");
    expect(
      (await requests()).filter((request) => request.method === "turn/start"),
    ).toHaveLength(1);
    expect(backgroundEvents(result.events)).toEqual([]);
    expect(ofType(result.events, "message.injected")).toEqual([]);
    expect(ofType(result.events, "run.completed")).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("terminates leftover commands and completes with the last turn's text when the ceiling expires", async () => {
  const { directory, agent, requests } = await setup("ceiling");
  try {
    const startedAt = Date.now();
    const result = await collect(
      agent({ backgroundTaskTimeoutMs: 200 }).stream({
        input: "Start the build in the background",
      }),
    );
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.isCancelled).toBe(false);
    expect(result.text).toBe("STARTED");
    const recorded = await requests();
    expect(
      recorded.filter((request) => request.method === "turn/start"),
    ).toHaveLength(1);
    // The app-server's own list drives the terminate pass: it also covers
    // commands whose item/started carried no processId.
    expect(
      recorded
        .filter((request) =>
          request.method.startsWith("thread/backgroundTerminals/"),
        )
        .map((request) => [request.method, request.params]),
    ).toEqual([
      ["thread/backgroundTerminals/list", { threadId: "thread-test" }],
      [
        "thread/backgroundTerminals/terminate",
        { threadId: "thread-test", processId: "85638" },
      ],
    ]);
    expect(backgroundEvents(result.events)).toEqual([
      { waiting: true, ids: ["exec-1"] },
      { waiting: false, ids: [] },
    ]);
    expect(
      ofType(result.events, "run.completed").map((event) => event.text),
    ).toEqual(["STARTED"]);
    expect(ofType(result.events, "message.injected")).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("cancels the run when it is aborted while waiting on background work", async () => {
  const { directory, agent, requests } = await setup("abort");
  let active: AgentRun | undefined;
  try {
    active = agent().stream({ input: "Start the build in the background" });
    const run = active;
    const result = await collect(run, async (event) => {
      if (event.type === "background.tasks" && event.waiting) await run.abort();
    });
    expect(result.isCancelled).toBe(true);
    expect(result.text).toBe("STARTED");
    expect(ofType(result.events, "run.cancelled")).toHaveLength(1);
    expect(ofType(result.events, "run.completed")).toEqual([]);
    // Every settle, a cancel included, ends with nothing pending.
    expect(backgroundEvents(result.events)).toEqual([
      { waiting: true, ids: ["exec-1"] },
      { waiting: false, ids: [] },
    ]);
    expect(
      (await requests()).filter((request) => request.method === "turn/start"),
    ).toHaveLength(1);
    active = undefined;
  } finally {
    await active?.abort();
    await rm(directory, { recursive: true, force: true });
  }
});

it("never settles a run whose abort is in progress when the ceiling fires meanwhile", async () => {
  // turn/interrupt answers after the ceiling: the expiry lands inside the
  // abort handler's window.
  const { directory, agent, requests } = await setup("abort-ceiling", {
    interruptDelayMs: 600,
  });
  let active: AgentRun | undefined;
  try {
    active = agent({ backgroundTaskTimeoutMs: 200 }).stream({
      input: "Start the build in the background",
    });
    const run = active;
    const result = await collect(run, async (event) => {
      if (event.type === "background.tasks" && event.waiting) await run.abort();
    });
    expect(result.isCancelled).toBe(true);
    expect(ofType(result.events, "run.completed")).toEqual([]);
    expect(ofType(result.events, "run.cancelled")).toHaveLength(1);
    expect(backgroundEvents(result.events).at(-1)).toEqual({
      waiting: false,
      ids: [],
    });
    const recorded = await requests();
    expect(
      recorded.filter((request) => request.method === "turn/start"),
    ).toHaveLength(1);
    expect(
      recorded.filter((request) =>
        request.method.startsWith("thread/backgroundTerminals/"),
      ),
    ).toEqual([]);
    active = undefined;
  } finally {
    await active?.abort();
    await rm(directory, { recursive: true, force: true });
  }
});

it("runs a user message sent while waiting as a real turn and re-checks the in-flight set at its end", async () => {
  const { directory, agent, requests } = await setup("send-message");
  try {
    const run = agent({ backgroundTaskTimeoutMs: 300 }).stream({
      input: "Start the build in the background",
    });
    let sent = false;
    const result = await collect(run, async (event) => {
      if (event.type === "background.tasks" && event.waiting && !sent) {
        sent = true;
        await run.sendMessage("Any news?");
      }
    });
    expect(result.isCancelled).toBe(false);
    expect(result.text).toBe("DONE");
    const starts = (await requests()).filter(
      (request) => request.method === "turn/start",
    );
    expect(starts).toHaveLength(2);
    expect(starts[1]?.params.input).toEqual([
      expect.objectContaining({ text: "Any news?" }),
    ]);
    // The command is still running when the user's turn ends: the wait
    // resumes with what is left of the budget, and the ceiling ends it.
    expect(backgroundEvents(result.events)).toEqual([
      { waiting: true, ids: ["exec-1"] },
      { waiting: false, ids: ["exec-1"] },
      { waiting: true, ids: ["exec-1"] },
      { waiting: false, ids: [] },
    ]);
    expect(
      ofType(result.events, "message.injected").map((event) => event.content),
    ).toEqual(["Any news?"]);
    expect(
      ofType(result.events, "run.completed").map((event) => event.text),
    ).toEqual(["DONE"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("leaves a command that finishes during a user-sent turn to the model instead of reporting it as idle work", async () => {
  const { directory, agent, requests } = await setup("finish-in-turn", {
    duringLaterTurn: "finishCommand();",
  });
  try {
    const run = agent().stream({ input: "Start the build in the background" });
    let sent = false;
    const result = await collect(run, async (event) => {
      if (event.type === "background.tasks" && event.waiting && !sent) {
        sent = true;
        await run.sendMessage("Any news?");
      }
    });
    expect(result.isCancelled).toBe(false);
    // The model could read the output with write_stdin: its answer stands.
    expect(result.text).toBe("DONE");
    expect(
      (await requests()).filter((request) => request.method === "turn/start"),
    ).toHaveLength(2);
    expect(
      ofType(result.events, "message.injected").map((event) => event.content),
    ).toEqual(["Any news?"]);
    expect(backgroundEvents(result.events)).toEqual([
      { waiting: true, ids: ["exec-1"] },
      { waiting: false, ids: ["exec-1"] },
      { waiting: false, ids: [] },
    ]);
    // The turn's own run.completed, not a settle: one, and no message.injected
    // beyond the user's.
    expect(ofType(result.events, "run.completed")).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("cancels when an interrupted turn lands while waiting (the stateless abort marker)", async () => {
  const { directory, agent, requests } = await setup("external-cancel", {
    afterFirstTurn: interruptedTurnAfter(150),
  });
  try {
    const result = await collect(
      agent().stream({ input: "Start the build in the background" }),
    );
    expect(result.isCancelled).toBe(true);
    expect(result.text).toBe("STARTED");
    expect(ofType(result.events, "run.cancelled")).toHaveLength(1);
    expect(ofType(result.events, "run.completed")).toEqual([]);
    expect(backgroundEvents(result.events)).toEqual([
      { waiting: true, ids: ["exec-1"] },
      { waiting: false, ids: ["exec-1"] },
      { waiting: false, ids: [] },
    ]);
    // No follow-up turn: the interrupted turn ended the run.
    expect(
      (await requests()).filter((request) => request.method === "turn/start"),
    ).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// A remote app-server as attachAbort sees it: `turn/interrupt` on an idle
// thread is invalid_request, exactly what codex answers during a background
// wait; a busy thread accepts it.
async function fakeRemoteAppServer() {
  const recorded: Recorded[] = [];
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as {
        id?: number;
        method: string;
        params: Record<string, unknown>;
      };
      if (message.id === undefined) return;
      recorded.push({ method: message.method, params: message.params });
      const reply = (result: unknown) =>
        socket.send(JSON.stringify({ id: message.id, result }));
      switch (message.method) {
        case "turn/interrupt":
          if (message.params.turnId === "turn-active") reply({});
          else
            socket.send(
              JSON.stringify({
                id: message.id,
                error: {
                  code: -32600,
                  message: "Invalid request: no active turn to interrupt",
                },
              }),
            );
          return;
        case "turn/start":
          reply({ turn: { id: "turn-cancel" } });
          return;
        case "thread/backgroundTerminals/list":
          reply({
            data: [
              {
                itemId: "exec-1",
                processId: "85638",
                command,
                cwd: "/tmp/work",
              },
            ],
            nextCursor: null,
          });
          return;
        default:
          reply({});
      }
    });
  });
  const port = (server.address() as { port: number }).port;
  const sandbox = {
    provider: "e2b",
    previewHeaders: {},
    getPreviewLink: async () => `http://127.0.0.1:${port}`,
    run: async () => ({
      exitCode: 0,
      stdout: "test-token\n",
      stderr: "",
      combinedOutput: "test-token\n",
    }),
  } as unknown as Sandbox;
  return {
    recorded,
    request: (turnId?: string): AgentAttachRequest<"codex"> => ({
      provider: "codex",
      sandbox,
      runId: "run-test",
      sessionId: "thread-test",
      turnId,
    }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

it("attachAbort starts a turn only to interrupt it when the thread is idle, then terminates leftover commands", async () => {
  const fake = await fakeRemoteAppServer();
  try {
    await new CodexAgentAdapter().attachAbort(fake.request("turn-1"));
    expect(fake.recorded.map((request) => request.method)).toEqual([
      "initialize",
      "turn/interrupt",
      "turn/start",
      "turn/interrupt",
      "thread/backgroundTerminals/list",
      "thread/backgroundTerminals/terminate",
    ]);
    expect(fake.recorded[1]?.params).toEqual({
      threadId: "thread-test",
      turnId: "turn-1",
    });
    expect(fake.recorded[2]?.params).toMatchObject({
      threadId: "thread-test",
      input: [{ type: "text", text: "Run cancelled by the host." }],
      approvalPolicy: "never",
    });
    expect(fake.recorded[3]?.params).toEqual({
      threadId: "thread-test",
      turnId: "turn-cancel",
    });
    expect(fake.recorded[5]?.params).toEqual({
      threadId: "thread-test",
      processId: "85638",
    });
  } finally {
    await fake.close();
  }
});

it("attachAbort only interrupts when the turn is active", async () => {
  const fake = await fakeRemoteAppServer();
  try {
    await new CodexAgentAdapter().attachAbort(fake.request("turn-active"));
    expect(fake.recorded.map((request) => request.method)).toEqual([
      "initialize",
      "turn/interrupt",
    ]);
  } finally {
    await fake.close();
  }
});
