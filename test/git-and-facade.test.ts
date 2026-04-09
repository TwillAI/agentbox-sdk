import { describe, expect, it, vi } from "vitest";

import {
  Agent,
  buildGitCloneCommand,
  Sandbox,
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
    const sandbox = new Sandbox("modal", {
      tags: { project: "demo" },
      image: "im-demo-image",
      resources: {
        cpu: 1,
        memoryMiB: 2048,
      },
      provider: { appName: "openagent-demo" },
    });

    expect(sandbox.provider).toBe("modal");
    expect(sandbox.optionsSnapshot.image).toBe("im-demo-image");
    expect(sandbox.optionsSnapshot.resources?.memoryMiB).toBe(2048);
    expect(sandbox.optionsSnapshot.provider?.appName).toBe("openagent-demo");
  });

  it("creates an e2b sandbox with a template reference", async () => {
    const sandbox = new Sandbox("e2b", {
      tags: { project: "demo" },
      image: "openagent-browser-agent:demo123",
      provider: {
        apiKey: "e2b_test",
        timeoutMs: 60_000,
      },
    });

    await expect(sandbox.openPort(4242)).resolves.toBe(sandbox);
    expect(sandbox.provider).toBe("e2b");
    expect(sandbox.optionsSnapshot.image).toBe(
      "openagent-browser-agent:demo123",
    );
    expect(sandbox.optionsSnapshot.provider?.timeoutMs).toBe(60_000);
  });

  it("creates an agent without touching the runtime immediately", () => {
    const agent = new Agent("opencode", {
      cwd: "/workspace",
    });

    expect(agent).toBeInstanceOf(Agent);
  });

  it("opens a local-docker port", async () => {
    const sandbox = new Sandbox("local-docker", {
      image: "openagent-e2e",
    });

    await sandbox.openPort(4096);

    expect(sandbox.optionsSnapshot.provider?.publishedPorts).toEqual([4096]);
  });

  it("opens a modal port", async () => {
    const sandbox = new Sandbox("modal", {
      image: "im-demo-image",
    });

    await sandbox.openPort(4242);

    expect(sandbox.optionsSnapshot.provider?.unencryptedPorts).toEqual([4242]);
  });

  it("opens the OpenCode sandbox port automatically at runtime", async () => {
    const openPort = vi.fn(async () => undefined);
    const fakeSandbox = {
      openPort,
      run: vi.fn(async () => {
        throw new Error("stop after opening port");
      }),
    } as unknown as Sandbox<"local-docker">;

    const agent = new Agent("opencode", {
      sandbox: fakeSandbox,
      cwd: "/workspace",
    });

    await expect(agent.run({ input: "hello" })).rejects.toThrow(
      "stop after opening port",
    );
    expect(openPort).toHaveBeenCalledWith(4096);
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
