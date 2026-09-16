import { expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { createClaudeCodeDaemonScript } from "../src/agents/providers/claude-code";

type Frame = { type?: string; subtype?: string; result?: string; _permission?: { requestId: string; input: Record<string, unknown> } };

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
export function query() {
  let release;
  const interrupted = new Promise((resolve) => { release = resolve; });
  const iterator = (async function* () {
    yield { type: "system", subtype: "init", session_id: "test" };
    yield { type: "result", subtype: "success", result: "first" };
    yield { type: "system", subtype: "task_notification", task_id: "bg", status: "completed", output_file: "", summary: "done" };
    yield { type: "result", subtype: "success", result: "second" };
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
async function readUntil(response: Response, predicate: (frame: Frame) => boolean): Promise<void> {
  const reader = response.body!.getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended early");
    buffer += Buffer.from(value).toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line.trim() && predicate(JSON.parse(line) as Frame)) { reader.releaseLock(); return; }
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
    let results = 0;
    const frames = await readFrames(response, async (frame) => {
      if (frame.type !== "result" || ++results < 2) return;
      // Both turns arrived and the stream is still open: the host decides when the run ends.
      expect((await daemon.del()).status).toBe(204);
    });
    expect(frames.map((frame) => frame.subtype ?? frame.type)).toEqual(["init", "success", "task_notification", "success"]);
    expect(frames.filter((frame) => frame.type === "result").map((frame) => frame.result)).toEqual(["first", "second"]);
  } finally {
    await daemon.stop();
  }
});
