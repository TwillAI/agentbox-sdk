import { describe, expect, it } from "vitest";

import { Agent } from "../src";
import { buildOpenCodeCommandsConfig } from "../src/agents/config/commands";
import {
  assertHooksSupported,
  buildClaudeHookSettings,
  buildCodexHooksFile,
  buildOpenCodePluginArtifacts,
} from "../src/agents/config/hooks";
import { buildOpenCodeMcpConfig } from "../src/agents/config/mcp";
import { prepareSkillArtifacts } from "../src/agents/config/skills";
import {
  buildClaudeAgentsConfig,
  buildCodexSubagentArtifacts,
} from "../src/agents/config/subagents";

describe("agent options config", () => {
  it("constructs an agent with shared runtime option fields", () => {
    const agent = new Agent("claude-code", {
      cwd: "/workspace",
      approvalMode: "interactive",
      mcps: [
        {
          name: "context7",
          type: "remote",
          url: "https://mcp.context7.com/mcp",
          bearerTokenEnvVar: "CONTEXT7_API_KEY",
        },
      ],
      skills: [{ name: "frontend-design" }],
      subAgents: [
        {
          name: "reviewer",
          description: "Review code for bugs",
          instructions: "Review the current changes for likely bugs.",
        },
      ],
      commands: [
        {
          name: "review",
          template: "Review the current changes.",
        },
      ],
      provider: {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "echo done",
                },
              ],
            },
          ],
        },
      },
    });

    expect(agent).toBeInstanceOf(Agent);
  });

  it("accepts a shared approval mode on any provider", () => {
    const codexAgent = new Agent("codex", {
      cwd: "/workspace",
      approvalMode: "interactive",
      provider: {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "echo done",
                },
              ],
            },
          ],
        },
      },
    });
    const openCodeAgent = new Agent("opencode", {
      cwd: "/workspace",
      approvalMode: "auto",
      provider: {
        plugins: [
          {
            name: "notify-on-idle",
            hooks: [
              {
                event: "session.idle",
                body: 'return "idle";',
              },
            ],
          },
        ],
      },
    });

    expect(codexAgent).toBeInstanceOf(Agent);
    expect(openCodeAgent).toBeInstanceOf(Agent);
  });
});

