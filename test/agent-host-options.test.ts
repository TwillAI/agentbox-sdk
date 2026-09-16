import { describe, expect, it } from "vitest";
import { Agent, AgentProvider, Sandbox } from "../src";
import { agentboxRoot } from "../src/agents/config/setup";
import { buildCodexSandboxMode, buildCodexTurnStartParams } from "../src/agents/providers/codex";
import type { AgentOptions } from "../src/agents/types";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("host execution configuration", () => {
  it("does not generate Codex or Claude configuration for native host sessions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agentbox-native-config-"));
    try {
      for (const provider of ["codex", "claude-code"] as const) {
        const agent = new Agent(provider, { configuration: "native", cwd: directory, stateDirectory: directory });
        await agent.setup();
      }
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("leaves native Codex sandbox and approval settings to the user's harness", () => {
    const options: AgentOptions<"codex"> = { cwd: "/work", configuration: "native", approvalMode: "interactive" };
    const params = buildCodexTurnStartParams({ threadId: "thread", inputItems: [], request: { runId: "run", provider: AgentProvider.Codex, options, run: { input: "pwd" } } });
    expect(buildCodexSandboxMode(options)).toBeUndefined();
    expect(params).not.toHaveProperty("sandboxPolicy");
    expect(params).not.toHaveProperty("approvalPolicy");
    expect(() => new Agent("codex", { configuration: "native", enableRtk: true })).toThrow(/harness's own/);
    expect(() => new Agent("codex", { configuration: "native", sandbox: new Sandbox("daytona", { provider: { apiKey: "test" } }) })).toThrow(/host execution/);
  });
  it("isolates persistent state by environment and provider", () => {
    expect(agentboxRoot("codex", false, "/work/first")).toBe("/work/first/codex");
    expect(agentboxRoot("codex", false, "/work/second")).toBe("/work/second/codex");
    expect(agentboxRoot("claude-code", false, "/work/first")).toBe("/work/first/claude-code");
    expect(agentboxRoot("codex", true)).toBe("/tmp/agentbox/codex");
  });
  it("rejects an invalid background task timeout before any transport is dialed", () => {
    expect(() => new Agent("claude-code", { cwd: "/work", backgroundTaskTimeoutMs: -1 })).toThrow(/non-negative/);
    expect(() => new Agent("claude-code", { cwd: "/work", backgroundTaskTimeoutMs: Number.NaN })).toThrow(/non-negative/);
  });
  it("rejects relative host directories and host settings on cloud agents", () => {
    expect(() => new Agent("codex", { stateDirectory: "relative" })).toThrow(/absolute/);
    expect(() => new Agent("codex", { sandbox: new Sandbox("daytona", { provider: { apiKey: "test" } }), stateDirectory: "/work" })).toThrow(/host execution/);
  });
  it("keeps native Codex read-only unless a caller explicitly enables writes", () => {
    expect(buildCodexSandboxMode({ cwd: "/work" })).toBe("read-only");
    expect(buildCodexSandboxMode({ cwd: "/work", provider: { sandboxMode: "workspace-write" } })).toBe("workspace-write");
  });
  it("carries explicit native write roots and network restrictions onto every turn", () => {
    const options: AgentOptions<"codex"> = { cwd: "/work/first", provider: { sandboxMode: "workspace-write", writableRoots: ["/work/first", "/work/second"] } };
    const params = buildCodexTurnStartParams({ threadId: "thread", inputItems: [], request: { runId: "run", provider: AgentProvider.Codex, options, run: { input: "edit" } } });
    expect(params.sandboxPolicy).toEqual({ type: "workspaceWrite", networkAccess: false, writableRoots: ["/work/first", "/work/second"] });
  });
});
