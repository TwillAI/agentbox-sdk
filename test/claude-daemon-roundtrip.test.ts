import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeCodeAgentAdapter, createClaudeCodeDaemonScript } from "../src/agents/providers/claude-code";
import type { AgentExecutionRequest, AgentRunSink } from "../src/agents/types";
import type { BackgroundTasksEvent, NormalizedAgentEvent } from "../src/events";
import type { Sandbox } from "../src/sandboxes";

type Frame = { type?: string; subtype?: string; result?: string; state?: string; _notice?: string; _parked?: { tasks: unknown[]; turns: number }; _permission?: { requestId: string; input: Record<string, unknown> } };

const QUESTIONS_SDK = `
export const getSessionInfo = async () => undefined;
export function query({ options }) {
  const controller = new AbortController();
  const iterator = (async function* () {
    yield { type: "system", subtype: "init", session_id: "test" };
    const question = await options.canUseTool("AskUserQuestion", { questions: [{ question: "Which format?", options: [{label:"JSON"}, {label:"Text"}] }] }, { signal: controller.signal, toolUseID: "ask" });
    const plan = await options.canUseTool("ExitPlanMode", { plan: "Print the chosen format." }, { signal: controller.signal, toolUseID: "plan" });
    yield { type: "result", subtype: "success", result: JSON.stringify({ question, plan }) };
  })();
  return Object.assign(iterator, { interrupt: async () => controller.abort(), close() { controller.abort(); } });
}
`;

// Two turns, then the SDK iterator blocks the way the real CLI does while its
// input stays open; only interrupt()/close() lets it finish.
const BACKGROUND_SDK = `
export const getSessionInfo = async () => undefined;
export function query({ options }) {
  if (options.hooks.Stop) throw new Error("Unexpected synthetic Stop hook");
  let release;
  const interrupted = new Promise((resolve) => { release = resolve; });
  const iterator = (async function* () {
    yield { type: "system", subtype: "init", session_id: "test" };
    yield { type: "result", subtype: "success", result: "first" };
    yield { type: "system", subtype: "task_notification", task_id: "bg", status: "completed", output_file: "", summary: "done" };
    yield { type: "result", subtype: "success", result: "second" };
    yield { type: "system", subtype: "session_state_changed", state: "idle" };
    await interrupted;
  })();
  return Object.assign(iterator, { interrupt: async () => release(), close() { release(); } });
}
`;

// One turn, then the iterator blocks until the prompt ends — the real CLI
// only exits once its input closes. Records prompt end and interrupt() per
// query in events.log next to the module so a test can observe teardown.
const DISCONNECT_SDK = `
import { appendFileSync } from "node:fs";
export const getSessionInfo = async () => undefined;
let queries = 0;
export function query({ prompt }) {
  const id = ++queries;
  const log = (line) => appendFileSync(new URL("./events.log", import.meta.url), line + " " + id + "\\n");
  let release;
  const ended = new Promise((resolve) => { release = resolve; });
  (async () => { for await (const _ of prompt) { /* drain */ } log("prompt-ended"); release(); })();
  const iterator = (async function* () {
    yield { type: "system", subtype: "init", session_id: "test" };
    yield { type: "result", subtype: "success", result: "first" };
    await ended;
  })();
  return Object.assign(iterator, { interrupt: async () => log("interrupted"), close() { release(); } });
}
`;

// A CLI that outlives its turns: one turn per user message, and a turn it
// starts on its own once ./finish-task appears (a background task finished).
// The first turn leaves task bg1 running. Records prompt end and interrupt().
const PARK_SDK = `
import { appendFileSync, existsSync } from "node:fs";
export const getSessionInfo = async () => ({});
let queries = 0;
export function query({ prompt, options }) {
  const id = ++queries;
  const log = (line) => appendFileSync(new URL("./events.log", import.meta.url), line + " " + id + "\\n");
  log("query-started");
  const events = [];
  let notify, closed = false, first = true;
  const push = (event) => { events.push(event); notify?.(); };
  const text = (content) => typeof content === "string" ? content : content.map((block) => block.text ?? "").join("");
  (async () => { for await (const message of prompt) push({ user: text(message.message.content) }); log("prompt-ended"); closed = true; notify?.(); })();
  const trigger = new URL("./finish-task", import.meta.url);
  const poll = setInterval(() => { if (existsSync(trigger)) { clearInterval(poll); push({ finished: true }); } }, 20);
  const iterator = (async function* () {
    try {
      for (;;) {
        while (!events.length) { if (closed) return; await new Promise((resolve) => { notify = resolve; }); }
        const event = events.shift();
        yield { type: "system", subtype: "session_state_changed", state: "running" };
        yield { type: "system", subtype: "init", session_id: options.resume ?? options.sessionId };
        if (event.finished) {
          yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
          yield { type: "system", subtype: "task_notification", task_id: "bg1", status: "completed" };
          yield { type: "stream_event", event: { type: "message_start" } };
          yield { type: "result", subtype: "success", result: "woke" };
        } else {
          if (first && event.user !== "plain") yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg1", task_type: "local_bash", description: "slow search" }] };
          first = false;
          yield { type: "result", subtype: "success", result: "answer:" + event.user };
        }
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
    } finally { clearInterval(poll); }
  })();
  return Object.assign(iterator, { interrupt: async () => { log("interrupted"); closed = true; notify?.(); }, close() { closed = true; notify?.(); } });
}
`;

