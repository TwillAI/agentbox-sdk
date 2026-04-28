import { describe, expect, it, vi } from "vitest";

import {
  Agent,
  AgentProvider,
  buildGitCloneCommand,
  Sandbox,
  SandboxProvider,
  type AgentRunConfig,
} from "../src";

describe("git helpers", () => {
  it("builds a git clone command with auth and branch settings", () => {
    const command = buildGitCloneCommand({
      repoUrl: "https://github.com/acme/demo.git",
      branch: "main",
      depth: 1,
      targetDir: "/workspace/demo",
      token: "secret-token",
    });

    expect(command).toContain("git");
    expect(command).toContain("clone");
    expect(command).toContain("https://github.com/acme/demo.git");
    expect(command).toContain("--branch");
    expect(command).toContain("Authorization: Bearer secret-token");
  });
});

describe("public facades", () => {
  it("creates a sandbox with a string image reference", () => {
    const sandbox = new Sandbox(SandboxProvider.Modal, {
      tags: { project: "demo" },
      image: "im-demo-image",
      resources: {
        cpu: 1,
        memoryMiB: 2048,
      },
      provider: { appName: "agentbox-demo" },
    });

    expect(sandbox.provider).toBe(SandboxProvider.Modal);
    expect(sandbox.optionsSnapshot.image).toBe("im-demo-image");
    expect(sandbox.optionsSnapshot.resources?.memoryMiB).toBe(2048);
    expect(sandbox.optionsSnapshot.provider?.appName).toBe("agentbox-demo");
  });

  it("creates an e2b sandbox with a template reference", async () => {
    const sandbox = new Sandbox(SandboxProvider.E2B, {
      tags: { project: "demo" },
      image: "agentbox-browser-agent:demo123",
      provider: {
        apiKey: "e2b_test",
        timeoutMs: 60_000,
      },
    });

    await expect(sandbox.openPort(4242)).resolves.toBe(sandbox);
    expect(sandbox.provider).toBe(SandboxProvider.E2B);
    expect(sandbox.optionsSnapshot.image).toBe(
      "agentbox-browser-agent:demo123",
    );
    expect(sandbox.optionsSnapshot.provider?.timeoutMs).toBe(60_000);
  });

  it("creates an agent without touching the runtime immediately", () => {
    const agent = new Agent(AgentProvider.OpenCode, {
      cwd: "/workspace",
    });

    expect(agent).toBeInstanceOf(Agent);
  });

  it("opens a local-docker port", async () => {
    const sandbox = new Sandbox(SandboxProvider.LocalDocker, {
      image: "agentbox-e2e",
    });

    await sandbox.openPort(4096);

    expect(sandbox.optionsSnapshot.provider?.publishedPorts).toEqual([4096]);
  });

  it("opens a modal port", async () => {
    const sandbox = new Sandbox(SandboxProvider.Modal, {
      image: "im-demo-image",
    });

    await sandbox.openPort(4242);

    expect(sandbox.optionsSnapshot.provider?.unencryptedPorts).toEqual([4242]);
  });

  it("does not auto-open agent harness ports — callers pre-declare them at create time", async () => {
    const openPort = vi.fn(async () => undefined);
    const fakeSandbox = {
      openPort,
      run: vi.fn(async () => {
        throw new Error("stop on first run");
      }),
    } as unknown as Sandbox<"local-docker">;

    const agent = new Agent(AgentProvider.OpenCode, {
      sandbox: fakeSandbox,
      cwd: "/workspace",
    });

    await expect(agent.run({ input: "hello" })).rejects.toThrow(
      "stop on first run",
    );
    // Auto-open was removed: the agent must not poke openPort behind the
    // caller's back. Reserved ports are declared via
    // `provider.unencryptedPorts` / `provider.ports` at create time.
    expect(openPort).not.toHaveBeenCalled();
  });

  it("accepts resumeSessionId in run config", () => {
    const runConfig: AgentRunConfig = {
      input: "Continue from the existing session.",
      model: "gpt-5.4",
      resumeSessionId: "session-123",
    };

    expect(runConfig.resumeSessionId).toBe("session-123");
  });

  it("accepts multipart input in run config", () => {
    const runConfig: AgentRunConfig = {
      input: [
        { type: "text", text: "Review the attached mockup." },
        {
          type: "image",
          image: new URL("https://example.com/mockup.png"),
        },
      ],
    };

    expect(Array.isArray(runConfig.input)).toBe(true);
  });
});
