import { expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { createClaudeCodeDaemonScript } from "../src/agents/providers/claude-code";

it("round-trips cloud questions and plan decisions through the authenticated daemon", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentbox-cloud-questions-"));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  await writeFile(path.join(cwd, "token"), "test-token", { mode: 0o600 });
  await writeFile(path.join(cwd, "sdk.mjs"), `
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
`);
  await writeFile(path.join(cwd, "daemon.mjs"), createClaudeCodeDaemonScript()
    .replace('from "@anthropic-ai/claude-agent-sdk"', 'from "./sdk.mjs"')
    .replace('"[claude-code-daemon] listening on :" + port', '"[claude-code-daemon] listening on :" + server.address().port'));
  const child = spawn(process.execPath, [path.join(cwd, "daemon.mjs"), "0", path.join(cwd, "token")], { stdio: ["ignore", "ignore", "pipe"] });
  const exited = once(child, "exit");
  try {
    const port = await new Promise<string>((resolve, reject) => {
      child.stderr.on("data", (chunk) => { const match = String(chunk).match(/listening on :(\d+)/); if (match) resolve(match[1]!); });
      child.on("error", reject);
      controller.signal.addEventListener("abort", () => reject(new Error("daemon timeout")), { once: true });
    });
    const base = `http://127.0.0.1:${port}/runs/test`;
    const post = (route: string, body: unknown, authorized = true) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json", ...(authorized ? { authorization: "Bearer test-token" } : {}) }, body: JSON.stringify(body), signal: controller.signal });
    expect((await post("/permission", {}, false)).status).toBe(401);
    const response = await post("/start", { prompt: { type: "user", message: { role: "user", content: "Ask" } }, options: { interactiveQuestions: true, autoApproveTools: true, permissionMode: "bypassPermissions", pathToClaudeCodeExecutable: process.execPath } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let buffer = "";
    let asks = 0;
    let result: { question: unknown; plan: unknown } | undefined;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += Buffer.from(value).toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (frame._permission) {
          asks++;
          const requestId = frame._permission.requestId;
          const answer = requestId === "ask" ? { behavior: "allow", updatedInput: { ...frame._permission.input, answers: { "Which format?": "JSON" } } } : { behavior: "deny", message: "Keep planning" };
          expect((await post("/permission", { requestId, response: answer })).status).toBe(204);
          expect((await post("/permission", { requestId, response: answer })).status).toBe(409);
        }
        if (frame.type === "result") result = JSON.parse(frame.result);
      }
    }
    expect(asks).toBe(2);
    expect(result).toMatchObject({ question: { behavior: "allow", updatedInput: { answers: { "Which format?": "JSON" } } }, plan: { behavior: "deny" } });
  } finally {
    clearTimeout(timeout);
    controller.abort();
    child.kill("SIGTERM");
    await exited;
    await rm(cwd, { recursive: true, force: true });
  }
});
