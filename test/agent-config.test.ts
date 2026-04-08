import { describe, expect, it } from "vitest";

import { Agent } from "../src";
import { buildOpenCodeCommandsConfig } from "../src/agents/config/commands";
import { buildClaudeHookSettings } from "../src/agents/config/hooks";
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
      hooks: [
        {
          event: "Stop",
          type: "command",
          command: "echo done",
        },
      ],
      commands: [
        {
          name: "review",
          template: "Review the current changes.",
        },
      ],
    });

    expect(agent).toBeInstanceOf(Agent);
  });

  it("accepts a shared approval mode on any provider", () => {
    const codexAgent = new Agent("codex", {
      cwd: "/workspace",
      approvalMode: "interactive",
    });
    const openCodeAgent = new Agent("opencode", {
      cwd: "/workspace",
      approvalMode: "auto",
    });

    expect(codexAgent).toBeInstanceOf(Agent);
    expect(openCodeAgent).toBeInstanceOf(Agent);
  });
});

describe("config compilers", () => {
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

  it("builds Claude hook settings", () => {
    expect(
      buildClaudeHookSettings([
        {
          event: "PostToolUse",
          matcher: "Bash|Edit",
          type: "command",
          command: "echo hook",
          statusMessage: "Running hook",
        },
      ]),
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
      },
    });
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
