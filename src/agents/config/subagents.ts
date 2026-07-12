import path from "node:path";

import type { AgentSubAgentConfig, SetupLayout, TextArtifact } from "./types";

function toToolsArray(tools?: string[]): string[] | undefined {
  const filtered = tools?.map((tool) => tool.trim()).filter(Boolean);
  return filtered && filtered.length > 0 ? filtered : undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * YAML-frontmatter scalar escaper. Sub-agent descriptions / names are
 * arbitrary user input so we have to handle quotes, newlines, and
 * leading/trailing whitespace. Single-quoted YAML is the simplest safe
 * form: only `'` itself needs escaping (doubled), nothing else gets
 * special treatment.
 */
function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Write `~/.claude/agents/<name>.md` files (Markdown + YAML frontmatter)
 * — Claude Code's native sub-agent format. With `CLAUDE_CONFIG_DIR`
 * pointed at our layout's claudeDir, the CLI auto-discovers these on
 * startup. There is no wire-protocol fallback: sub-agents go through
 * the filesystem only, written once by `setup()` and never re-read by
 * `execute()`.
 */
export function buildClaudeSubagentArtifacts(
  subAgents: AgentSubAgentConfig[] | undefined,
  layout: SetupLayout,
): TextArtifact[] {
  if (!subAgents || subAgents.length === 0) {
    return [];
  }

  return subAgents.map((subAgent) => {
    const tools = toToolsArray(subAgent.tools);
    const frontmatterLines = [
      `name: ${yamlScalar(subAgent.name)}`,
      `description: ${yamlScalar(subAgent.description)}`,
      ...(subAgent.model ? [`model: ${yamlScalar(subAgent.model)}`] : []),
      ...(tools ? [`tools: ${tools.join(", ")}`] : []),
    ];
    const content = `---\n${frontmatterLines.join("\n")}\n---\n\n${subAgent.instructions.trim()}\n`;
    return {
      path: path.join(layout.claudeDir, "agents", `${subAgent.name}.md`),
      content,
    };
  });
}

function mapOpenCodeTools(
  tools?: string[],
): Record<string, boolean> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return Object.fromEntries(tools.map((tool) => [tool, true]));
}

export function buildOpenCodeSubagentConfig(
  subAgents: AgentSubAgentConfig[] | undefined,
  /**
   * Per-agent permission block, normally the same one the primary agent
   * gets. Since opencode 1.17.2 sub-agents use their own configured
   * permissions instead of inheriting the parent's; an entry without a
   * `permission` block falls back to opencode's defaults (e.g.
   * `external_directory: "ask"`), and a sub-agent's ask raised from its
   * child session blocks the run.
   */
  permission?: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    (subAgents ?? []).map((subAgent) => [
      subAgent.name,
      {
        mode: "subagent",
        description: subAgent.description,
        prompt: subAgent.instructions,
        ...(permission ? { permission } : {}),
        // opencode reads a per-agent `model` as a "<providerID>/<modelID>"
        // string (e.g. "openrouter/deepseek/deepseek-v4-flash"). Without it,
        // the sub-agent silently inherits the orchestrator's model instead of
        // the one it was configured with — unlike claude-code (frontmatter
        // `model`) and codex (TOML `model`), which both carry it through.
        ...(subAgent.model ? { model: subAgent.model } : {}),
        ...(mapOpenCodeTools(subAgent.tools)
          ? { tools: mapOpenCodeTools(subAgent.tools) }
          : {}),
      },
    ]),
  );
}

export function buildCodexSubagentArtifacts(
  subAgents: AgentSubAgentConfig[] | undefined,
  layout: SetupLayout,
  /**
   * Fallback model slug for sub-agents that don't set their own. Codex
   * reloads a named sub-agent's config from disk and loses the parent's
   * runtime model, so a role TOML with no `model` resolves to `None` and
   * `spawn_agent` fails service-tier validation. Writing this default keeps
   * role spawns working. Sourced from `CodexProviderOptions.defaultModel`.
   */
  defaultModel?: string,
): {
  artifacts: TextArtifact[];
  agentSections: string[];
  enableMultiAgent: boolean;
} {
  const artifacts: TextArtifact[] = [];
  const agentSections: string[] = [];

  for (const subAgent of subAgents ?? []) {
    const roleConfigRelativePath = `./agents/${subAgent.name}.toml`;
    const roleConfigPromptPath = `../prompts/${subAgent.name}.md`;

    artifacts.push({
      path: path.join(layout.codexDir, "prompts", `${subAgent.name}.md`),
      content: subAgent.instructions,
    });

    const tomlLines: string[] = [
      `model_instructions_file = ${tomlString(roleConfigPromptPath)}`,
    ];
    const model = subAgent.model ?? defaultModel;
    if (model) {
      tomlLines.push(`model = ${tomlString(model)}`);
    }
    tomlLines.push(
      `model_reasoning_effort = ${tomlString("medium")}`,
      "",
      "[features]",
      "multi_agent = false",
      "",
    );

    artifacts.push({
      path: path.join(layout.codexDir, "agents", `${subAgent.name}.toml`),
      content: tomlLines.join("\n"),
    });

    agentSections.push(
      `[agents.${subAgent.name}]`,
      `description = ${tomlString(subAgent.description)}`,
      `config_file = ${tomlString(roleConfigRelativePath)}`,
      "",
    );
  }

  return {
    artifacts,
    agentSections,
    enableMultiAgent: (subAgents?.length ?? 0) > 0,
  };
}

export function buildSubagentSystemAppendix(
  subAgents: AgentSubAgentConfig[] | undefined,
): string | undefined {
  if (!subAgents || subAgents.length === 0) {
    return undefined;
  }

  return [
    "Configured sub-agents are available in this environment.",
    ...subAgents.map(
      (subAgent) => `- ${subAgent.name}: ${subAgent.description}`,
    ),
  ].join("\n");
}
