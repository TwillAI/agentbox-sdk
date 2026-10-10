import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agents/Agent";
import { Sandbox } from "../src/sandboxes/Sandbox";

const live = process.env.AGENTBOX_RUN_SMOL_CLOUD_AGENT_E2E === "1" ? describe : describe.skip;

live("OpenCode server in a Smol Cloud VM", () => {
  it("sets up, authenticates, stops and restarts a real agent server", async () => {
    const sandbox = new Sandbox("smol", {
      image: process.env.AGENTBOX_SMOL_OPENCODE_IMAGE ?? "ghcr.io/anomalyco/opencode:1.18.35",
      tags: { "agentbox.test": randomUUID() },
      workingDir: "/workspace",
      provider: { target: "cloud", network: true },
    });
    try {
      await sandbox.findOrProvision();
      // The official OpenCode image lacks AgentBox's setup prerequisites.
      const tools = await sandbox.run("apk add --no-cache bash curl python3 coreutils git", { timeoutMs: 60_000 });
      expect(tools.exitCode, tools.stderr).toBe(0);
      const agent = new Agent("open-code", { sandbox, cwd: "/workspace", approvalMode: "auto" });
      await agent.setup();
      const pid = await sandbox.run("cat /tmp/agentbox/open-code/opencode-serve.pid");
      expect(pid.stdout.trim()).toMatch(/^\d+$/);
      const url = await sandbox.getPreviewLink(4096);
      expect(new URL(url).hostname).toBe("127.0.0.1");
      expect((await fetch(`${url}/global/health`)).status).toBe(401);
      const token = await sandbox.run("cat /tmp/agentbox/open-code/opencode-auth-token");
      const authorization = `Basic ${Buffer.from(`opencode:${token.stdout.trim()}`).toString("base64")}`;
      expect((await fetch(`${url}/global/health`, { headers: { authorization } })).status).toBe(200);
      await agent.killServer();
      const stopped = await sandbox.run('curl -s -o /dev/null --max-time 2 http://127.0.0.1:4096/global/health');
      expect(stopped.exitCode).not.toBe(0);
      await agent.setup();
      expect((await fetch(`${url}/global/health`, { headers: { authorization } })).status).toBe(200);
    } finally {
      await sandbox.delete().catch(() => undefined);
    }
  }, 180_000);
});
