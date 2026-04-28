import type {
  AISDKEvent,
  NormalizedAgentEvent,
  PermissionRequestedEvent,
  RawAgentEvent,
} from "../events";
import type { Sandbox } from "../sandboxes";
import type {
  AgentCommandConfig,
  AgentMcpConfig,
  AgentSkillConfig,
  AgentSubAgentConfig,
  ClaudeCodeHooksConfig,
  CodexHooksConfig,
  OpenCodePluginConfig,
} from "./config/types";

export { AgentProvider } from "../enums";
import type { AgentProvider } from "../enums";

export type AgentProviderName = AgentProvider;

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

export type AgentReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface AgentRunConfig {
  input: UserContent;
  runId?: string;
  model?: string;
  systemPrompt?: string;
  resumeSessionId?: string;
  reasoning?: AgentReasoningEffort;
}

/**
 * Subset of {@link AgentRunConfig} that needs to be committed at
 * `agent.setup()` time so the runtime can pre-bake artifacts that
 * reference it (codex `model_instructions_file`, opencode agent config,
 * etc.). Unlike `AgentRunConfig`, this never carries per-turn input or
 * a resumed session id.
 */
export type AgentSetupConfig = Pick<
  AgentRunConfig,
  "systemPrompt" | "model" | "reasoning"
>;

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
  commands?: AgentCommandConfig[];
}

export interface CodexProviderOptions {
  binary?: string;
  env?: Record<string, string>;
  brokerEndpoint?: string;
  useBroker?: boolean;
  hooks?: CodexHooksConfig;
}

export interface OpenCodeProviderOptions {
  binary?: string;
  args?: string[];
  plugins?: OpenCodePluginConfig[];
}

export interface ClaudeCodeProviderOptions {
  binary?: string;
  args?: string[];
  hooks?: ClaudeCodeHooksConfig;
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
  "open-code": OpenCodeAgentOptions;
  "claude-code": ClaudeCodeAgentOptions;
};

export type AgentOptions<P extends AgentProviderName = AgentProviderName> =
  AgentOptionsMap[P];

export interface AgentCostData {
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface AgentResult {
  id: string;
  provider: AgentProviderName;
  sessionId: string;
  text: string;
  rawEvents: RawAgentEvent[];
  events: NormalizedAgentEvent[];
  costData?: AgentCostData | null;
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
  sendMessage(content: UserContent): Promise<void>;
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
  onMessage(
    handler: (content: UserContent) => Promise<{ messageId?: string } | void>,
  ): void;
  complete(result?: { text?: string; costData?: AgentCostData | null }): void;
  fail(error: unknown): void;
}

export interface AgentSetupRequest<
  P extends AgentProviderName = AgentProviderName,
> {
  provider: P;
  options: AgentOptions<P>;
  config: AgentSetupConfig;
}

export interface AgentExecutionRequest<
  P extends AgentProviderName = AgentProviderName,
> {
  runId: string;
  provider: P;
  options: AgentOptions<P>;
  run: AgentRunConfig;
}

/**
 * Request to truncate a session at a specific message and produce a forked
 * sessionId that can be passed to `Agent.stream({ resumeSessionId })`.
 *
 * Each provider interprets `messageId` natively:
 * - claude-code: a user message UUID from the session JSONL transcript
 * - codex: a turn id (returned in `turn/started` notifications)
 * - open-code: a server-generated message id (from `message.updated` SSE)
 *
 * The fork drops the message at `messageId` and everything after it. The
 * caller is then expected to start a new run with `resumeSessionId` set to
 * the returned sessionId, sending an edited input that effectively replaces
 * the dropped message.
 */
export interface AgentForkRequest<
  P extends AgentProviderName = AgentProviderName,
> {
  sessionId: string;
  messageId: string;
  options: AgentOptions<P>;
}

export interface AgentForkResult {
  sessionId: string;
}

export interface AgentProviderAdapter<
  P extends AgentProviderName = AgentProviderName,
> {
  /**
   * Sandbox-side preparation work that does not depend on per-run input:
   * upload artifacts (skills/commands/mcp/hook config), boot any
   * provider server / relay the run will need.
   *
   * Required before {@link AgentProviderAdapter.execute} for sandbox-backed
   * runs. {@link execute} does not read any setup output and does not
   * re-do this work — it assumes the relay/server is up and dials it
   * directly. If `setup` was never called against a remote sandbox the
   * connect retry inside `execute` fails naturally.
   *
   * Idempotent: `applyDifferentialSetup` short-circuits unchanged
   * artifacts, and the relay/server probes short-circuit when something
   * is already listening.
   */
  setup(request: AgentSetupRequest<P>): Promise<void>;
  execute(
    request: AgentExecutionRequest<P>,
    sink: AgentRunSink,
  ): Promise<() => Promise<void> | void>;
  forkAt(request: AgentForkRequest<P>): Promise<AgentForkResult>;
}
