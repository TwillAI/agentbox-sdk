import path from "node:path";

import { AgentProvider } from "../types";
import type { AgentCommandConfig, RuntimeLayout, TextArtifact } from "./types";

function buildFrontmatter(
  values: Record<string, string | boolean | undefined>,
): string {
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);

  return lines.length > 0 ? `---\n${lines.join("\n")}\n---\n\n` : "";
}

export function buildClaudeCommandArtifacts(
  commands: AgentCommandConfig[] | undefined,
  layout: RuntimeLayout,
): TextArtifact[] {
  return (commands ?? []).map((command) => ({
    path: path.join(layout.claudeDir, "commands", `${command.name}.md`),
    content:
      buildFrontmatter({
        description: command.description,
      }) + command.template,
  }));
}

export function buildOpenCodeCommandsConfig(
  commands: AgentCommandConfig[] | undefined,
): Record<string, unknown> | undefined {
  if (!commands || commands.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    commands.map((command) => [
      command.name,
      {
        template: command.template,
        ...(command.description ? { description: command.description } : {}),
        ...(command.agent ? { agent: command.agent } : {}),
        ...(command.model ? { model: command.model } : {}),
        ...(command.subtask !== undefined ? { subtask: command.subtask } : {}),
      },
    ]),
  );
}

export function assertCommandsSupported(
  provider: "claude-code" | "opencode" | "codex",
  commands: AgentCommandConfig[] | undefined,
): void {
  if (!commands || commands.length === 0) {
    return;
  }

  if (provider === AgentProvider.Codex) {
    throw new Error(
      "Custom commands are not supported for Codex in this package yet.",
    );
  }
}

export function buildCommandsSystemAppendix(
  commands: AgentCommandConfig[] | undefined,
): string | undefined {
  if (!commands || commands.length === 0) {
    return undefined;
  }

  return [
    "Custom commands are installed for this environment.",
    ...commands.map(
      (command) =>
        `- /${command.name}${command.description ? `: ${command.description}` : ""}`,
    ),
  ].join("\n");
}
