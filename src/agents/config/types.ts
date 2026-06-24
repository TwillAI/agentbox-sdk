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

/**
 * One OpenAI-compatible model provider for Codex, serialized into a
 * `[model_providers.<id>]` block in config.toml. Mirrors codex's
 * `ModelProviderInfo` (which uses snake_case keys and
 * `deny_unknown_fields`) but with the camelCase field names AgentBox
 * exposes publicly. Use it to point Codex at a local Ollama/LM Studio/vLLM
 * server or any other OpenAI-compatible endpoint.
 */
export interface CodexModelProviderConfig {
  /** Friendly display name. Defaults to the provider id when omitted. */
  name?: string;
  /** Base URL of the OpenAI-compatible API (e.g. `http://localhost:8000/v1`). */
  baseUrl?: string;
  /**
   * Name of the environment variable holding the API key. The variable
   * must be present in the agent env (`options.env` / `provider.env`) so
   * the codex process can read it — AgentBox never writes the secret into
   * config.toml.
   */
  envKey?: string;
  /**
   * Wire protocol the endpoint speaks. Codex removed the `"chat"` (Chat
   * Completions) wire API in Feb 2026 and now rejects it at config load,
   * so prefer `"responses"` (the Responses API) — what LM Studio and modern
   * Ollama expose. Omit to use codex's default
   * (`"responses"`). `"chat"` remains in the type only for older codex
   * builds / chat→responses proxies.
   */
  wireApi?: "chat" | "responses" | "responses_websocket";
  /** Extra query-string params appended to every request. */
  queryParams?: Record<string, string>;
  /** Static HTTP headers added to every request. */
  httpHeaders?: Record<string, string>;
  /** HTTP headers whose values come from env vars (header name -> env var name). */
  envHttpHeaders?: Record<string, string>;
  /** Maximum number of times to retry a failed request. */
  requestMaxRetries?: number;
  /** Maximum number of reconnect attempts for a dropped stream. */
  streamMaxRetries?: number;
  /** Idle timeout (ms) before a stalled stream is treated as lost. */
  streamIdleTimeoutMs?: number;
}

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

export interface SetupLayout {
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

import type { TarballEntry } from "../../sandboxes/tarball";
import type { CommandResult } from "../../sandboxes/types";

export interface SetupTarget {
  readonly provider: AgentProviderName;
  readonly layout: SetupLayout;
  readonly env: Record<string, string>;
  /**
   * Upload `files` as a tarball and execute `command` in a single round-
   * trip. Used by `applyDifferentialSetup` to ship every artifact + the
   * install script in one Modal exec; falls back to a non-bundled write +
   * run on host or simpler providers.
   */
  uploadAndRun(files: TarballEntry[], command: string): Promise<CommandResult>;
  /**
   * Run a one-off shell command. Still used by sandbox-resident server
   * launches (Codex app-server, OpenCode serve) and by the legacy local
   * setup path.
   */
  runCommand(command: string, extraEnv?: Record<string, string>): Promise<void>;
  /**
   * Run a one-off shell command and return whether it exited 0. Used by
   * preflight checks where exit-code IS the answer (setupId match,
   * daemon liveness probe). Unlike `runCommand`, never throws on a
   * non-zero exit — that's a normal "stale" outcome.
   */
  probe(command: string, extraEnv?: Record<string, string>): Promise<boolean>;
  cleanup(): Promise<void>;
}
