import { describe, expect, it } from "vitest";

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

  it("creates an agent without touching the runtime immediately", () => {
    const agent = new Agent("opencode", {
      cwd: "/workspace",
    });

    expect(agent).toBeInstanceOf(Agent);
  });

  it("accepts resumeSessionId in run config", () => {
    const runConfig: AgentRunConfig = {
      input: "Continue from the existing session.",
      model: "gpt-5.4",
      resumeSessionId: "session-123",
    };

    expect(runConfig.resumeSessionId).toBe("session-123");
  });
});
