import type { AgentProviderName } from "../types";

export type AgentRemoteMcpConfig = {
  name: string;
  type: "remote";
  url: string;
  enabled?: boolean;
  bearerTokenEnvVar?: string;
  headers?: Record<string, string>;
};

export type AgentLocalMcpConfig = {
  name: string;
  type: "local";
  enabled?: boolean;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type AgentMcpConfig = AgentRemoteMcpConfig | AgentLocalMcpConfig;

export type RepoSkillConfig = {
  name: string;
  repo?: string;
};

export type EmbeddedSkillConfig = {
  source: "embedded";
  name: string;
  files: Record<string, string>;
};

export type AgentSkillConfig = RepoSkillConfig | EmbeddedSkillConfig;

export interface AgentSubAgentConfig {
  name: string;
  description: string;
  instructions: string;
  tools?: string[];
  model?: string;
}

export type AgentHookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "Notification"
  | "SubagentStop";

export interface AgentHookConfig {
  event: AgentHookEvent;
  matcher?: string;
  type: "command";
  command: string;
  statusMessage?: string;
}

export interface AgentCommandConfig {
  name: string;
  template: string;
  description?: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
}

export interface RuntimeLayout {
  rootDir: string;
  homeDir: string;
  xdgConfigHome: string;
  agentsDir: string;
  claudeDir: string;
  opencodeDir: string;
  codexDir: string;
}

export interface TextArtifact {
  path: string;
  content: string;
  executable?: boolean;
}

export interface PreparedSkill {
  name: string;
  skillFilePath: string;
}

export interface PreparedAgentConfig {
  env: Record<string, string>;
  artifacts: TextArtifact[];
  installCommands: string[];
  systemPrompt?: string;
  skillReferences: PreparedSkill[];
}

export interface ClaudePreparedConfig extends PreparedAgentConfig {
  args: string[];
  initializeRequest?: Record<string, unknown>;
}

export interface OpenCodePreparedConfig extends PreparedAgentConfig {
  configPath: string;
  extraEnv?: Record<string, string>;
  agentName: string;
}

export interface CodexPreparedConfig extends PreparedAgentConfig {
  args: string[];
  inputItems?: Array<Record<string, unknown>>;
}

export interface MaterializationTarget {
  readonly provider: AgentProviderName;
  readonly layout: RuntimeLayout;
  readonly env: Record<string, string>;
  writeArtifact(artifact: TextArtifact): Promise<void>;
  runCommand(command: string, extraEnv?: Record<string, string>): Promise<void>;
  cleanup(): Promise<void>;
}