// Parks after a first turn that starts background work, then asks for a tool
// permission on every later turn — so the mode an adopting run brings is
// observable in the frames.
const PARK_PERMISSION_SDK = `
export const getSessionInfo = async () => ({});
export function query({ prompt, options }) {
  const controller = new AbortController();
  const events = [];
  let notify, closed = false, turn = 0;
  (async () => { for await (const message of prompt) { events.push(message); notify?.(); } closed = true; notify?.(); })();
  const iterator = (async function* () {
    for (;;) {
      while (!events.length) { if (closed) return; await new Promise((resolve) => { notify = resolve; }); }
      events.shift();
      turn++;
      yield { type: "system", subtype: "session_state_changed", state: "running" };
      yield { type: "system", subtype: "init", session_id: options.resume ?? options.sessionId };
      if (turn === 1) {
        yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg1", task_type: "local_bash", description: "slow search" }] };
        yield { type: "result", subtype: "success", result: "first" };
      } else {
        const decision = await options.canUseTool("Bash", { command: "ls" }, { signal: controller.signal, toolUseID: "tool" + turn });
        yield { type: "result", subtype: "success", result: decision.behavior };
      }
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }
  })();
  return Object.assign(iterator, { interrupt: async () => { controller.abort(); closed = true; notify?.(); }, close() { closed = true; notify?.(); } });
}
`;

// Like PARK_SDK, but the turn the background task triggers is spread over
// several hundred ms — the way a real turn with tool calls is. Frames keep
// arriving long after the wake POST has been answered.
const PARK_SLOW_SDK = `
import { appendFileSync, existsSync } from "node:fs";
export const getSessionInfo = async () => ({});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function query({ prompt, options }) {
  const events = [];
  let notify, closed = false;
  const push = (event) => { events.push(event); notify?.(); };
  (async () => { for await (const message of prompt) push({ user: true }); closed = true; notify?.(); })();
  const trigger = new URL("./finish-task", import.meta.url);
  const poll = setInterval(() => { if (existsSync(trigger)) { clearInterval(poll); push({ finished: true }); } }, 20);
  const iterator = (async function* () {
    try {
      for (;;) {
        while (!events.length) { if (closed) return; await new Promise((resolve) => { notify = resolve; }); }
        const event = events.shift();
        yield { type: "system", subtype: "session_state_changed", state: "running" };
        yield { type: "system", subtype: "init", session_id: options.resume ?? options.sessionId };
        if (event.finished) {
          await sleep(250);
          yield { type: "system", subtype: "task_notification", task_id: "bg1", status: "completed" };
          await sleep(250);
          yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
          await sleep(250);
          yield { type: "result", subtype: "success", result: "woke" };
        } else {
          yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg1", task_type: "local_bash", description: "slow search" }] };
          yield { type: "result", subtype: "success", result: "first" };
        }
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
    } finally { clearInterval(poll); }
  })();
  return Object.assign(iterator, { interrupt: async () => { closed = true; notify?.(); }, close() { closed = true; notify?.(); } });
}
`;

