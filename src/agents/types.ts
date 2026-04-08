import type {
  AISDKEvent,
  NormalizedAgentEvent,
  PermissionRequestedEvent,
  RawAgentEvent,
} from "../events";
import type { Sandbox } from "../sandboxes";
import type {
  AgentCommandConfig,
  AgentHookConfig,
  AgentMcpConfig,
  AgentSkillConfig,
  AgentSubAgentConfig,
} from "./config/types";

export type AgentProviderName = "codex" | "opencode" | "claude-code";

export type DataContent = string | URL | Uint8Array | ArrayBuffer | Buffer;

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  image: DataContent;
  mediaType?: string;
}

export interface FilePart {
  type: "file";
  data: DataContent;
  mediaType: string;
  filename?: string;
}

export type UserContentPart = TextPart | ImagePart | FilePart;

export type UserContent = string | UserContentPart[];

export interface AgentRunConfig {
  input: UserContent;
  model?: string;
  systemPrompt?: string;
  resumeSessionId?: string;
}

export type AgentApprovalMode = "auto" | "interactive";

export type AgentPermissionKind =
  | "bash"
  | "edit"
  | "tool"
  | "network"
  | "file-change"
  | "unknown";

export type AgentPermissionDecision = "allow" | "deny";

export interface AgentPermissionResponse {
  requestId: string;
  decision: AgentPermissionDecision;
  remember?: boolean;
}

export interface AgentOptionsBase {
  sandbox?: Sandbox;
  cwd?: string;
  env?: Record<string, string>;
  approvalMode?: AgentApprovalMode;
  mcps?: AgentMcpConfig[];
  skills?: AgentSkillConfig[];
  subAgents?: AgentSubAgentConfig[];
  hooks?: AgentHookConfig[];
  commands?: AgentCommandConfig[];
}

export interface CodexProviderOptions {
  binary?: string;
  env?: Record<string, string>;
  brokerEndpoint?: string;
  useBroker?: boolean;
}

export interface OpenCodeProviderOptions {
  binary?: string;
  args?: string[];
  serverUrl?: string;
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
}

export interface ClaudeCodeProviderOptions {
  binary?: string;
  args?: string[];
  sessionAccessToken?: string;
  permissionMode?: string;
  allowedTools?: string[];
  autoApproveTools?: boolean;
  verbose?: boolean;
}

export interface CodexAgentOptions extends AgentOptionsBase {
  provider?: CodexProviderOptions;
}

export interface OpenCodeAgentOptions extends AgentOptionsBase {
  provider?: OpenCodeProviderOptions;
}

export interface ClaudeCodeAgentOptions extends AgentOptionsBase {
  provider?: ClaudeCodeProviderOptions;
}

export type AgentOptionsMap = {
  codex: CodexAgentOptions;
  opencode: OpenCodeAgentOptions;
  "claude-code": ClaudeCodeAgentOptions;
};

export type AgentOptions<P extends AgentProviderName = AgentProviderName> =
  AgentOptionsMap[P];

export interface AgentResult {
  id: string;
  provider: AgentProviderName;
  sessionId: string;
  text: string;
  rawEvents: RawAgentEvent[];
  events: NormalizedAgentEvent[];
}

export interface AgentRun extends AsyncIterable<NormalizedAgentEvent> {
  id: string;
  provider: AgentProviderName;
  sessionId?: string;
  readonly sessionIdReady: Promise<string>;
  raw?: unknown;
  rawEvents(): AsyncIterable<RawAgentEvent>;
  toAISDKEvents(): AsyncIterable<AISDKEvent>;
  respondToPermission(response: AgentPermissionResponse): Promise<void>;
  abort(): Promise<void>;
  readonly finished: Promise<AgentResult>;
}

export interface AgentRunSink {
  setRaw(raw: unknown): void;
  setAbort(abort: () => Promise<void>): void;
  setSessionId(sessionId: string): void;
  emitRaw(event: RawAgentEvent): void;
  emitEvent(event: NormalizedAgentEvent): void;
  requestPermission(
    event: PermissionRequestedEvent,
  ): Promise<AgentPermissionResponse>;
  complete(result?: { text?: string }): void;
  fail(error: unknown): void;
}

export interface AgentExecutionRequest<
  P extends AgentProviderName = AgentProviderName,
> {
  runId: string;
  provider: P;
  options: AgentOptions<P>;
  run: AgentRunConfig;
}

export interface AgentProviderAdapter<
  P extends AgentProviderName = AgentProviderName,
> {
  execute(
    request: AgentExecutionRequest<P>,
    sink: AgentRunSink,
  ): Promise<() => Promise<void> | void>;
}
