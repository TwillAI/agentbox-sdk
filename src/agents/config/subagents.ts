import path from "node:path";

import type { AgentSubAgentConfig, RuntimeLayout, TextArtifact } from "./types";

function toToolsArray(tools?: string[]): string[] | undefined {
  const filtered = tools?.map((tool) => tool.trim()).filter(Boolean);
  return filtered && filtered.length > 0 ? filtered : undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildClaudeAgentsConfig(
  subAgents: AgentSubAgentConfig[] | undefined,
): Record<string, unknown> | undefined {
  if (!subAgents || subAgents.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    subAgents.map((subAgent) => [
      subAgent.name,
      {
        description: subAgent.description,
        prompt: subAgent.instructions,
        ...(subAgent.model ? { model: subAgent.model } : {}),
        ...(toToolsArray(subAgent.tools)
          ? { tools: toToolsArray(subAgent.tools) }
          : {}),
      },
    ]),
  );
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
): Record<string, unknown> {
  return Object.fromEntries(
    (subAgents ?? []).map((subAgent) => [
      subAgent.name,
      {
        mode: "subagent",
        description: subAgent.description,
        prompt: subAgent.instructions,
        ...(mapOpenCodeTools(subAgent.tools)
          ? { tools: mapOpenCodeTools(subAgent.tools) }
          : {}),
      },
    ]),
  );
}

export function buildCodexSubagentArtifacts(
  subAgents: AgentSubAgentConfig[] | undefined,
  layout: RuntimeLayout,
): {
  artifacts: TextArtifact[];
  agentSections: string[];
  enableMultiAgent: boolean;
} {
  const artifacts: TextArtifact[] = [];
  const agentSections: string[] = [];

  for (const subAgent of subAgents ?? []) {
    if (subAgent.model) {
      throw new Error(
        `Codex sub-agent "${subAgent.name}" specifies a model override, which is not supported in this package yet.`,
      );
    }

    const roleConfigRelativePath = `./agents/${subAgent.name}.toml`;
    const roleConfigPromptPath = `../prompts/${subAgent.name}.md`;

    artifacts.push({
      path: path.join(layout.codexDir, "prompts", `${subAgent.name}.md`),
      content: subAgent.instructions,
    });
    artifacts.push({
      path: path.join(layout.codexDir, "agents", `${subAgent.name}.toml`),
      content: [
        `model_instructions_file = ${tomlString(roleConfigPromptPath)}`,
        `model_reasoning_effort = ${tomlString("medium")}`,
        "",
        "[features]",
        "multi_agent = false",
        "",
      ].join("\n"),
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