/** Boot the daemon script against a fake sdk.mjs; returns helpers bound to one run. */
async function startDaemon(sdkSource: string, runId = "test") {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentbox-cloud-daemon-"));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  await writeFile(path.join(cwd, "token"), "test-token", { mode: 0o600 });
  await writeFile(path.join(cwd, "sdk.mjs"), sdkSource);
  await writeFile(path.join(cwd, "daemon.mjs"), createClaudeCodeDaemonScript()
    .replace('from "@anthropic-ai/claude-agent-sdk"', 'from "./sdk.mjs"')
    .replace('"[claude-code-daemon] listening on :" + port', '"[claude-code-daemon] listening on :" + server.address().port'));
  const child = spawn(process.execPath, [path.join(cwd, "daemon.mjs"), "0", path.join(cwd, "token")], { stdio: ["ignore", "ignore", "pipe"] });
  const exited = once(child, "exit");
  const stop = async () => { clearTimeout(timeout); controller.abort(); child.kill("SIGTERM"); await exited; await rm(cwd, { recursive: true, force: true }); };
  let port: string;
  try {
    port = await new Promise<string>((resolve, reject) => {
      child.stderr.on("data", (chunk) => { const match = String(chunk).match(/listening on :(\d+)/); if (match) resolve(match[1]!); });
      child.on("error", reject);
      controller.signal.addEventListener("abort", () => reject(new Error("daemon timeout")), { once: true });
    });
  } catch (error) {
    await stop();
    throw error;
  }
  const base = `http://127.0.0.1:${port}/runs/${runId}`;
  const auth = { authorization: "Bearer test-token" };
  const post = (route: string, body: unknown, authorized = true, signal: AbortSignal = controller.signal) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json", ...(authorized ? auth : {}) }, body: JSON.stringify(body), signal });
  return {
    stop,
    post,
    cwd,
    url: `http://127.0.0.1:${port}`,
    /** Address any run on this daemon, not just the default one. */
    run: (id: string) => ({
      post: (route: string, body: unknown, signal: AbortSignal = controller.signal) => fetch(`http://127.0.0.1:${port}/runs/${id}${route}`, { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body), signal }),
      del: () => fetch(`http://127.0.0.1:${port}/runs/${id}`, { method: "DELETE", headers: auth, signal: controller.signal }),
    }),
    del: () => fetch(base, { method: "DELETE", headers: auth, signal: controller.signal }),
    /** Start a run on its own abort controller so the test can drop the client mid-stream. */
    start: async (client: AbortController) => {
      const response = await post("/start", { prompt: { type: "user", message: { role: "user", content: "Go" } }, options: { autoApproveTools: true, pathToClaudeCodeExecutable: process.execPath } }, true, client.signal);
      expect(response.status).toBe(200);
      return response;
    },
    /** Poll the fake SDK's teardown log until `predicate` holds. */
    events: async (predicate: (lines: string[]) => boolean) => {
      const deadline = Date.now() + 5000;
      for (;;) {
        const lines = await readFile(path.join(cwd, "events.log"), "utf8").then((text) => text.trim().split("\n")).catch(() => [] as string[]);
        if (predicate(lines)) return lines;
        if (Date.now() > deadline) throw new Error(`daemon teardown not observed; log: ${JSON.stringify(lines)}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
  };
}

/** Read the NDJSON /start stream until `predicate` matches, leaving the stream open. */
async function readUntil(response: Response, predicate: (frame: Frame) => boolean | Promise<boolean>): Promise<void> {
  const reader = response.body!.getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended early");
    buffer += Buffer.from(value).toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line.trim() && await predicate(JSON.parse(line) as Frame)) { reader.releaseLock(); return; }
    }
  }
}

/** Read the NDJSON /start stream to its end; `onFrame` may issue control requests. */
async function readFrames(response: Response, onFrame: (frame: Frame) => Promise<void> | void): Promise<Frame[]> {
  const reader = response.body!.getReader();
  const frames: Frame[] = [];
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return frames;
    buffer += Buffer.from(value).toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const frame = JSON.parse(line) as Frame;
      frames.push(frame);
      await onFrame(frame);
    }
  }
}

it("round-trips cloud questions and plan decisions through the authenticated daemon", async () => {
  const daemon = await startDaemon(QUESTIONS_SDK);
  try {
    expect((await daemon.post("/permission", {}, false)).status).toBe(401);
    const response = await daemon.post("/start", { prompt: { type: "user", message: { role: "user", content: "Ask" } }, options: { interactiveQuestions: true, autoApproveTools: true, permissionMode: "bypassPermissions", pathToClaudeCodeExecutable: process.execPath } });
    expect(response.status).toBe(200);
    let asks = 0;
    let result: { question: unknown; plan: unknown } | undefined;
    await readFrames(response, async (frame) => {
      if (frame._permission) {
        asks++;
        const requestId = frame._permission.requestId;
        const answer = requestId === "ask" ? { behavior: "allow", updatedInput: { ...frame._permission.input, answers: { "Which format?": "JSON" } } } : { behavior: "deny", message: "Keep planning" };
        expect((await daemon.post("/permission", { requestId, response: answer })).status).toBe(204);
        expect((await daemon.post("/permission", { requestId, response: answer })).status).toBe(409);
      }
      if (frame.type === "result") result = JSON.parse(frame.result!);
    });
    expect(asks).toBe(2);
    expect(result).toMatchObject({ question: { behavior: "allow", updatedInput: { answers: { "Which format?": "JSON" } } }, plan: { behavior: "deny" } });
  } finally {
    await daemon.stop();
  }
});

it("ends the prompt and interrupts the CLI when the client drops the /start stream", async () => {
  const daemon = await startDaemon(DISCONNECT_SDK);
  try {
    const client = new AbortController();
    const response = await daemon.start(client);
    await readUntil(response, (frame) => frame.type === "result");
    // The host settled and aborted its fetch without any explicit control call.
    client.abort();
    const lines = await daemon.events((seen) => seen.includes("prompt-ended 1"));
    expect(lines).toContain("interrupted 1");
    // The run is released: nothing else can address it.
    expect((await daemon.post("/sendMessage", { content: "more" })).status).toBe(404);
  } finally {
    await daemon.stop();
  }
});

it("never lets a predecessor's teardown evict a successor run reusing its id", async () => {
  const daemon = await startDaemon(DISCONNECT_SDK);
  try {
    const first = new AbortController();
    await readUntil(await daemon.start(first), (frame) => frame.type === "result");
    // A retry attempt starts under the same runId while the first CLI is still up.
    const second = new AbortController();
    await readUntil(await daemon.start(second), (frame) => frame.type === "result");
    first.abort();
    const lines = await daemon.events((seen) => seen.includes("prompt-ended 1"));
    expect(lines).not.toContain("prompt-ended 2");
    expect((await daemon.post("/sendMessage", { content: "still here" })).status).toBe(204);
    expect((await daemon.del()).status).toBe(204);
    await daemon.events((seen) => seen.includes("prompt-ended 2"));
  } finally {
    await daemon.stop();
  }
});

it("forwards messages past the first result until the client ends the run", async () => {
  const daemon = await startDaemon(BACKGROUND_SDK);
  try {
    const response = await daemon.post("/start", { prompt: { type: "user", message: { role: "user", content: "Go" } }, options: { autoApproveTools: true, pathToClaudeCodeExecutable: process.execPath } });
    expect(response.status).toBe(200);
    const frames = await readFrames(response, async (frame) => {
      if (frame.subtype !== "session_state_changed") return;
      // Both turns arrived and the stream is still open: the host decides when the run ends.
      expect((await daemon.del()).status).toBe(204);
    });
    expect(frames.map((frame) => frame.subtype ?? frame.type)).toEqual(["init", "success", "task_notification", "success", "session_state_changed"]);
    expect(frames.filter((frame) => frame.type === "result").map((frame) => frame.result)).toEqual(["first", "second"]);
  } finally {
    await daemon.stop();
  }
});

// ── Parked runs ──────────────────────────────────────────────────────────
// The host settles a run whose background work is still live and leaves; the
// daemon keeps the CLI, wakes the host when it starts a turn on its own, and
// hands it over to the next run for that session.

const START_OPTIONS = { autoApproveTools: true, pathToClaudeCodeExecutable: process.execPath };
const PARKED_TASK = { id: "bg1", type: "local_bash", description: "slow search" };
const userPrompt = (content: string) => ({ type: "user", message: { role: "user", content } });
const names = (frames: Frame[]) => frames.map((frame) => frame._parked ? "_parked" : frame._notice ?? (frame.type === "result" ? `result:${frame.result}` : frame.state ?? frame.subtype ?? frame.type));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Collects the daemon's wake calls the way the host's endpoint would. */
async function wakeReceiver(status = 200) {
  const calls: Array<{ authorization?: string; body: { runId: string; sessionId: string } }> = [];
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => { calls.push({ authorization: req.headers.authorization, body: JSON.parse(text) }); res.writeHead(status); res.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    calls,
    url: `http://127.0.0.1:${port}/wake`,
    until: async (count: number) => { const deadline = Date.now() + 5000; while (calls.length < count) { if (Date.now() > deadline) throw new Error(`wake not observed; saw ${calls.length}`); await pause(20); } },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Run the first turn of job-1 (leaving bg1 running), park it and leave, as the host does. */
async function parkFirstRun(daemon: Awaited<ReturnType<typeof startDaemon>>, park: Record<string, unknown>) {
  const client = new AbortController();
  const response = await daemon.run("job-1").post("/start", { prompt: userPrompt("Go"), options: { ...START_OPTIONS, sessionId: "sess-1" } }, client.signal);
  await readUntil(response, (frame) => frame.state === "idle");
  const parked = await daemon.run("job-1").post("/park", { tasks: [PARKED_TASK], ttlMs: 60_000, ...park });
  expect(await parked.json()).toEqual({ parked: true });
  client.abort();
}

it("keeps a parked CLI alive after the host leaves, wakes the host for the turn it starts, and replays it", async () => {
  const daemon = await startDaemon(PARK_SDK);
  const wake = await wakeReceiver();
  try {
    await parkFirstRun(daemon, { wakeUrl: wake.url, wakeToken: "wake-token" });
    await pause(150);
    expect(await daemon.events(() => true)).toEqual(["query-started 1"]);
    expect(wake.calls).toEqual([]);

    // The background task finishes with nobody attached.
    await writeFile(path.join(daemon.cwd, "finish-task"), "");
    await wake.until(1);
    expect(wake.calls[0]).toEqual({ authorization: "Bearer wake-token", body: { runId: "job-1", sessionId: "sess-1" } });
    // One wake for the turn, not one per frame: the host accepted, and the job
    // it started needs time to attach.
    await pause(300);
    expect(wake.calls.length).toBe(1);

    // The host's wake job attaches without a prompt and gets the whole turn.
    const attached = await daemon.run("job-2").post("/start", { attach: true, options: { ...START_OPTIONS, resume: "sess-1" } });
    const frames: Frame[] = [];
    await readFrames(attached, async (frame) => {
      frames.push(frame);
      if (frame.state === "idle") expect((await daemon.run("job-2").del()).status).toBe(204);
    });
    expect(frames[0]?._parked).toMatchObject({ tasks: [PARKED_TASK], turns: 1 });
    // What is left of the 60s park budget, so the adopting run cannot restart it.
    expect((frames[0]?._parked as { budgetLeftMs?: number }).budgetLeftMs).toBeLessThanOrEqual(60_000);
    // Partial deltas are not held while parked; everything else is, in order.
    expect(names(frames)).toEqual(["_parked", "running", "init", "background_tasks_changed", "task_notification", "result:woke", "idle"]);
    // One CLI served both runs, and only the explicit end wound it down.
    expect(await daemon.events((lines) => lines.includes("prompt-ended 1"))).not.toContain("query-started 2");
    // Re-keyed on adoption: the old run id no longer addresses anything.
    expect((await daemon.run("job-1").post("/sendMessage", { content: "x" })).status).toBe(404);
  } finally {
    await wake.close();
    await daemon.stop();
  }
});

it("hands a parked CLI to a follow-up instead of starting a second one on the session", async () => {
  const daemon = await startDaemon(PARK_SDK);
  try {
    await parkFirstRun(daemon, {});
    const followUp = await daemon.run("job-2").post("/start", { prompt: userPrompt("next"), options: { ...START_OPTIONS, resume: "sess-1" } });
    const frames: Frame[] = [];
    await readFrames(followUp, async (frame) => {
      frames.push(frame);
      if (frame.state === "idle") expect((await daemon.run("job-2").del()).status).toBe(204);
    });
    // Nothing happened while parked: the next result is this run's own.
    expect(frames[0]?._parked).toMatchObject({ tasks: [PARKED_TASK], turns: 0 });
    expect(names(frames)).toEqual(["_parked", "running", "init", "result:answer:next", "idle"]);
    expect(await daemon.events((lines) => lines.includes("prompt-ended 1"))).not.toContain("query-started 2");
  } finally {
    await daemon.stop();
  }
});

it("tells a follow-up how many results precede its own when a turn ran while parked", async () => {
  const daemon = await startDaemon(PARK_SDK);
  const wake = await wakeReceiver();
  try {
    await parkFirstRun(daemon, { wakeUrl: wake.url, wakeToken: "t" });
    await writeFile(path.join(daemon.cwd, "finish-task"), "");
    await wake.until(1);
    await pause(100);
    const followUp = await daemon.run("job-2").post("/start", { prompt: userPrompt("next"), options: { ...START_OPTIONS, resume: "sess-1" } });
    const frames: Frame[] = [];
    await readFrames(followUp, async (frame) => {
      frames.push(frame);
      if (frame.result === "answer:next") expect((await daemon.run("job-2").del()).status).toBe(204);
    });
    expect(frames[0]?._parked?.turns).toBe(1);
    expect(frames.filter((frame) => frame.type === "result").map((frame) => frame.result)).toEqual(["woke", "answer:next"]);
  } finally {
    await wake.close();
    await daemon.stop();
  }
});

it("leaves a parked run alone when an attach finds no turn to stream, and reports a missing one", async () => {
  const daemon = await startDaemon(PARK_SDK);
  try {
    const attach = (id: string) => daemon.run(id).post("/start", { attach: true, options: { ...START_OPTIONS, resume: "sess-1" } });
    expect(names(await readFrames(await attach("job-0"), () => {}))).toEqual(["no_parked_run"]);
    await parkFirstRun(daemon, {});
    expect(names(await readFrames(await attach("job-2"), () => {}))).toEqual(["no_parked_turn"]);
    // Still parked under its own id, CLI untouched.
    expect((await daemon.run("job-1").post("/sendMessage", { content: "x" })).status).toBe(204);
    expect(await daemon.events(() => true)).toEqual(["query-started 1"]);
  } finally {
    await daemon.stop();
  }
});

it("retries the wake until the host accepts it", async () => {
  const daemon = await startDaemon(PARK_SDK);
  const failing = await wakeReceiver(503);
  try {
    await parkFirstRun(daemon, { wakeUrl: failing.url, wakeToken: "t" });
    await writeFile(path.join(daemon.cwd, "finish-task"), "");
    await failing.until(2);
  } finally {
    await failing.close();
    await daemon.stop();
  }
});

it("winds a parked CLI down when its budget runs out, or when the conversation is rewound", async () => {
  const expired = await startDaemon(PARK_SDK);
  try {
    await parkFirstRun(expired, { ttlMs: 60 });
    expect(await expired.events((lines) => lines.includes("prompt-ended 1"))).toContain("interrupted 1");
  } finally {
    await expired.stop();
  }
  const rewound = await startDaemon(PARK_SDK);
  try {
    await parkFirstRun(rewound, {});
    const fork = await rewound.run("job-2").post("/start", { prompt: userPrompt("again"), options: { ...START_OPTIONS, resume: "sess-1", forkSession: true } });
    await readUntil(fork, (frame) => frame.state === "idle");
    // The abandoned branch's work goes; the fork runs on a CLI of its own.
    const lines = await rewound.events((seen) => seen.includes("prompt-ended 1"));
    expect(lines).toContain("interrupted 1");
    expect(lines).toContain("query-started 2");
  } finally {
    await rewound.stop();
  }
});

it("treats a null ttl as no bound instead of an immediate teardown", async () => {
  const daemon = await startDaemon(PARK_SDK);
  try {
    // `ttlMs: null` is how the host says "backgroundTaskTimeoutMs is
    // Infinity". Coercing it would produce 0 and kill the CLI a tick later,
    // right after the run reported the work as parked.
    await parkFirstRun(daemon, { ttlMs: null });
    await pause(200);
    expect(await daemon.events(() => true)).toEqual(["query-started 1"]);
    // Still adoptable, so the work really is still there.
    const followUp = await daemon.run("job-2").post("/start", { prompt: userPrompt("next"), options: { ...START_OPTIONS, resume: "sess-1" } });
    await readUntil(followUp, (frame) => frame.state === "idle");
    expect((await daemon.run("job-2").del()).status).toBe(204);
  } finally {
    await daemon.stop();
  }
});

it("carries the park budget across adoptions so re-parking cannot extend it", async () => {
  const daemon = await startDaemon(PARK_SDK);
  try {
    await parkFirstRun(daemon, { ttlMs: 60_000 });
    await pause(400);
    // Adopt, then park again asking for a full budget: the deadline the first
    // park set has to win, or a monitor that re-arms on every wake-up would
    // hold the sandbox open forever.
    const client = new AbortController();
    const followUp = await daemon.run("job-2").post("/start", { prompt: userPrompt("next"), options: { ...START_OPTIONS, resume: "sess-1" } }, client.signal);
    const frames: Frame[] = [];
    await readUntil(followUp, (frame) => { frames.push(frame); return frame.state === "idle"; });
    const handed = (frames[0]?._parked as { budgetLeftMs?: number } | undefined)?.budgetLeftMs ?? 0;
    // Time already spent parked is gone from what the adopting run is handed.
    expect(handed).toBeGreaterThan(0);
    expect(handed).toBeLessThan(60_000);
    expect((await daemon.run("job-2").post("/park", { tasks: [PARKED_TASK], ttlMs: 60_000 })).status).toBe(200);
    client.abort();
    await pause(300);
    const third = new AbortController();
    const attached = await daemon.run("job-3").post("/start", { prompt: userPrompt("third"), options: { ...START_OPTIONS, resume: "sess-1" } }, third.signal);
    const later: Frame[] = [];
    await readUntil(attached, (frame) => { later.push(frame); return frame.state === "idle"; });
    const stillLeft = (later[0]?._parked as { budgetLeftMs?: number } | undefined)?.budgetLeftMs ?? 0;
    // Counting down from the original park, not restarted by the second one.
    expect(stillLeft).toBeLessThan(handed);
    third.abort();
  } finally {
    await daemon.stop();
  }
});

it("lets an adopting run replace the parking run's permission mode", async () => {
  const daemon = await startDaemon(PARK_PERMISSION_SDK);
  try {
    // job-1 parks with autoApproveTools: true. The follow-up arrives in ask
    // mode, so its own turn must prompt instead of inheriting blanket
    // approval from the CLI it happens to be reusing.
    await parkFirstRun(daemon, {});
    const client = new AbortController();
    const followUp = await daemon.run("job-2").post("/start", { prompt: userPrompt("tool"), options: { ...START_OPTIONS, autoApproveTools: false, resume: "sess-1" } }, client.signal);
    const frames: Frame[] = [];
    await readUntil(followUp, async (frame) => {
      frames.push(frame);
      if (frame._permission)
        await daemon.run("job-2").post("/permission", { requestId: frame._permission.requestId, response: { behavior: "deny", message: "no" } });
      return frame.state === "idle";
    });
    expect(frames.some((frame) => frame._permission)).toBe(true);
    expect(frames.find((frame) => frame.type === "result")?.result).toBe("deny");
    client.abort();
  } finally {
    await daemon.stop();
  }
});


it("drops the park when the run is aborted, so Stop really stops", async () => {
  const daemon = await startDaemon(PARK_SDK);
  const wake = await wakeReceiver();
  try {
    await parkFirstRun(daemon, { wakeUrl: wake.url, wakeToken: "t" });
    expect((await daemon.run("job-1").post("/abort", {})).status).toBe(204);
    expect(await daemon.events((seen) => seen.includes("prompt-ended 1"))).toContain("interrupted 1");
    // The CLI is gone, so the finished task can no longer wake the host.
    await writeFile(path.join(daemon.cwd, "finish-task"), "");
    await pause(300);
    expect(wake.calls).toEqual([]);
  } finally {
    await wake.close();
    await daemon.stop();
  }
});

it("wakes the host once for a long turn, not once per frame", async () => {
  const daemon = await startDaemon(PARK_SLOW_SDK);
  const wake = await wakeReceiver();
  try {
    await parkFirstRun(daemon, { wakeUrl: wake.url, wakeToken: "t" });
    // The turn runs for ~750ms after the host accepts the wake, while the job
    // it started is still booting. Every frame calls wakeHost; only the first
    // may reach the host.
    await writeFile(path.join(daemon.cwd, "finish-task"), "");
    await wake.until(1);
    await pause(900);
    expect(wake.calls.length).toBe(1);
  } finally {
    await wake.close();
    await daemon.stop();
  }
});

it("refuses to park a run it does not know", async () => {
  const daemon = await startDaemon(PARK_SDK);
  try {
    const response = await daemon.run("nope").post("/park", { tasks: [], ttlMs: 1000 });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ parked: false });
  } finally {
    await daemon.stop();
  }
});

// ── The host adapter against the real daemon ─────────────────────────────
// `execute()` needs three things from a sandbox: where the daemon is, the
// preview headers, and the token file.

function hostRun(daemon: Awaited<ReturnType<typeof startDaemon>>, wakeUrl: string | undefined, run: Partial<AgentExecutionRequest<"claude-code">["run"]>) {
  const sandbox = { getPreviewLink: async () => daemon.url, previewHeaders: {}, run: async () => ({ exitCode: 0, stdout: "test-token", stderr: "", combinedOutput: "test-token" }) } as unknown as Sandbox;
  const events: NormalizedAgentEvent[] = [];
  const state: { sessionId?: string; text?: string; cancelled: boolean } = { cancelled: false };
  const sink: AgentRunSink = {
    setRaw: vi.fn(), setAbort: vi.fn(), emitRaw: vi.fn(), onMessage: vi.fn(), fail: vi.fn(),
    setSessionId: (id) => { state.sessionId ??= id; },
    emitEvent: (event) => { events.push(event); },
    requestPermission: vi.fn(async (event) => ({ requestId: event.requestId, decision: "allow" as const })),
    complete: (result) => { state.text = result?.text; },
    cancel: () => { state.cancelled = true; },
  };
  const request: AgentExecutionRequest<"claude-code"> = {
    provider: "claude-code",
    runId: randomUUID(),
    options: { sandbox, cwd: daemon.cwd, approvalMode: "auto", ...(wakeUrl ? { provider: { parkBackgroundWork: { wakeUrl, wakeToken: "wake-token" } } } : {}) },
    run: { input: "Go", model: "sonnet", ...run },
  };
  const background = () => events
    .filter((event): event is BackgroundTasksEvent => event.type === "background.tasks")
    .map((event) => ({ ids: event.tasks.map((task) => task.id), waiting: event.waiting, ...(event.parked ? { parked: true } : {}) }));
  return { request, state, background, done: new ClaudeCodeAgentAdapter().execute(request, sink) };
}

it("ends a run at its answer and parks the CLI only while background work is live", async () => {
  const daemon = await startDaemon(PARK_SDK);
  const wake = await wakeReceiver();
  try {
    // Work still running: the run completes at once instead of waiting on it.
    const first = hostRun(daemon, wake.url, {});
    await first.done;
    expect(first.state).toMatchObject({ text: "answer:Go", cancelled: false });
    expect(first.background().at(-1)).toEqual({ ids: ["bg1"], waiting: false, parked: true });
    await pause(150);
    expect(await daemon.events(() => true)).toEqual(["query-started 1"]);

    // The task finishes with nobody attached: the daemon wakes the host...
    await writeFile(path.join(daemon.cwd, "finish-task"), "");
    await wake.until(1);
    expect(wake.calls[0]).toEqual({ authorization: "Bearer wake-token", body: { runId: first.request.runId, sessionId: first.state.sessionId } });

    // ...whose wake run streams that turn without sending anything. Nothing
    // is live afterwards, so this run ends the CLI the ordinary way.
    const woken = hostRun(daemon, wake.url, { input: "", resumeSessionId: first.state.sessionId, resumeParked: true });
    await woken.done;
    expect(woken.state).toMatchObject({ text: "woke", cancelled: false });
    expect(woken.background().at(-1)).toEqual({ ids: [], waiting: false });
    const lines = await daemon.events((seen) => seen.includes("prompt-ended 1"));
    expect(lines).toContain("interrupted 1");
    expect(lines).not.toContain("query-started 2");
  } finally {
    await wake.close();
    await daemon.stop();
  }
});

it("never parks a run that leaves nothing running", async () => {
  const daemon = await startDaemon(PARK_SDK);
  const wake = await wakeReceiver();
  try {
    const plain = hostRun(daemon, wake.url, { input: "plain" });
    await plain.done;
    expect(plain.state).toMatchObject({ text: "answer:plain", cancelled: false });
    expect(plain.background()).toEqual([]);
    // Wound down exactly as before parking existed.
    expect(await daemon.events((seen) => seen.includes("prompt-ended 1"))).toContain("interrupted 1");
  } finally {
    await wake.close();
    await daemon.stop();
  }
});

it("lets a follow-up take the parked CLI over, keeps its background work, and parks again", async () => {
  const daemon = await startDaemon(PARK_SDK);
  const wake = await wakeReceiver();
  try {
    const first = hostRun(daemon, wake.url, {});
    await first.done;
    const followUp = hostRun(daemon, wake.url, { input: "next", resumeSessionId: first.state.sessionId });
    await followUp.done;
    expect(followUp.state).toMatchObject({ text: "answer:next", cancelled: false });
    // It never saw bg1 start, yet knows it is live and hands it on again.
    expect(followUp.background()).toEqual([
      { ids: ["bg1"], waiting: false },
      { ids: ["bg1"], waiting: true },
      { ids: ["bg1"], waiting: false, parked: true },
    ]);
    await pause(150);
    expect(await daemon.events(() => true)).toEqual(["query-started 1"]);
    expect(wake.calls).toEqual([]);
  } finally {
    await wake.close();
    await daemon.stop();
  }
});

it("answers a follow-up after the turn that ran while parked, not with it", async () => {
  const daemon = await startDaemon(PARK_SDK);
  const wake = await wakeReceiver();
  try {
    const first = hostRun(daemon, wake.url, {});
    await first.done;
    await writeFile(path.join(daemon.cwd, "finish-task"), "");
    await wake.until(1);
    await pause(100);
    const followUp = hostRun(daemon, wake.url, { input: "next", resumeSessionId: first.state.sessionId });
    await followUp.done;
    expect(followUp.state).toMatchObject({ text: "answer:next", cancelled: false });
  } finally {
    await wake.close();
    await daemon.stop();
  }
});

it("completes an attach that finds nothing parked with no text, and waits as before when parking is off", async () => {
  const daemon = await startDaemon(PARK_SDK);
  try {
    const nothing = hostRun(daemon, "http://127.0.0.1:9/wake", { input: "", resumeSessionId: "missing", resumeParked: true });
    await nothing.done;
    expect(nothing.state).toMatchObject({ text: "", cancelled: false });

    // No parkBackgroundWork: the run stays open for bg1 until its budget.
    const waiting = hostRun(daemon, undefined, {});
    waiting.request.options.backgroundTaskTimeoutMs = 120;
    const started = Date.now();
    await waiting.done;
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(waiting.background().some((event) => event.parked)).toBe(false);
    expect(await daemon.events((seen) => seen.includes("prompt-ended 1"))).toContain("interrupted 1");
  } finally {
    await daemon.stop();
  }
});
