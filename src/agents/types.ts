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
  /**
   * Source session/thread to fork from. The new run begins in a *new*
   * session whose history is the prefix of the source up to and including
   * {@link forkAtMessageId}. Mutually exclusive with {@link resumeSessionId}.
   * Requires {@link forkAtMessageId}.
   *
   * Provider mapping:
   * - claude-code: `query({ resume, resumeSessionAt, forkSession: true })`
   * - opencode: `POST /session/:forkSessionId/fork { messageID }`
   * - codex: emulated via `thread/fork` + `thread/rollback` (no native
   *   message-level fork in the codex app-server)
   */
  forkSessionId?: string;
  /**
   * Provider-native message id (claude-code: assistant message UUID;
   * opencode: message info id; codex: turn id) to fork at — inclusive.
   * The unified `messageId` field on `message.started` events carries the
   * value to feed back here. Required when {@link forkSessionId} is set.
   */
  forkAtMessageId?: string;
  reasoning?: AgentReasoningEffort;
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
  commands?: AgentCommandConfig[];
}

export interface CodexProviderOptions {
  binary?: string;
  env?: Record<string, string>;
  brokerEndpoint?: string;
  useBroker?: boolean;
  hooks?: CodexHooksConfig;
  /**
   * When `false`, writes `supports_websockets = false` into Codex's
   * config.toml. Useful in environments where outbound WebSocket
   * connections from the Codex CLI aren't available (proxies, network
   * policies). When `true` or omitted, no key is emitted and Codex
   * uses its built-in default.
   */
  supportsWebsockets?: boolean;
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
  /**
   * Setup-time system prompt baked into the opencode agent's `prompt` field.
   *
   * When set, this REPLACES opencode's built-in provider prompt
   * (`anthropic.txt` / `codex.txt` / `gemini.txt` / etc.) and is the most
   * prominent system message the model sees. Use this when you need the
   * prompt to actually steer Anthropic models — opencode appends
   * {@link AgentRunConfig.systemPrompt} *after* its long provider prompt,
   * which Sonnet/Opus tend to ignore in favor of the leading content.
   *
   * Trade-off: replacing the provider prompt drops opencode's hand-tuned
   * Anthropic tool-usage hints. Models still receive tool definitions and
   * the runtime appendix (MCPs/skills/sub-agents/commands) via the
   * per-message `system` field, so tools remain functional — just less
   * prominently announced.
   *
   * Setup-time field: changing it between runs invalidates the
   * setup-manifest cache and triggers a re-upload of the agent config on
   * the next `setup()` call. {@link AgentRunConfig.systemPrompt} continues
   * to work as a per-message override (appended after `agent.prompt`),
   * which is fine for codex/GPT models but weak for Anthropic.
   */
  systemPrompt?: string;
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
  isCancelled: boolean;
  error?: string;
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
  cancel(result?: { text?: string; costData?: AgentCostData | null }): void;
  fail(error: unknown): void;
}

export interface AgentSetupRequest<
  P extends AgentProviderName = AgentProviderName,
> {
  provider: P;
  options: AgentOptions<P>;
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
 * Stateless attach request used by {@link Agent.attach} to issue control
 * commands (abort, sendMessage) against a run that lives on a different
 * Twill instance.
 *
 * The attach call dials the in-sandbox provider server directly via
 * `sandbox.getPreviewLink(...)` — no shared in-memory state, no broker.
 * The originating instance still owns the run's event stream and reacts
 * naturally to whatever the provider emits as a consequence of the
 * attached command (e.g. `turn/aborted` for codex, message events for
 * claude-code/opencode).
 */
export interface AgentAttachRequest<
  P extends AgentProviderName = AgentProviderName,
> {
  provider: P;
  sandbox: Sandbox;
  /**
   * The {@link AgentRunConfig.runId} the originating instance used in
   * `agent.stream({ runId, ... })`. Required for claude-code (the relay
   * keys channels by runId) and useful as an idempotency / log id for
   * the other providers.
   */
  runId: string;
  /**
   * Provider-native session id captured from {@link AgentRun.sessionIdReady}.
   *
   * - codex: the threadId
   * - opencode: the sessionId
   * - claude-code: the claude session uuid (optional — runId is the
   *   primary key inside the relay)
   */
  sessionId?: string;
  /**
   * Codex only: the in-flight turn id, captured by the originating
   * caller from the {@link NormalizedAgentEvent} `message.started`
   * event (whose `messageId` is the codex turnId). `attachAbort` uses
   * it for `turn/interrupt`. When omitted the codex attach is a no-op.
   *
   * The SDK does not persist this itself — bookkeeping it across
   * processes is the caller's responsibility (e.g. Redis), since
   * sandbox-side files don't compose well under concurrency.
   */
  turnId?: string;
}

/**
 * Thin handle returned by {@link Agent.attach}. Methods are short-lived:
 * each call opens a fresh transport to the in-sandbox server, performs
 * the operation, and tears the transport down. There is no "close" —
 * the handle holds no resources between calls.
 */
export interface AttachedRun {
  abort(): Promise<void>;
  sendMessage(content: UserContent): Promise<void>;
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
  /**
   * Stateless abort. Dial the in-sandbox provider server, issue the
   * provider's "interrupt the in-flight turn" primitive, close.
   */
  attachAbort(request: AgentAttachRequest<P>): Promise<void>;
  /**
   * Stateless message injection. Dial the in-sandbox provider server,
   * append `content` as a new user turn against the existing session,
   * close.
   */
  attachSendMessage(
    request: AgentAttachRequest<P>,
    content: UserContent,
  ): Promise<void>;
}
