import { describe, expect, it } from "vitest";

import { Agent, AgentProvider } from "../src";
import { buildOpenCodeCommandsConfig } from "../src/agents/config/commands";
import {
  assertHooksSupported,
  buildClaudeHookSettings,
  buildCodexHooksFile,
  buildOpenCodePluginArtifacts,
} from "../src/agents/config/hooks";
import {
  buildCodexConfigToml,
  buildOpenCodeMcpConfig,
} from "../src/agents/config/mcp";
import { prepareSkillArtifacts } from "../src/agents/config/skills";
import {
  buildClaudeSubagentArtifacts,
  buildCodexSubagentArtifacts,
} from "../src/agents/config/subagents";
import { resolveCodexModelProviders } from "../src/agents/providers/codex";
import type { SetupLayout } from "../src/agents/config/types";

describe("agent options config", () => {
  it("constructs an agent with shared runtime option fields", () => {
    const agent = new Agent(AgentProvider.ClaudeCode, {
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
    const codexAgent = new Agent(AgentProvider.Codex, {
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
    const openCodeAgent = new Agent(AgentProvider.OpenCode, {
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
      assertHooksSupported("open-code", {
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
      rootDir: "/tmp/agentbox",
      homeDir: "/tmp/agentbox/home",
      xdgConfigHome: "/tmp/agentbox/.config",
      agentsDir: "/tmp/agentbox/home/.agents",
      claudeDir: "/tmp/agentbox/home/.claude",
      opencodeDir: "/tmp/agentbox/.config/opencode",
      codexDir: "/tmp/agentbox/.codex",
    };

    const repoSkill = await prepareSkillArtifacts(
      "open-code",
      [
        {
          name: "agent-browser",
          repo: "https://github.com/vercel-labs/agent-browser",
        },
      ],
      layout,
    );

    expect(repoSkill.installCommands).toEqual([
      "npx skills add 'https://github.com/vercel-labs/agent-browser' -g --skill 'agent-browser' --agent 'opencode' -y",
    ]);

    const embeddedSkill = await prepareSkillArtifacts(
      "open-code",
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
        path: "/tmp/agentbox/.config/opencode/skills/release-helper/SKILL.md",
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

  it("writes Claude sub-agents as ~/.claude/agents/<name>.md files", () => {
    const layout: SetupLayout = {
      rootDir: "/tmp/agentbox",
      homeDir: "/tmp/agentbox/home",
      xdgConfigHome: "/tmp/agentbox/.config",
      agentsDir: "/tmp/agentbox/home/.agents",
      claudeDir: "/tmp/agentbox/home/.claude",
      opencodeDir: "/tmp/agentbox/.config/opencode",
      codexDir: "/tmp/agentbox/.codex",
    };

    const artifacts = buildClaudeSubagentArtifacts(
      [
        {
          name: "reviewer",
          description: "Review code",
          instructions: "Review the diff for likely bugs.",
          tools: ["bash", "read"],
          model: "opus",
        },
      ],
      layout,
    );

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.path).toBe(
      "/tmp/agentbox/home/.claude/agents/reviewer.md",
    );
    const content = artifacts[0]?.content ?? "";
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("name: 'reviewer'");
    expect(content).toContain("description: 'Review code'");
    expect(content).toContain("model: 'opus'");
    expect(content).toContain("tools: bash, read");
    expect(content).toContain("Review the diff for likely bugs.");
  });

  it("emits no Claude sub-agent artifacts when none configured", () => {
    const layout: SetupLayout = {
      rootDir: "/tmp/agentbox",
      homeDir: "/tmp/agentbox/home",
      xdgConfigHome: "/tmp/agentbox/.config",
      agentsDir: "/tmp/agentbox/home/.agents",
      claudeDir: "/tmp/agentbox/home/.claude",
      opencodeDir: "/tmp/agentbox/.config/opencode",
      codexDir: "/tmp/agentbox/.codex",
    };
    expect(buildClaudeSubagentArtifacts(undefined, layout)).toEqual([]);
    expect(buildClaudeSubagentArtifacts([], layout)).toEqual([]);
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
        "/tmp/agentbox/home/.config/opencode",
      ),
    ).toEqual([
      expect.objectContaining({
        path: "/tmp/agentbox/home/.config/opencode/plugins/session-notifier.ts",
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
        rootDir: "/tmp/agentbox",
        homeDir: "/tmp/agentbox/home",
        xdgConfigHome: "/tmp/agentbox/.config",
        agentsDir: "/tmp/agentbox/home/.agents",
        claudeDir: "/tmp/agentbox/home/.claude",
        opencodeDir: "/tmp/agentbox/.config/opencode",
        codexDir: "/tmp/agentbox/.codex",
      },
    );

    expect(result.enableMultiAgent).toBe(true);
    expect(result.agentSections.join("\n")).toContain("[agents.reviewer]");
    expect(result.artifacts.map((artifact) => artifact.path)).toEqual(
      expect.arrayContaining([
        "/tmp/agentbox/.codex/prompts/reviewer.md",
        "/tmp/agentbox/.codex/agents/reviewer.toml",
      ]),
    );
  });

  it("honors a per-sub-agent model override for Codex", () => {
    const result = buildCodexSubagentArtifacts(
      [
        {
          name: "code-reviewer-agent",
          description: "Review code",
          instructions: "Review the current worktree for likely regressions.",
          model: "gpt-5.4",
        },
      ],
      {
        rootDir: "/tmp/agentbox",
        homeDir: "/tmp/agentbox/home",
        xdgConfigHome: "/tmp/agentbox/.config",
        agentsDir: "/tmp/agentbox/home/.agents",
        claudeDir: "/tmp/agentbox/home/.claude",
        opencodeDir: "/tmp/agentbox/.config/opencode",
        codexDir: "/tmp/agentbox/.codex",
      },
    );

    const agentToml = result.artifacts.find((artifact) =>
      artifact.path.endsWith("agents/code-reviewer-agent.toml"),
    );

    expect(agentToml?.content).toContain('model = "gpt-5.4"');
    expect(agentToml?.content).toContain(
      'model_instructions_file = "../prompts/code-reviewer-agent.md"',
    );
  });

  it("omits the model key when no Codex sub-agent override is provided", () => {
    const result = buildCodexSubagentArtifacts(
      [
        {
          name: "reviewer",
          description: "Review code",
          instructions: "Review the current worktree for likely regressions.",
        },
      ],
      {
        rootDir: "/tmp/agentbox",
        homeDir: "/tmp/agentbox/home",
        xdgConfigHome: "/tmp/agentbox/.config",
        agentsDir: "/tmp/agentbox/home/.agents",
        claudeDir: "/tmp/agentbox/home/.claude",
        opencodeDir: "/tmp/agentbox/.config/opencode",
        codexDir: "/tmp/agentbox/.codex",
      },
    );

    const agentToml = result.artifacts.find((artifact) =>
      artifact.path.endsWith("agents/reviewer.toml"),
    );

    expect(agentToml?.content).not.toMatch(/^model\s*=/m);
  });
});

describe("codex model providers config", () => {
  it("emits a [model_providers.<id>] block with snake_case keys", () => {
    const toml = buildCodexConfigToml({
      modelProvider: "openrouter",
      modelProviders: {
        openrouter: {
          name: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
          envKey: "OPENROUTER_API_KEY",
          wireApi: "responses",
        },
      },
    });

    expect(toml).toContain('model_provider = "openrouter"');
    expect(toml).toContain("[model_providers.openrouter]");
    expect(toml).toContain('name = "OpenRouter"');
    expect(toml).toContain('base_url = "https://openrouter.ai/api/v1"');
    expect(toml).toContain('env_key = "OPENROUTER_API_KEY"');
    expect(toml).toContain('wire_api = "responses"');
  });

  it("writes model_provider before the provider table so TOML parses it as a top-level key", () => {
    const toml = buildCodexConfigToml({
      modelProvider: "openrouter",
      modelProviders: {
        openrouter: { name: "OpenRouter", envKey: "OPENROUTER_API_KEY" },
      },
    })!;

    const providerSelect = toml.indexOf("model_provider =");
    const providerTable = toml.indexOf("[model_providers.openrouter]");
    expect(providerSelect).toBeGreaterThanOrEqual(0);
    expect(providerTable).toBeGreaterThanOrEqual(0);
    expect(providerSelect).toBeLessThan(providerTable);
  });

  it("serializes headers and params as inline tables with quoted keys", () => {
    const toml = buildCodexConfigToml({
      modelProviders: {
        proxy: {
          name: "Proxy",
          baseUrl: "https://proxy.example.com/v1",
          envKey: "PROXY_API_KEY",
          wireApi: "responses",
          queryParams: { "api-version": "2025-04-01-preview" },
          httpHeaders: { "X-Title": "AgentBox" },
          requestMaxRetries: 4,
          streamIdleTimeoutMs: 300000,
        },
      },
    });

    expect(toml).toContain(
      'query_params = { "api-version" = "2025-04-01-preview" }',
    );
    expect(toml).toContain('http_headers = { "X-Title" = "AgentBox" }');
    expect(toml).toContain("request_max_retries = 4");
    expect(toml).toContain("stream_idle_timeout_ms = 300000");
  });

  it("falls back the provider display name to its id", () => {
    const toml = buildCodexConfigToml({
      modelProviders: { vllm: { baseUrl: "http://localhost:8000/v1" } },
    });

    expect(toml).toContain("[model_providers.vllm]");
    expect(toml).toContain('name = "vllm"');
  });

  it("synthesizes a non-reserved provider id for custom headers on OpenAI (codex rejects [model_providers.openai])", () => {
    // Repro: a codex run on an OpenAI model with per-task custom headers
    // (e.g. x-litellm-tags) and no explicit provider. Codex reserves the
    // built-in `openai` id and refuses any [model_providers.openai] override,
    // so we must register the synthesized block under a distinct id.
    const opts = {
      env: { OPENAI_API_KEY: "sk-test" },
      customHeaders: { "x-litellm-tags": "task:abc" },
    } as unknown as Parameters<typeof resolveCodexModelProviders>[0];

    const { modelProviders, modelProvider } = resolveCodexModelProviders(opts);

    expect(modelProviders.openai).toBeUndefined();
    expect(modelProvider).toBe("openai-custom");
    expect(modelProviders["openai-custom"]).toMatchObject({
      envKey: "OPENAI_API_KEY",
      wireApi: "responses",
      httpHeaders: { "x-litellm-tags": "task:abc" },
    });

    const toml = buildCodexConfigToml({ modelProvider, modelProviders })!;
    expect(toml).toContain('model_provider = "openai-custom"');
    expect(toml).toContain("[model_providers.openai-custom]");
    expect(toml).not.toContain("[model_providers.openai]");
  });

  it("rejects unsafe provider ids", () => {
    expect(() =>
      buildCodexConfigToml({
        modelProviders: { "bad id": { baseUrl: "http://x" } },
      }),
    ).toThrow(/Model provider/);
  });

  it("returns undefined when no providers or other config are set", () => {
    expect(buildCodexConfigToml({})).toBeUndefined();
  });
});
