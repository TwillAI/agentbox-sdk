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
  CodexModelProviderConfig,
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
   * - codex: `thread/fork { threadId, lastTurnId: forkAtMessageId }`
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
  /**
   * When `true`, wire RTK (rust-token-killer, https://github.com/rtk-ai/rtk)
   * into the agent so its bash commands flow through `rtk rewrite` to trim
   * output and save tokens. The `rtk` binary must be installed on PATH
   * inside the sandbox (or on the host, for non-sandbox runs).
   *
   * Activation happens during {@link Agent.setup}: agentbox shells out to
   * `rtk init -g [...]` with environment variables that redirect RTK's
   * writes into the agentbox-managed config layout (so the hook persists
   * past the agent CLI's own settings rewrites). Idempotent — `rtk init`
   * is a no-op when already active. Toggle invalidates the setup cache.
   */
  enableRtk?: boolean;
  /**
   * Custom HTTP headers to attach to the agent's outbound LLM API requests.
   *
   * Forwarded per provider via whatever native mechanism each CLI exposes:
   * - claude-code: `ANTHROPIC_CUSTOM_HEADERS` (applies to all Anthropic calls)
   * - codex: `http_headers` on the active `[model_providers.*]` block in
   *   config.toml. When Codex falls back to its built-in `openai` provider,
   *   there is no provider block to carry headers, so headers are ignored.
   * - open-code: `provider.<id>.options.headers` in the opencode config
   *
   * Typical use: spend-tracking / routing tags for an LLM gateway, e.g.
   * `{ "x-litellm-tags": "task:123" }`. Whether a header actually reaches the
   * upstream depends on the CLI and provider; open-code's config-level headers
   * in particular are subject to upstream support.
   */
  customHeaders?: Record<string, string>;
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
   * Extra OpenAI-compatible model providers, written as
   * `[model_providers.<id>]` blocks in Codex's config.toml. Lets Codex
   * talk to a local Ollama/LM Studio/vLLM server or another
   * OpenAI-compatible endpoint.
   */
  modelProviders?: Record<string, CodexModelProviderConfig>;
  /**
   * Top-level `model_provider` written into Codex's config.toml — selects
   * which {@link modelProviders} table Codex routes every run through (the
   * per-run {@link AgentRunConfig.model} stays a plain model slug).
   *
   * When omitted, Codex falls back to its built-in `openai` provider.
   */
  modelProvider?: string;
  /**
   * Default model slug written as the top-level `model` in Codex's
   * config.toml and used as the fallback `model` for any sub-agent
   * ({@link AgentSubAgentConfig}) that does not set its own.
   *
   * Why this exists: when Codex spawns a *named* sub-agent it reloads the
   * child config from the on-disk config-layer stack (config.toml + the
   * role's TOML) and drops the parent turn's runtime model. If neither
   * layer carries a `model`, the child's model resolves to `None` and
   * `spawn_agent` fails service-tier validation with "could not resolve the
   * child model". Setting this guarantees a resolvable model is always on
   * disk. The per-run {@link AgentRunConfig.model} still overrides it for
   * the root turn via `thread/start`; this only backstops role spawns and
   * runs that omit a model.
   */
  defaultModel?: string;
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
  /**
   * Extra directories Claude Code is allowed to read/write outside `cwd`.
   * Passed through to `--add-dir` (one flag per entry). Use absolute paths.
   *
   * Common case: cwd points at a parent directory and tasks need access
   * to sibling repos cloned under it. Listing each repo here surfaces it
   * to the agent without changing the working directory.
   */
  additionalDirectories?: string[];
  /**
   * When `true` (the default), the in-sandbox CLI emits `hook_started` and
   * `hook_response` system messages so the host can observe every hook
   * fire — useful to confirm a project-defined hook actually ran and to
   * surface its stdout/stderr/exit_code on failures. Set `false` to
   * silence them when hook noise drowns out the rest of the event stream.
   */
  includeHookEvents?: boolean;
  /**
   * Enable "ultracode" for claude-code runs: xhigh reasoning effort plus
   * standing dynamic-workflow orchestration (the built-in `Workflow` tool).
   *
   * When `true`, agentbox writes `enableWorkflows: true` + `ultracode: true`
   * into the managed `settings.json` and forces `effort: "xhigh"` on the query.
   *
   * Requires an xhigh-capable model (e.g. Opus) and a recent runtime — the
   * Workflows feature shipped around Claude Code 2.1.154 / Agent SDK 0.3.149.
   * On older CLIs the settings keys are simply ignored.
   */
  ultracode?: boolean;
}

export interface CodexAgentOptions extends AgentOptionsBase {
  provider?: CodexProviderOptions;
}

export interface OpenRouterPlugin {
  id: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface OpenCodeAgentOptions extends AgentOptionsBase {
  provider?: OpenCodeProviderOptions;
  openRouterPlugins?: OpenRouterPlugin[];
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
  /**
   * Stop the long-lived provider CLI server that {@link setup} boots
   * (claude-code relay daemon, codex app-server, opencode `serve`).
   *
   * agentbox NEVER calls this on its own — not on run completion, not on
   * abort, and not when {@link setup} sees a changed config/credential
   * set. It exists purely so a developer can explicitly tear a server
   * down (to reclaim resources, or to force the changed config to apply
   * on the next cold {@link setup}).
   *
   * Best-effort and idempotent: a no-op when nothing is running, or when
   * the provider has no shared server for the current mode (host-mode
   * claude-code runs the SDK in-process; local codex spawns a fresh
   * app-server per run).
   */
  killServer(request: AgentSetupRequest<P>): Promise<void>;
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
