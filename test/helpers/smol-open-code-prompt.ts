import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { Agent } from "../../src/agents/Agent";
import { Sandbox } from "../../src/sandboxes/Sandbox";

/** Full agent prompt without external model credentials or usage charges. */
export async function verifySmolOpenCodePrompt(): Promise<void> {
  const sandbox = new Sandbox("smol", {
    image: "ghcr.io/anomalyco/opencode:1.18.35",
    workingDir: "/workspace",
    tags: { "agentbox.test": randomUUID() },
    provider: { network: true },
  });
  try {
    await sandbox.findOrProvision();
    // The upstream image omits AgentBox setup tools and the guest-local
    // Node server used to stand in for a paid model endpoint.
    const prerequisites = await sandbox.run(
      "apk add --no-cache bash curl python3 coreutils git nodejs",
      { timeoutMs: 60_000 },
    );
    expect(prerequisites.exitCode, prerequisites.stderr).toBe(0);
    const mock = `const http = require("http");
http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    require("fs").appendFileSync("/workspace/model-requests.log", req.url + "\\n");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "mock-smol", object: "chat.completion.chunk", created: 1, model: "openai/gpt-4o-mini" };
    res.write("data: " + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "SMOL_MODEL_OK" }, finish_reason: null }] }) + "\\n\\n");
    res.write("data: " + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }) + "\\n\\n");
    res.end("data: [DONE]\\n\\n");
  });
}).listen(18080, "127.0.0.1");`;
    await sandbox.uploadFile(mock, "/workspace/model-server.js");
    const started = await sandbox.run(
      "nohup node /workspace/model-server.js >/workspace/model-server.log 2>&1 </dev/null &",
    );
    expect(started.exitCode).toBe(0);
    const agent = new Agent("open-code", {
      sandbox,
      cwd: "/workspace",
      approvalMode: "auto",
      env: {
        OPENROUTER_BASE_URL: "http://127.0.0.1:18080/v1",
        OPENROUTER_API_KEY: "test-only",
      },
    });
    await agent.setup();
    const result = await agent.run({
      model: "openrouter/openai/gpt-4o-mini",
      input: "Reply with SMOL_MODEL_OK",
    });
    const requests = await sandbox.run(
      "if test -f /workspace/model-requests.log; then cat /workspace/model-requests.log; fi",
    );
    const serverLog = await sandbox.run("tail -n 20 /workspace/model-server.log");
    expect(result.text, JSON.stringify({
      error: result.error,
      events: result.events.map((event) => event.type),
      requests: requests.stdout,
      serverLog: serverLog.stdout,
    })).toContain("SMOL_MODEL_OK");
    expect(requests.stdout).toContain("/chat/completions");
  } finally {
    await sandbox.delete().catch(() => undefined);
  }
}
