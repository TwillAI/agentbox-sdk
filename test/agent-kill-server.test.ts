import { describe, expect, it } from "vitest";

import { Agent, AgentProvider, type Sandbox } from "../src";

/**
 * A sandbox stub that records every `run`/`uploadAndRun` so we can assert
 * exactly which server-management commands a provider issued.
 *
 * `healthExit` controls the exit code returned for `/global/health` probes
 * (default 1 = "nothing answering"); opencode's kill helper polls that
 * endpoint until it stops responding, so a non-zero default keeps the
 * helper from spinning under test.
 */
function makeRecordingSandbox(healthExit: (call: number) => number = () => 1): {
  sandbox: Sandbox;
  runCommands: string[];
  uploads: unknown[];
} {
  const runCommands: string[] = [];
  const uploads: unknown[] = [];
  let healthCalls = 0;
  const sandbox = {
    run: async (command: string) => {
      runCommands.push(command);
      // preflightSetup's marker check — non-zero means "drifted / cold".
      if (command.includes("setup.id")) {
        return { exitCode: 1, stdout: "", stderr: "", combinedOutput: "" };
      }
      if (command.includes("/global/health")) {
        return {
          exitCode: healthExit(healthCalls++),
          stdout: "",
          stderr: "",
          combinedOutput: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "", combinedOutput: "" };
    },
    uploadAndRun: async (files: unknown) => {
      uploads.push(files);
      return { exitCode: 0, stdout: "", stderr: "", combinedOutput: "" };
    },
    getPreviewLink: async () => "http://127.0.0.1:4096",
    previewHeaders: {} as Record<string, string>,
  } as unknown as Sandbox;
  return { sandbox, runCommands, uploads };
}

describe("never auto-kill the CLI servers", () => {
  it("opencode setup() reuses a healthy server on config drift instead of killing it", async () => {
    // Preflight misses (drift) but the health probe answers → a server is up.
    const { sandbox, runCommands, uploads } = makeRecordingSandbox(() => 0);
    const agent = new Agent(AgentProvider.OpenCode, {
      sandbox,
      cwd: "/tmp",
      approvalMode: "auto",
    });

    await agent.setup();

    // Reused the live server: no respawn, no kill, no artifact upload.
    expect(uploads).toHaveLength(0);
    expect(runCommands.some((c) => c.includes("serve"))).toBe(false);
    expect(runCommands.some((c) => c.includes("opencode-serve.pid"))).toBe(
      false,
    );
    expect(runCommands.some((c) => c.includes("kill"))).toBe(false);
    // It did, however, probe liveness to make the reuse decision.
    expect(runCommands.some((c) => c.includes("/global/health"))).toBe(true);
  });
});

describe("Agent.killServer() — explicit, developer-driven teardown", () => {
  it("opencode: stops the `opencode serve` daemon", async () => {
    const { sandbox, runCommands } = makeRecordingSandbox();
    const agent = new Agent(AgentProvider.OpenCode, {
      sandbox,
      cwd: "/tmp",
      approvalMode: "auto",
    });

    await agent.killServer();

    const killCmd = runCommands.find((c) => c.includes("opencode-serve.pid"));
    expect(killCmd).toBeDefined();
    expect(killCmd).toContain("kill");
  });

  it("codex: stops the shared app-server by pid + port", async () => {
    const { sandbox, runCommands } = makeRecordingSandbox();
    const agent = new Agent(AgentProvider.Codex, { sandbox, cwd: "/tmp" });

    await agent.killServer();

    const killCmd = runCommands.find((c) => c.includes("codex-app-server.pid"));
    expect(killCmd).toBeDefined();
    expect(killCmd).toContain("kill");
    expect(killCmd).toContain("43181");
  });

  it("claude-code: stops the relay daemon by pid + port", async () => {
    const { sandbox, runCommands } = makeRecordingSandbox();
    const agent = new Agent(AgentProvider.ClaudeCode, { sandbox, cwd: "/tmp" });

    await agent.killServer();

    const killCmd = runCommands.find((c) => c.includes("daemon.pid"));
    expect(killCmd).toBeDefined();
    expect(killCmd).toContain("kill");
    expect(killCmd).toContain("43180");
  });

  it("is a no-op (no throw) when no persistent server exists for the mode", async () => {
    // local codex spawns a fresh app-server per run; host-mode claude-code
    // runs the SDK in-process. Neither has a shared server to stop.
    await expect(
      new Agent(AgentProvider.Codex, { cwd: "/tmp" }).killServer(),
    ).resolves.toBeUndefined();
    await expect(
      new Agent(AgentProvider.ClaudeCode, { cwd: "/tmp" }).killServer(),
    ).resolves.toBeUndefined();
  });
});
