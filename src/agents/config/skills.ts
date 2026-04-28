import path from "node:path";

import { AgentProvider, type AgentProviderName } from "../types";
import { shellQuote } from "../../shared/shell";
import type {
  AgentSkillConfig,
  SetupTarget,
  PreparedSkill,
  SetupLayout,
  TextArtifact,
} from "./types";

function getSkillTargetDir(
  provider: AgentProviderName,
  layout: SetupLayout,
  skillName: string,
): string {
  switch (provider) {
    case AgentProvider.ClaudeCode:
      return path.join(layout.claudeDir, "skills", skillName);
    case AgentProvider.OpenCode:
      return path.join(layout.opencodeDir, "skills", skillName);
    case AgentProvider.Codex:
      // Codex auto-discovers skills from `<CODEX_HOME>/skills/<name>/SKILL.md`
      // (and `${cwd}/.codex/skills/...`). Writing them under `codexDir`
      // means the codex CLI picks them up at startup with no per-turn
      // wire-protocol injection — `execute()` does not need to know
      // anything about which skills were configured.
      return path.join(layout.codexDir, "skills", skillName);
  }
}

// The upstream `skills` CLI keys agents by their binary name, so we translate
// our provider identifiers to the value that the CLI recognizes.
function skillsCliAgentName(provider: AgentProviderName): string {
  return provider === AgentProvider.OpenCode ? "opencode" : provider;
}

function buildSkillsInstallerCommand(
  provider: AgentProviderName,
  skill: Exclude<AgentSkillConfig, { source: "embedded" }>,
): string {
  const repo = skill.repo ?? "https://github.com/anthropics/skills";
  return `npx skills add ${shellQuote(repo)} -g --skill ${shellQuote(skill.name)} --agent ${shellQuote(skillsCliAgentName(provider))} -y`;
}

export async function prepareSkillArtifacts(
  provider: AgentProviderName,
  skills: AgentSkillConfig[] | undefined,
  layout: SetupLayout,
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
  target: SetupTarget,
  installCommands: string[],
  extraEnv?: Record<string, string>,
): Promise<void> {
  // Each `npx skills add ...` install touches a distinct skill directory so
  // they're safe to run concurrently. Sequential execution was costing
  // multiple seconds per skill on remote sandboxes.
  await Promise.all(
    installCommands.map((command) => target.runCommand(command, extraEnv)),
  );
}
