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

export type ClaudeCodeHookEvent =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PermissionRequest"
  | "PermissionDenied"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Notification"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop"
  | "StopFailure"
  | "TeammateIdle"
  | "FileChanged"
  | "WorktreeCreate"
  | "WorktreeRemove"
  | "PreCompact"
  | "PostCompact"
  | "CwdChanged"
  | "TaskCreated"
  | "TaskCompleted";

export interface ClaudeCodeHookBase {
  if?: string;
  timeout?: number;
  statusMessage?: string;
  once?: boolean;
}

export interface ClaudeCodeCommandHook extends ClaudeCodeHookBase {
  type: "command";
  command: string;
  async?: boolean;
  shell?: "bash" | "powershell";
}

export interface ClaudeCodeHttpHook extends ClaudeCodeHookBase {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
}

export interface ClaudeCodePromptHook extends ClaudeCodeHookBase {
  type: "prompt";
  prompt: string;
  model?: string;
}

export interface ClaudeCodeAgentHook extends ClaudeCodeHookBase {
  type: "agent";
  prompt: string;
  model?: string;
}

export type ClaudeCodeHookHandler =
  | ClaudeCodeCommandHook
  | ClaudeCodeHttpHook
  | ClaudeCodePromptHook
  | ClaudeCodeAgentHook;

export interface ClaudeCodeHookMatcherGroup {
  matcher?: string;
  hooks: ClaudeCodeHookHandler[];
}

export type ClaudeCodeHooksConfig = Partial<
  Record<ClaudeCodeHookEvent, ClaudeCodeHookMatcherGroup[]>
>;

export type ClaudeCodeHookConfig = ClaudeCodeHooksConfig;

export type CodexHookEvent =
  | "SessionStart"
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop";

export interface CodexCommandHook {
  type: "command";
  command: string;
  timeout?: number;
  timeoutSec?: number;
  statusMessage?: string;
}

export interface CodexHookMatcherGroup {
  matcher?: string;
  hooks: CodexCommandHook[];
}

export type CodexHooksConfig = Partial<
  Record<CodexHookEvent, CodexHookMatcherGroup[]>
>;

export type OpenCodePluginEvent =
  | "command.executed"
  | "file.edited"
  | "file.watcher.updated"
  | "installation.updated"
  | "lsp.client.diagnostics"
  | "lsp.updated"
  | "message.part.removed"
  | "message.part.updated"
  | "message.removed"
  | "message.updated"
  | "permission.asked"
  | "permission.replied"
  | "server.connected"
  | "session.created"
  | "session.compacted"
  | "session.deleted"
  | "session.diff"
  | "session.error"
  | "session.idle"
  | "session.status"
  | "session.updated"
  | "todo.updated"
  | "shell.env"
  | "tool.execute.after"
  | "tool.execute.before"
  | "tui.prompt.append"
  | "tui.command.execute"
  | "tui.toast.show"
  | "experimental.session.compacting";

export interface OpenCodePluginHookConfig {
  event: OpenCodePluginEvent;
  body: string;
}

export interface OpenCodePluginConfig {
  name: string;
  hooks: OpenCodePluginHookConfig[];
  preamble?: string;
  setup?: string;
  fileExtension?: "js" | "ts";
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

export interface RuntimeTarget {
  readonly provider: AgentProviderName;
  readonly layout: RuntimeLayout;
  readonly env: Record<string, string>;
  writeArtifact(artifact: TextArtifact): Promise<void>;
  runCommand(command: string, extraEnv?: Record<string, string>): Promise<void>;
  cleanup(): Promise<void>;
}