describe("config compilers", () => {
  it("rejects legacy shared hooks for Claude Code", () => {
    expect(() =>
      assertHooksSupported("claude-code", {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "echo done",
                },
              ],
            },
          ],
        },
      }),
    ).toThrow(
      "Claude Code hooks must be configured on options.provider.hooks.",
    );
  });

  it("rejects options.provider.hooks on OpenCode", () => {
    expect(() =>
      assertHooksSupported("opencode", {
        provider: {
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "echo done",
                  },
                ],
              },
            ],
          },
        },
      }),
    ).toThrow("OpenCode uses options.provider.plugins");
  });

  it("rejects options.provider.plugins on Codex", () => {
    expect(() =>
      assertHooksSupported("codex", {
        provider: {
          plugins: [
            {
              name: "notify-on-idle",
              hooks: [
                {
                  event: "session.idle",
                  body: 'return "idle";',
                },
              ],
            },
          ],
        },
      }),
    ).toThrow("OpenCode plugins are only supported for the opencode provider");
  });

  it("rejects malformed grouped hook entries", () => {
    expect(() =>
      assertHooksSupported("claude-code", {
        provider: {
          hooks: {
            PostToolUse: {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "echo done",
                },
              ],
            },
          },
        },
      }),
    ).toThrow("each event mapped to an array of matcher groups");

    expect(() =>
      assertHooksSupported("codex", {
        provider: {
          hooks: {
            PostToolUse: {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "echo done",
                },
              ],
            },
          },
        },
      }),
    ).toThrow("each event mapped to an array of matcher groups");
  });

  it("builds repo-backed and embedded skill setup", async () => {
    const layout = {
      rootDir: "/tmp/openagent",
      homeDir: "/tmp/openagent/home",
      xdgConfigHome: "/tmp/openagent/home/.config",
      agentsDir: "/tmp/openagent/home/.agents",
      claudeDir: "/tmp/openagent/home/.claude",
      opencodeDir: "/tmp/openagent/home/.config/opencode",
      codexDir: "/tmp/openagent/home/.codex",
    };

    const repoSkill = await prepareSkillArtifacts(
      "opencode",
      [
        {
          name: "agent-browser",
          repo: "https://github.com/vercel-labs/agent-browser",
        },
      ],
      layout,
    );

    expect(repoSkill.installCommands).toEqual([
      "npx skills add https://github.com/vercel-labs/agent-browser -g --skill agent-browser --agent opencode -y",
    ]);

    const embeddedSkill = await prepareSkillArtifacts(
      "opencode",
      [
        {
          source: "embedded",
          name: "release-helper",
          files: {
            "SKILL.md": "# Release helper",
          },
        },
      ],
      layout,
    );

    expect(embeddedSkill.installCommands).toEqual([]);
    expect(embeddedSkill.artifacts).toEqual([
      {
        path: "/tmp/openagent/home/.config/opencode/skills/release-helper/SKILL.md",
        content: "# Release helper",
        executable: false,
      },
    ]);
  });

  it("builds OpenCode command config", () => {
    expect(
      buildOpenCodeCommandsConfig([
        {
          name: "review",
          description: "Review the current changes",
          template: "Review the current worktree for bugs.",
          model: "gpt-4.1",
        },
      ]),
    ).toMatchObject({
      review: {
        description: "Review the current changes",
        template: "Review the current worktree for bugs.",
        model: "gpt-4.1",
      },
    });
  });

  it("builds Claude sub-agent config", () => {
    expect(
      buildClaudeAgentsConfig([
        {
          name: "reviewer",
          description: "Review code",
          instructions: "Review the diff for likely bugs.",
          tools: ["bash", "read"],
          model: "claude-opus-4-1",
        },
      ]),
    ).toMatchObject({
      reviewer: {
        description: "Review code",
        prompt: "Review the diff for likely bugs.",
        tools: ["bash", "read"],
        model: "claude-opus-4-1",
      },
    });
  });

  it("returns undefined when Claude hooks are empty", () => {
    expect(buildClaudeHookSettings(undefined)).toBeUndefined();
  });

  it("builds native Claude hook settings", () => {
    expect(
      buildClaudeHookSettings({
        PostToolUse: [
          {
            matcher: "Bash|Edit",
            hooks: [
              {
                type: "command",
                command: "echo hook",
                statusMessage: "Running hook",
              },
            ],
          },
        ],
        Notification: [
          {
            hooks: [
              {
                type: "http",
                url: "http://localhost:8080/hooks",
                allowedEnvVars: ["HOOK_TOKEN"],
                headers: {
                  Authorization: "Bearer $HOOK_TOKEN",
                },
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash|Edit",
            hooks: [
              {
                type: "command",
                command: "echo hook",
                statusMessage: "Running hook",
              },
            ],
          },
        ],
        Notification: [
          {
            hooks: [
              {
                type: "http",
                url: "http://localhost:8080/hooks",
                allowedEnvVars: ["HOOK_TOKEN"],
                headers: {
                  Authorization: "Bearer $HOOK_TOKEN",
                },
              },
            ],
          },
        ],
      },
    });
  });

  it("builds native Codex hooks files", () => {
    expect(
      buildCodexHooksFile({
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "echo hook",
                statusMessage: "Reviewing command output",
                timeout: 30,
              },
            ],
          },
        ],
      }),
    ).toMatchObject({
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "echo hook",
                statusMessage: "Reviewing command output",
                timeout: 30,
              },
            ],
          },
        ],
      },
    });
  });

  it("builds OpenCode plugin artifacts", () => {
    expect(
      buildOpenCodePluginArtifacts(
        [
          {
            name: "session notifier",
            preamble: 'const prefix = "notify";',
            setup: "const initialized = true;",
            hooks: [
              {
                event: "session.idle",
                body: 'if (initialized) { return `${prefix}:${input.sessionID ?? "unknown"}`; }',
              },
            ],
          },
        ],
        "/tmp/openagent/home/.config/opencode",
      ),
    ).toEqual([
      expect.objectContaining({
        path: "/tmp/openagent/home/.config/opencode/plugins/session-notifier.ts",
        content: expect.stringContaining(
          '"session.idle": async (input, output) => {',
        ),
      }),
    ]);
  });

  it("builds OpenCode MCP config", () => {
    expect(
      buildOpenCodeMcpConfig([
        {
          name: "context7",
          type: "remote",
          url: "https://mcp.context7.com/mcp",
          bearerTokenEnvVar: "CONTEXT7_API_KEY",
        },
      ]),
    ).toMatchObject({
      context7: {
        type: "remote",
        url: "https://mcp.context7.com/mcp",
        enabled: true,
        headers: {
          Authorization: "Bearer {env:CONTEXT7_API_KEY}",
        },
      },
    });
  });

  it("builds Codex sub-agent artifacts", () => {
    const result = buildCodexSubagentArtifacts(
      [
        {
          name: "reviewer",
          description: "Review code",
          instructions: "Review the current worktree for likely regressions.",
        },
      ],
      {
        rootDir: "/tmp/openagent",
        homeDir: "/tmp/openagent/home",
        xdgConfigHome: "/tmp/openagent/home/.config",
        agentsDir: "/tmp/openagent/home/.agents",
        claudeDir: "/tmp/openagent/home/.claude",
        opencodeDir: "/tmp/openagent/home/.config/opencode",
        codexDir: "/tmp/openagent/home/.codex",
      },
    );

    expect(result.enableMultiAgent).toBe(true);
    expect(result.agentSections.join("\n")).toContain("[agents.reviewer]");
    expect(result.artifacts.map((artifact) => artifact.path)).toEqual(
      expect.arrayContaining([
        "/tmp/openagent/home/.codex/prompts/reviewer.md",
        "/tmp/openagent/home/.codex/agents/reviewer.toml",
      ]),
    );
  });
});
