import path from "node:path";

import type { AgentProviderName } from "../types";
import { shellQuote } from "../../shared/shell";
import type {
  AgentSkillConfig,
  RuntimeTarget,
  PreparedSkill,
  RuntimeLayout,
  TextArtifact,
} from "./types";

function getSkillTargetDir(
  provider: AgentProviderName,
  layout: RuntimeLayout,
  skillName: string,
): string {
  switch (provider) {
    case "claude-code":
      return path.join(layout.claudeDir, "skills", skillName);
    case "opencode":
      return path.join(layout.opencodeDir, "skills", skillName);
    case "codex":
      return path.join(layout.agentsDir, "skills", skillName);
  }
}

function buildSkillsInstallerCommand(
  provider: AgentProviderName,
  skill: Exclude<AgentSkillConfig, { source: "embedded" }>,
): string {
  const repo = skill.repo ?? "https://github.com/anthropics/skills";
  const agent = provider === "claude-code" ? "claude-code" : provider;
  return `npx skills add ${shellQuote(repo)} -g --skill ${shellQuote(skill.name)} --agent ${shellQuote(agent)} -y`;
}

export async function prepareSkillArtifacts(
  provider: AgentProviderName,
  skills: AgentSkillConfig[] | undefined,
  layout: RuntimeLayout,
): Promise<{
  artifacts: TextArtifact[];
  installCommands: string[];
  preparedSkills: PreparedSkill[];
}> {
  const artifacts: TextArtifact[] = [];
  const installCommands: string[] = [];
  const preparedSkills: PreparedSkill[] = [];

  for (const skill of skills ?? []) {
    const targetDir = getSkillTargetDir(provider, layout, skill.name);
    const skillFilePath = path.join(targetDir, "SKILL.md");

    if (!("files" in skill)) {
      installCommands.push(buildSkillsInstallerCommand(provider, skill));
      preparedSkills.push({ name: skill.name, skillFilePath });
      continue;
    }

    for (const [relativePath, content] of Object.entries(skill.files)) {
      artifacts.push({
        path: path.join(targetDir, relativePath),
        content,
        executable: relativePath.startsWith("scripts/"),
      });
    }

    preparedSkills.push({ name: skill.name, skillFilePath });
  }

  return {
    artifacts,
    installCommands,
    preparedSkills,
  };
}

export function buildSkillsSystemAppendix(
  skills: PreparedSkill[],
): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }

  return [
    "Configured skills are available for this run.",
    "Use them when they meaningfully help complete the task.",
    ...skills.map((skill) => `- ${skill.name}`),
  ].join("\n");
}

export async function installSkills(
  target: RuntimeTarget,
  installCommands: string[],
  extraEnv?: Record<string, string>,
): Promise<void> {
  for (const command of installCommands) {
    await target.runCommand(command, extraEnv);
  }
}
