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
  /** Script run before the first answer and turn completion. */
  duringFirstTurn?: string;
  /** Whether the first turn starts a shell command. */
  startCommand?: boolean;
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
  else if (message.method === 'thread/goal/set') send({ id: message.id, result: {} });
  else if (message.method === 'turn/interrupt') setTimeout(() => send({ id: message.id, result: {} }), ${options.interruptDelayMs ?? 0});
  else if (message.method === 'thread/backgroundTerminals/list') { record(message); send({ id: message.id, result: { data: [{ itemId: 'exec-1', processId: '85638', command: exec.command, cwd: exec.cwd }], nextCursor: null } }); }
  else if (message.method === 'thread/backgroundTerminals/terminate') { record(message); send({ id: message.id, result: { terminated: true } }); }
  else if (message.method === 'turn/start') {
    record(message);
    const turnId = 'turn-' + (++turns);
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
    if (turns === 1) {
      if (${options.startCommand ?? true}) send({ method: 'item/started', params: { threadId, turnId, item: exec } });
      ${options.duringFirstTurn ?? ""}
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

// Shapes from the app-server protocol and the staging incident: `complete`
// (not `completed`) and `blocked` stop native goal continuation.
const goalUpdate = (
  status: string,
  threadId = "thread-test",
  turnId: string | null = "turn-1",
) =>
  `send({ method: 'thread/goal/updated', params: { threadId: ${JSON.stringify(threadId)}, turnId: ${JSON.stringify(turnId)}, goal: { threadId: ${JSON.stringify(threadId)}, status: ${JSON.stringify(status)} } } });`;

it.each(["complete", "blocked", undefined])(
  "settles a remote turn (goal: %s) without waiting for or terminating leftover processes",
  async (status) => {
    const recorded: Recorded[] = [];
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      closed = resolve;
    });
    server.on("connection", (socket) => {
      socket.on("close", closed);
      socket.on("message", (data) => {
        const message = JSON.parse(String(data)) as Recorded & { id?: number };
        if (message.id === undefined) return;
        recorded.push(message);
        const send = (value: unknown) => socket.send(JSON.stringify(value));
        const reply = (result: unknown) => send({ id: message.id, result });
        if (message.method === "thread/start")
          reply({ thread: { id: "root" } });
        else if (message.method === "turn/start") {
          reply({ turn: { id: "turn-final" } });
          send({
            method: "turn/started",
            params: {
              threadId: "root",
              turn: { id: "turn-final", status: "inProgress" },
            },
          });
          for (const command of [
            "/bin/sh -lc 'python3 -m http.server 3000 --bind 0.0.0.0 --directory /tmp/twill-scroll-preview'",
            "pnpm run dev",
            "sleep 60; echo DONE",
            "node scripts/custom-worker.js",
            "next dev",
            "Xvfb :99",
            "openbox",
            "twill-desktop",
          ]) {
            send({
              method: "item/started",
              params: {
                threadId: "root",
                turnId: "turn-final",
                item: {
                  type: "commandExecution",
                  id: command,
                  command,
                  status: "inProgress",
                },
              },
            });
          }
          if (status) send({
            method: "thread/goal/updated",
            params: {
              threadId: "root",
              turnId: "turn-final",
              goal: { threadId: "root", status },
            },
          });
          // A terminal goal is not enough on its own: the final answer must
          // still be collected before the remote transport is disconnected.
          setTimeout(() => {
            const text =
              status === "blocked"
                ? "Implemented; macOS verification needs runner access."
                : "Implemented and verified.";
            send({
              method: "item/completed",
              params: {
                threadId: "root",
                turnId: "turn-final",
                item: {
                  type: "agentMessage",
                  id: "answer",
                  text,
                  phase: "final_answer",
                },
              },
            });
            send({
              method: "turn/completed",
              params: {
                threadId: "root",
                turn: { id: "turn-final", status: "completed" },
              },
            });
          }, 50);
        } else reply({});
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
    let run: AgentRun | undefined;
    try {
      run = new Agent("codex", {
        sandbox,
        cwd: "/work",
        backgroundTaskTimeoutMs: 200,
      }).stream({
        input: "Implement the preview",
        ...(status ? { goal: "Implement the preview" } : {}),
      });
      const result = await collect(run);
      await disconnected;
      expect(result.error).toBeUndefined();
      expect(result.isCancelled).toBe(false);
      expect(result.text).toBe(
        status === "blocked"
          ? "Implemented; macOS verification needs runner access."
          : "Implemented and verified.",
      );
      expect(backgroundEvents(result.events)).toEqual([]);
      expect(ofType(result.events, "run.completed")).toHaveLength(1);
      expect(recorded.map((request) => request.method)).toEqual([
        "initialize",
        "thread/start",
        ...(status ? ["thread/goal/set"] : []),
        "turn/start",
      ]);
      expect(
        result.rawEvents.some(
          (event) =>
            event.type === "thread/goal/updated" &&
            JSON.stringify(event.payload).includes(status ?? ""),
        ),
      ).toBe(Boolean(status));
      run = undefined;
    } finally {
      await run?.abort();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it.each([true, false])(
  "keeps an active goal open for native continuation (live command: %s)",
  async (startCommand) => {
    const { directory, agent, requests } = await setup("goal-continuation", {
      startCommand,
      // The requested goal is active even before its first status event.
      afterFirstTurn: `setTimeout(() => {
      send({ method: 'turn/started', params: { threadId, turn: { id: 'turn-2', status: 'inProgress' } } });
      ${goalUpdate("blocked", "thread-test", "turn-2")}
      agentMessage('turn-2', 'msg-2', 'DONE; needs external verification');
      completeTurn('turn-2');
    }, 100);`,
    });
    try {
      const result = await collect(
        agent({ backgroundTaskTimeoutMs: 500 }).stream({
          input: "Implement the preview",
          goal: "Implement the preview",
        }),
      );
      expect(result.text).toBe("DONE; needs external verification");
      expect(result.error).toBeUndefined();
      expect(result.isCancelled).toBe(false);
      expect(
        ofType(result.events, "message.started").map(
          (event) => event.messageId,
        ),
      ).toEqual(["turn-1", "turn-2"]);
      expect(ofType(result.events, "run.completed")).toHaveLength(1);
      expect(backgroundEvents(result.events)[0]).toEqual({
        waiting: true,
        ids: [],
      });
      expect(backgroundEvents(result.events).at(-1)).toEqual({
        waiting: false,
        ids: [],
      });
      expect(ofType(result.events, "message.injected")).toEqual([]);
      expect((await requests()).map((request) => request.method)).toEqual([
        "turn/start",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("does not inject a command-result turn while Codex is continuing an active goal", async () => {
  const { directory, agent, requests } = await setup("goal-command-finished", {
    duringFirstTurn: goalUpdate("active"),
    afterFirstTurn: `setTimeout(() => {
      finishCommand();
      send({ method: 'turn/started', params: { threadId, turn: { id: 'turn-native', status: 'inProgress' } } });
      ${goalUpdate("complete", "thread-test", "turn-native")}
      agentMessage('turn-native', 'msg-native', 'NATIVE DONE');
      completeTurn('turn-native');
    }, 100);`,
  });
  try {
    const result = await collect(
      agent({ backgroundTaskTimeoutMs: 500 }).stream({
        input: "Finish the goal",
      }),
    );
    expect(result.text).toBe("NATIVE DONE");
    expect(ofType(result.events, "message.injected")).toEqual([]);
    expect((await requests()).map((request) => request.method)).toEqual([
      "turn/start",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  ["child goal", goalUpdate("complete", "child")],
  ["old turn", goalUpdate("blocked", "thread-test", "turn-old")],
])("ignores a %s when waiting for native goal continuation", async (_name, staleUpdate) => {
  const { directory, agent, requests } = await setup("goal-ignore", {
    duringFirstTurn: `${goalUpdate("active")} ${staleUpdate}`,
    afterFirstTurn: `setTimeout(() => {
      send({ method: 'turn/started', params: { threadId, turn: { id: 'turn-native', status: 'inProgress' } } });
      ${goalUpdate("complete", "thread-test", "turn-native")}
      agentMessage('turn-native', 'msg-native', 'NATIVE DONE');
      completeTurn('turn-native');
    }, 50);`,
  });
  try {
    const result = await collect(agent({ backgroundTaskTimeoutMs: 500 }).stream({ input: "Finish the goal" }));
    expect(result.text).toBe("NATIVE DONE");
    expect(backgroundEvents(result.events)).toEqual([
      { waiting: true, ids: [] },
      { waiting: false, ids: [] },
    ]);
    expect(ofType(result.events, "run.completed")).toHaveLength(1);
    expect((await requests()).map((request) => request.method)).toEqual(["turn/start"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("ignores child turn completion and keeps root goal updates scoped to the root turn", async () => {
  const { directory, agent } = await setup("child-turn", {
    duringFirstTurn: `
      ${goalUpdate("active")}
      send({ method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn', status: 'inProgress' } } });
      send({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } } });
      ${goalUpdate("blocked")}
    `,
  });
  try {
    const result = await collect(agent({ backgroundTaskTimeoutMs: 500 }).stream({ input: "Finish the goal" }));
    expect(result.text).toBe("STARTED");
    expect(backgroundEvents(result.events)).toEqual([]);
    expect(ofType(result.events, "run.completed")).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  ["complete", goalUpdate("complete")],
  ["blocked", goalUpdate("blocked")],
  ["cleared", "send({ method: 'thread/goal/cleared', params: { threadId } });"],
])("settles when an idle active goal becomes %s", async (_name, update) => {
  const { directory, agent, requests } = await setup("goal-after-turn", {
    duringFirstTurn: goalUpdate("active"),
    afterFirstTurn: `setTimeout(() => { ${update} }, 50);`,
  });
  try {
    const result = await collect(agent({ backgroundTaskTimeoutMs: 500 }).stream({ input: "Implement the preview" }));
    expect(result.text).toBe("STARTED");
    expect(backgroundEvents(result.events)).toEqual([
      { waiting: true, ids: [] },
      { waiting: false, ids: [] },
    ]);
    expect(ofType(result.events, "run.completed")).toHaveLength(1);
    expect((await requests()).map((request) => request.method)).toEqual(["turn/start"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([0, 500, Infinity])("finishes an ordinary turn with a live command regardless of the wait ceiling (%s)", async (backgroundTaskTimeoutMs) => {
  const { directory, agent, requests } = await setup("ordinary-turn", {
    afterFirstTurn: finishCommandAfter(100),
  });
  try {
    const result = await collect(agent({ backgroundTaskTimeoutMs }).stream({ input: "Start a command" }));
    expect(result.isCancelled).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.text).toBe("STARTED");
    expect(backgroundEvents(result.events)).toEqual([]);
    expect(ofType(result.events, "message.injected")).toEqual([]);
    expect(ofType(result.events, "run.completed")).toHaveLength(1);
    expect((await requests()).map((request) => request.method)).toEqual(["turn/start"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves command completion events observed within the model's own turn", async () => {
  const { directory, agent, requests } = await setup("native-command-wait", {
    duringFirstTurn: "finishCommand();",
  });
  try {
    const result = await collect(agent().stream({ input: "Wait for the command and answer" }));
    expect(result.text).toBe("STARTED");
    expect(ofType(result.events, "tool.call.completed")).toHaveLength(1);
    expect(backgroundEvents(result.events)).toEqual([]);
    expect(ofType(result.events, "message.injected")).toEqual([]);
    expect((await requests()).map((request) => request.method)).toEqual(["turn/start"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("settles at the first turn for a cleared goal or a disabled goal wait", async () => {
  for (const backgroundTaskTimeoutMs of [0, 500]) {
    const { directory, agent } = await setup("goal-no-wait", {
      duringFirstTurn: `${goalUpdate("active")} ${backgroundTaskTimeoutMs === 0 ? "" : "send({ method: 'thread/goal/cleared', params: { threadId } });"}`,
    });
    try {
      const result = await collect(agent({ backgroundTaskTimeoutMs }).stream({ input: "Finish the goal" }));
      expect(result.text).toBe("STARTED");
      expect(backgroundEvents(result.events)).toEqual([]);
      expect(ofType(result.events, "run.completed")).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

it("bounds an idle native goal wait without stopping shell processes or injecting turns", async () => {
  const { directory, agent, requests } = await setup("goal-ceiling", {
    duringFirstTurn: goalUpdate("active"),
  });
  try {
    const result = await collect(agent({ backgroundTaskTimeoutMs: 100 }).stream({ input: "Finish the goal" }));
    expect(result.isCancelled).toBe(false);
    expect(result.text).toBe("STARTED");
    expect((await requests()).map((request) => request.method)).toEqual(["turn/start"]);
    expect(backgroundEvents(result.events)).toEqual([
      { waiting: true, ids: [] },
      { waiting: false, ids: [] },
    ]);
    expect(ofType(result.events, "run.completed").map((event) => event.text)).toEqual(["STARTED"]);
    expect(ofType(result.events, "message.injected")).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("completes, not cancels, when the host finishes a native goal wait", async () => {
  const { directory, agent, requests } = await setup("goal-finish-wait", {
    duringFirstTurn: goalUpdate("active"),
  });
  let active: AgentRun | undefined;
  try {
    // A ceiling far beyond the test timeout: only the host's request ends the wait.
    active = agent({ backgroundTaskTimeoutMs: 10 * 60_000 }).stream({ input: "Finish the goal" });
    const run = active;
    const result = await collect(run, async (event) => {
      if (event.type === "background.tasks" && event.waiting) await run.finishBackgroundWait();
    });
    expect(result.isCancelled).toBe(false);
    expect(result.text).toBe("STARTED");
    expect(ofType(result.events, "run.completed").map((event) => event.text)).toEqual(["STARTED"]);
    expect(ofType(result.events, "run.cancelled")).toEqual([]);
    expect(backgroundEvents(result.events)).toEqual([
      { waiting: true, ids: [] },
      { waiting: false, ids: [] },
    ]);
    expect((await requests()).map((request) => request.method)).toEqual(["turn/start"]);
    active = undefined;
  } finally {
    await active?.abort();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([0, 300])("cancels during a native goal wait even if its ceiling fires during abort (interrupt delay: %s)", async (interruptDelayMs) => {
  const { directory, agent, requests } = await setup("goal-abort", {
    duringFirstTurn: goalUpdate("active"),
    interruptDelayMs,
  });
  let active: AgentRun | undefined;
  try {
    active = agent({ backgroundTaskTimeoutMs: 100 }).stream({ input: "Finish the goal" });
    const run = active;
    const result = await collect(run, async (event) => {
      if (event.type === "background.tasks" && event.waiting) await run.abort();
    });
    expect(result.isCancelled).toBe(true);
    expect(result.text).toBe("STARTED");
    expect(ofType(result.events, "run.cancelled")).toHaveLength(1);
    expect(ofType(result.events, "run.completed")).toEqual([]);
    expect(backgroundEvents(result.events)).toEqual([
      { waiting: true, ids: [] },
      { waiting: false, ids: [] },
    ]);
    expect((await requests()).map((request) => request.method)).toEqual(["turn/start"]);
    active = undefined;
  } finally {
    await active?.abort();
    await rm(directory, { recursive: true, force: true });
  }
});

it("allows a user message during a native goal wait without injecting SDK follow-ups", async () => {
  const { directory, agent, requests } = await setup("goal-send-message", {
    duringFirstTurn: goalUpdate("active"),
    duringLaterTurn: goalUpdate("complete", "thread-test", "turn-2"),
  });
  try {
    const run = agent({ backgroundTaskTimeoutMs: 500 }).stream({ input: "Finish the goal" });
    let sent = false;
    const result = await collect(run, async (event) => {
      if (event.type === "background.tasks" && event.waiting && !sent) {
        sent = true;
        await run.sendMessage("Any news?");
      }
    });
    expect(result.isCancelled).toBe(false);
    expect(result.text).toBe("DONE");
    const starts = (await requests()).filter((request) => request.method === "turn/start");
    expect(starts).toHaveLength(2);
    expect(starts[1]?.params.input).toEqual([expect.objectContaining({ text: "Any news?" })]);
    expect(backgroundEvents(result.events)).toEqual([
      { waiting: true, ids: [] },
      { waiting: false, ids: [] },
    ]);
    expect(ofType(result.events, "message.injected").map((event) => event.content)).toEqual(["Any news?"]);
    expect(ofType(result.events, "run.completed")).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("cancels when an interrupted turn lands during a native goal wait", async () => {
  const { directory, agent } = await setup("goal-external-cancel", {
    duringFirstTurn: goalUpdate("active"),
    afterFirstTurn: interruptedTurnAfter(50),
  });
  try {
    const result = await collect(agent().stream({ input: "Finish the goal" }));
    expect(result.isCancelled).toBe(true);
    expect(result.text).toBe("STARTED");
    expect(ofType(result.events, "run.cancelled")).toHaveLength(1);
    expect(ofType(result.events, "run.completed")).toEqual([]);
    expect(backgroundEvents(result.events)).toEqual([
      { waiting: true, ids: [] },
      { waiting: false, ids: [] },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// A remote app-server as attachAbort sees it: `turn/interrupt` on an idle
// thread is invalid_request, exactly what codex answers between native goal
// turns; a busy thread accepts it.
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
              {
                itemId: "preview",
                processId: "11021",
                command: "python3 -m http.server 3000",
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
    // Explicit cancellation stops all terminals, including preview servers.
    expect(fake.recorded[6]?.params).toEqual({
      threadId: "thread-test",
      processId: "11021",
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
