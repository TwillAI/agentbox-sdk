import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  createNormalizedEvent,
  toAISDKStream,
  type NormalizedAgentEvent,
  type PermissionRequestedEvent,
  type RawAgentEvent,
} from "../events";
import { AsyncQueue } from "../shared/async-queue";
import { asError, UnsupportedProviderError } from "../shared/errors";
import { debugAgent } from "../shared/debug";
import { ClaudeCodeAgentAdapter } from "./providers/claude-code";
import { CodexAgentAdapter } from "./providers/codex";
import { OpenCodeAgentAdapter } from "./providers/opencode";
import {
  AgentProvider,
  type AgentAttachRequest,
  type AgentExecutionRequest,
  type AgentProviderAdapter,
  type AgentProviderName,
  type AgentResult,
  type AgentRun,
  type AgentRunConfig,
  type AgentOptions,
  type AgentRunSink,
  type AgentPermissionResponse,
  type AttachedRun,
  type UserContent,
  type AgentCostData,
} from "./types";
import { normalizeUserInput } from "./input";
import { validateUserAnswers } from "./questions";
import { resolveBackgroundTaskTimeoutMs } from "./background-tasks";
import type { Sandbox } from "../sandboxes";

function buildAgentOptionsSystemAppendix(
  options: AgentOptions,
): string | undefined {
  const sections: string[] = [];

  if (options.mcps?.length) {
    sections.push(
      [
        "Configured MCP servers are available for this run:",
        ...options.mcps.map((mcp) => `- ${mcp.name}`),
      ].join("\n"),
    );
  }

  if (options.skills?.length) {
    sections.push(
      [
        "Configured skills are available for this run:",
        ...options.skills.map((skill) => `- ${skill.name}`),
      ].join("\n"),
    );
  }

  if (options.subAgents?.length) {
    sections.push(
      [
        "Configured sub-agents are available for delegation:",
        ...options.subAgents.map(
          (subAgent) => `- ${subAgent.name}: ${subAgent.description}`,
        ),
      ].join("\n"),
    );
  }

  if (options.commands?.length) {
    sections.push(
      [
        "Custom commands are installed for this environment:",
        ...options.commands.map(
          (command) =>
            `- /${command.name}${command.description ? `: ${command.description}` : ""}`,
        ),
      ].join("\n"),
    );
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function buildRunConfig(
  options: AgentOptions,
  runConfig: AgentRunConfig,
): AgentRunConfig {
  const appendix = buildAgentOptionsSystemAppendix(options);
  const systemPrompt = [runConfig.systemPrompt, appendix]
    .filter(Boolean)
    .join("\n\n");

  return {
    ...runConfig,
    ...(systemPrompt ? { systemPrompt } : {}),
  };
}

function createAdapter<P extends AgentProviderName>(
  provider: P,
): AgentProviderAdapter<P> {
  switch (provider) {
    case AgentProvider.Codex:
      return new CodexAgentAdapter() as AgentProviderAdapter<P>;
    case AgentProvider.OpenCode:
      return new OpenCodeAgentAdapter() as AgentProviderAdapter<P>;
    case AgentProvider.ClaudeCode:
      return new ClaudeCodeAgentAdapter() as AgentProviderAdapter<P>;
    default:
      throw new UnsupportedProviderError("agent", provider);
  }
}

function prepareAgentOptions<P extends AgentProviderName>(
  _provider: P,
  options: AgentOptions<P>,
): AgentOptions<P> {
  // Agent harness ports (claude-code relay, codex app-server, opencode
  // server) used to be opened here on a best-effort basis. Callers are now
  // expected to pre-declare them at sandbox creation time
  // (`provider.unencryptedPorts`) — `AGENT_RESERVED_PORTS` and
  // `collectAllAgentReservedPorts()` from `agentbox-sdk` are exported for
  // exactly this purpose. Eliminating this loop removes one Modal RPC per
  // run.
  if (options.stateDirectory !== undefined) {
    if (options.sandbox) throw new Error("stateDirectory is only supported for host execution.");
    if (!path.isAbsolute(options.stateDirectory)) throw new Error("stateDirectory must be an absolute path.");
  }
  if (options.sandbox && options.processGroup !== undefined) throw new Error("processGroup is only supported for host execution.");
  // Fail here, before any transport is dialed: a provider that rejected it
  // mid-run would leave a sandbox CLI executing the prompt with no reader.
  resolveBackgroundTaskTimeoutMs(options.backgroundTaskTimeoutMs);
  if (options.configuration === "native") {
    if (options.sandbox) throw new Error("Native configuration is only supported for host execution.");
    if (options.mcps?.length || options.skills?.length || options.subAgents?.length || options.commands?.length || options.enableRtk) {
      throw new Error("Native configuration uses the harness's own skills, MCPs, commands, and hooks.");
    }
  }
  return options;
}

class AgentRunController implements AgentRun, AgentRunSink {
  readonly id: string;
  readonly provider: AgentProviderName;
  /**
   * Whether to keep every event for {@link AgentResult}. Off, the queues
   * still deliver to live consumers but nothing is retained — see
   * {@link AgentOptionsBase.retainEvents}.
   */
  private readonly retainEvents: boolean;
  sessionId?: string;
  raw?: unknown;
  readonly sessionIdReady: Promise<string>;
  private abortHandler: () => Promise<void> = async () => undefined;
  private abortRequested = false;
  private finishBackgroundWaitHandler?: () => void;
  private finishBackgroundWaitRequested = false;
  private readonly eventQueue = new AsyncQueue<NormalizedAgentEvent>();
  private readonly rawQueue = new AsyncQueue<RawAgentEvent>();
  private readonly events: NormalizedAgentEvent[] = [];
  private readonly rawEventsList: RawAgentEvent[] = [];
  private readonly pendingPermissions = new Map<
    string,
    {
      event: PermissionRequestedEvent;
      resolve: (response: AgentPermissionResponse) => void;
      reject: (reason?: unknown) => void;
    }
  >();
  private messageHandler?: (
    content: UserContent,
  ) => Promise<{ messageId?: string } | void>;
  private text = "";
  private observedMessageCompleted = false;
  private costData: AgentCostData | null = null;
  private settled = false;
  readonly finished: Promise<AgentResult>;
  private readonly resolveSessionIdReady: (value: string) => void;
  private readonly rejectSessionIdReady: (reason?: unknown) => void;
  private readonly resolveFinished: (value: AgentResult) => void;

  constructor(provider: AgentProviderName, id: string, retainEvents = true) {
    this.provider = provider;
    this.id = id;
    this.retainEvents = retainEvents;

    let resolveFinished!: (value: AgentResult) => void;
    let resolveSessionIdReady!: (value: string) => void;
    let rejectSessionIdReady!: (reason?: unknown) => void;
    this.finished = new Promise<AgentResult>((resolve) => {
      resolveFinished = resolve;
    });
    this.sessionIdReady = new Promise<string>((resolve, reject) => {
      resolveSessionIdReady = resolve;
      rejectSessionIdReady = reject;
    });
    void this.sessionIdReady.catch(() => undefined);
    this.resolveFinished = resolveFinished;
    this.resolveSessionIdReady = resolveSessionIdReady;
    this.rejectSessionIdReady = rejectSessionIdReady;
  }

  setRaw(raw: unknown): void {
    this.raw = raw;
  }

  setAbort(abort: () => Promise<void>): void {
    this.abortHandler = abort;
    if (this.abortRequested) {
      void abort();
    }
  }

  setFinishBackgroundWait(finish: () => void): void {
    this.finishBackgroundWaitHandler = finish;
    if (this.finishBackgroundWaitRequested) {
      finish();
    }
  }

  setSessionId(sessionId: string): void {
    if (this.sessionId) {
      return;
    }

    this.sessionId = sessionId;
    this.resolveSessionIdReady(sessionId);
  }

  emitRaw(event: RawAgentEvent): void {
    if (this.retainEvents) this.rawEventsList.push(event);
    this.rawQueue.push(event);
  }

  private pushEvent(event: NormalizedAgentEvent): void {
    if (this.retainEvents) this.events.push(event);
    if (event.type === "text.delta") {
      this.text += event.delta;
    } else if (
      (event.type === "message.completed" || event.type === "run.completed") &&
      event.text
    ) {
      this.text = event.text;
      if (event.type === "message.completed") {
        this.observedMessageCompleted = true;
      }
    }

    this.eventQueue.push(event);
  }

  emitEvent(event: NormalizedAgentEvent): void {
    this.pushEvent(event);
  }

  requestPermission(
    event: PermissionRequestedEvent,
  ): Promise<AgentPermissionResponse> {
    if (this.settled) {
      throw new Error("Cannot request permission on a settled agent run.");
    }
    if (this.pendingPermissions.has(event.requestId)) {
      throw new Error(
        `Permission request ${event.requestId} is already pending for this run.`,
      );
    }

    const response = new Promise<AgentPermissionResponse>((resolve, reject) => {
      this.pendingPermissions.set(event.requestId, {
        event,
        resolve,
        reject,
      });
    });

    this.pushEvent(event);
    return response;
  }

  onMessage(
    handler: (content: UserContent) => Promise<{ messageId?: string } | void>,
  ): void {
    this.messageHandler = handler;
  }

  async sendMessage(content: UserContent): Promise<void> {
    if (this.settled) {
      throw new Error("Cannot send a message on a settled agent run.");
    }
    if (!this.messageHandler) {
      throw new Error(
        "This provider does not support sending messages during a run.",
      );
    }

    const textContent = normalizeUserInput(content)
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");

    const handlerResult = await this.messageHandler(content);
    const messageId = handlerResult?.messageId;

    this.pushEvent(
      createNormalizedEvent(
        "message.injected",
        { provider: this.provider, runId: this.id },
        {
          content: textContent || "(non-text content)",
          ...(messageId ? { messageId } : {}),
        },
      ),
    );
  }

  async respondToPermission(response: AgentPermissionResponse): Promise<void> {
    const pending = this.pendingPermissions.get(response.requestId);
    if (!pending) {
      throw new Error(
        `Permission request ${response.requestId} is not pending for this run.`,
      );
    }

    const answers = pending.event.kind === "question" && response.decision === "allow"
      ? validateUserAnswers(pending.event.questions, response.answers)
      : undefined;
    if (response.answers && !answers) throw new Error("Answers are only accepted for an allowed question request");
    this.pendingPermissions.delete(response.requestId);
    const remember = pending.event.canRemember ? response.remember : undefined;
    const resolvedResponse: AgentPermissionResponse = {
      requestId: response.requestId,
      decision: response.decision,
      ...(remember !== undefined ? { remember } : {}),
      ...(answers ? { answers } : {}),
    };

    this.pushEvent(
      createNormalizedEvent(
        "permission.resolved",
        {
          provider: this.provider,
          runId: this.id,
        },
        {
          requestId: response.requestId,
          decision: response.decision,
          ...(remember !== undefined ? { remember } : {}),
          ...(answers ? { answers } : {}),
        },
      ),
    );
    pending.resolve(resolvedResponse);
  }

  private clearPendingPermissions(error: unknown): void {
    for (const pending of this.pendingPermissions.values()) {
      pending.reject(error);
    }
    this.pendingPermissions.clear();
  }

  complete(result?: {
    text?: string;
    costData?: AgentCostData | null;
    nothingParked?: boolean;
  }): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    const nothingParked = result?.nothingParked === true;
    this.clearPendingPermissions(
      new Error(
        "Agent run completed before pending permission requests resolved.",
      ),
    );
    if (result?.text && !this.observedMessageCompleted) {
      this.text = result.text;
    }
    if (result && "costData" in result) {
      this.costData = result.costData ?? null;
    }

    this.eventQueue.finish();
    this.rawQueue.finish();
    if (!this.sessionId) {
      const errorMsg =
        "Agent run completed before a provider session id was set.";
      this.rejectSessionIdReady(new Error(errorMsg));
      this.resolveFinished({
        id: this.id,
        provider: this.provider,
        sessionId: "",
        text: this.text,
        rawEvents: [...this.rawEventsList],
        events: [...this.events],
        costData: this.costData,
        isCancelled: false,
        error: errorMsg,
        ...(nothingParked ? { nothingParked: true } : {}),
      });
      return;
    }
    this.resolveFinished({
      id: this.id,
      provider: this.provider,
      sessionId: this.sessionId,
      text: this.text,
      rawEvents: [...this.rawEventsList],
      events: [...this.events],
      costData: this.costData,
      isCancelled: false,
      ...(nothingParked ? { nothingParked: true } : {}),
    });
  }

  cancel(result?: { text?: string; costData?: AgentCostData | null }): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.clearPendingPermissions(
      new Error(
        "Agent run was cancelled before pending permission requests resolved.",
      ),
    );
    if (result?.text && !this.observedMessageCompleted) {
      this.text = result.text;
    }
    if (result && "costData" in result) {
      this.costData = result.costData ?? null;
    }

    this.emitEvent(
      createNormalizedEvent(
        "run.cancelled",
        { provider: this.provider, runId: this.id },
        { text: this.text || undefined },
      ),
    );
    this.eventQueue.finish();
    this.rawQueue.finish();
    this.resolveFinished({
      id: this.id,
      provider: this.provider,
      sessionId: this.sessionId ?? "",
      text: this.text,
      rawEvents: [...this.rawEventsList],
      events: [...this.events],
      costData: this.costData,
      isCancelled: true,
    });
  }

  fail(error: unknown): void {
    if (this.settled) {
      return;
    }

    if (this.abortRequested) { this.cancel(); return; }
    const normalizedError = asError(error);
    this.clearPendingPermissions(normalizedError);
    this.emitEvent(
      createNormalizedEvent(
        "run.error",
        {
          provider: this.provider,
          runId: this.id,
        },
        {
          error: normalizedError.message,
        },
      ),
    );
    this.settled = true;
    this.eventQueue.finish();
    this.rawQueue.finish();
    if (!this.sessionId) {
      this.rejectSessionIdReady(normalizedError);
    }
    this.resolveFinished({
      id: this.id,
      provider: this.provider,
      sessionId: this.sessionId ?? "",
      text: this.text,
      rawEvents: [...this.rawEventsList],
      events: [...this.events],
      costData: this.costData,
      isCancelled: false,
      error: normalizedError.message,
    });
  }

  async abort(): Promise<void> {
    this.abortRequested = true;
    this.clearPendingPermissions(new Error("Agent run cancelled"));
    await this.abortHandler();
  }

  async finishBackgroundWait(): Promise<void> {
    this.finishBackgroundWaitRequested = true;
    this.finishBackgroundWaitHandler?.();
  }

  rawEvents(): AsyncIterable<RawAgentEvent> {
    return this.rawQueue;
  }

  toAISDKEvents() {
    return toAISDKStream(this);
  }

  [Symbol.asyncIterator](): AsyncIterator<NormalizedAgentEvent> {
    return this.eventQueue[Symbol.asyncIterator]();
  }
}

export class Agent<P extends AgentProviderName = AgentProviderName> {
  private readonly adapter: AgentProviderAdapter<P>;
  readonly provider: P;
  private readonly options: AgentOptions<P>;
  private setupPromise?: Promise<void>;

  constructor(provider: P, options: AgentOptions<P>) {
    this.provider = provider;
    this.options = prepareAgentOptions(provider, options);
    this.adapter = createAdapter(provider);
  }

  /**
   * The sandbox the agent will run inside, if any was passed via
   * `options.sandbox`. Returns `undefined` for host-mode runs (no sandbox).
   */
  get sandbox(): Sandbox | undefined {
    return this.options.sandbox;
  }

  /**
   * Prepare provider-specific runtime state on the configured sandbox
   * (skill artifacts, MCP/hook/sub-agent config, app-server / relay boot, …).
   *
   * `setup()` is REQUIRED before {@link Agent.stream} or {@link Agent.run}
   * for any sandbox-backed run. `stream` and the underlying
   * `adapter.execute` deliberately do not trigger setup themselves so
   * callers can run sandbox-side preparation in parallel with other
   * long-running work (e.g. `git clone`).
   *
   * `execute` does not consume any setup output and does not re-do
   * setup work. It assumes the relay/server boot performed here is
   * already up. Skipping `setup()` against a remote sandbox is a
   * programmer error and surfaces as a connect-retry timeout inside
   * `execute`, not a silent fallback.
   *
   * Idempotent across repeated invocations: subsequent calls return the
   * promise from the first call. The differential setup cache and the
   * relay/server probes also make this cheap on warm sandboxes — the
   * second `setup()` against the same sandbox does ~one round-trip of
   * work.
   */
  async setup(): Promise<void> {
    if (this.setupPromise) {
      await this.setupPromise;
      return;
    }

    debugAgent("setup() provider=%s", this.provider);
    const startedAt = Date.now();
    this.setupPromise = (async () => {
      await this.adapter.setup({
        provider: this.provider,
        options: this.options,
      });
      debugAgent(
        "setup() returned provider=%s after %dms",
        this.provider,
        Date.now() - startedAt,
      );
    })();

    try {
      await this.setupPromise;
    } catch (error) {
      // Allow callers to retry after a setup failure.
      this.setupPromise = undefined;
      throw error;
    }
  }

  /**
   * Stop the long-lived provider CLI server booted by {@link Agent.setup}
   * (claude-code relay daemon, codex app-server, opencode `serve`).
   *
   * agentbox NEVER kills a running server on its own — not on run
   * completion, not on `abort()`, and not when {@link Agent.setup} detects
   * a changed config/credential set. This method is the single, explicit,
   * developer-driven teardown. Call it to free a server's resources, or to
   * apply a changed config: after `killServer()` the next {@link setup}
   * cold-starts a fresh server with the new configuration.
   *
   * Best-effort and idempotent: a no-op when no server is running, or when
   * the provider has no shared server for the current mode (host-mode
   * claude-code runs the SDK in-process; local codex spawns a fresh
   * app-server per run, torn down with the run).
   */
  async killServer(): Promise<void> {
    debugAgent("killServer() provider=%s", this.provider);
    await this.adapter.killServer({
      provider: this.provider,
      options: this.options,
    });
    // Drop the cached setup so the next setup()/stream() re-runs against a
    // fresh server instead of short-circuiting on the now-dead one.
    this.setupPromise = undefined;
  }

  stream(runConfig: AgentRunConfig): AgentRun {
    if (this.provider !== AgentProvider.Codex &&
        (runConfig.reasoning === "max" || runConfig.reasoning === "ultra")) {
      throw new Error(`Reasoning effort "${runConfig.reasoning}" is only supported by Codex.`);
    }
    if (runConfig.resumeSessionId && runConfig.forkSessionId) {
      throw new Error(
        "AgentRunConfig.resumeSessionId and forkSessionId are mutually exclusive.",
      );
    }
    if (runConfig.forkSessionId && !runConfig.forkAtMessageId) {
      throw new Error("AgentRunConfig.forkSessionId requires forkAtMessageId.");
    }
    if (runConfig.forkAtMessageId && !runConfig.forkSessionId) {
      throw new Error("AgentRunConfig.forkAtMessageId requires forkSessionId.");
    }
    if (runConfig.resumeParked) {
      // Only a sandbox daemon, or this process for a native CLI, can keep a
      // harness alive between runs.
      if (
        this.provider !== AgentProvider.ClaudeCode ||
        (!this.options.sandbox && this.options.configuration !== "native")
      ) {
        throw new Error("AgentRunConfig.resumeParked is only supported for claude-code sandbox or native runs.");
      }
      if (!runConfig.resumeSessionId) {
        throw new Error("AgentRunConfig.resumeParked requires resumeSessionId.");
      }
    }

    const runId = runConfig.runId ?? randomUUID();
    const streamCalledAt = Date.now();
    debugAgent("stream() provider=%s runId=%s", this.provider, runId);
    const run = new AgentRunController(
      this.provider,
      runId,
      this.options.retainEvents !== false,
    );
    // `agent.setup()` is purely a side-effect (uploads artifacts +
    // boots provider servers / relay). Adapters do NOT receive its
    // return value — execute recomputes every path it needs from
    // `(provider, options, run)` and dials the relay/server using
    // deterministic constants. We wait for any in-flight setup so
    // sandbox-side prep finishes before execute starts dialing.
    const setupPromise = this.setupPromise;
    const provider = this.provider;
    const options = this.options;
    const adapter = this.adapter;

    void (async () => {
      try {
        if (setupPromise) {
          await setupPromise;
        }
        const request: AgentExecutionRequest<P> = {
          runId,
          provider,
          options,
          run: buildRunConfig(options, runConfig),
        };
        // `execute` owns the run end to end and only returns once the run has
        // settled; the abort handler is registered through the sink
        // (`AgentRunSink.setAbort`) as soon as a transport exists, which is
        // long before that. Nothing is registered here — doing so would
        // replace a live handler with one for an already-finished run.
        await adapter.execute(request, run);
        debugAgent(
          "adapter.execute() returned for runId=%s after %dms",
          runId,
          Date.now() - streamCalledAt,
        );
      } catch (error) {
        run.fail(error);
      }
    })();

    return run;
  }

  async run(runConfig: AgentRunConfig): Promise<AgentResult> {
    return this.stream(runConfig).finished;
  }

  rawEvents(runConfig: AgentRunConfig): AsyncIterable<RawAgentEvent> {
    return this.stream(runConfig).rawEvents();
  }

  /**
   * Stateless control plane for an in-flight run.
   *
   * Returns an {@link AttachedRun} whose `abort()` / `sendMessage()` methods
   * dial the in-sandbox provider server directly (codex app-server, opencode
   * HTTP server, claude-code relay control endpoint) — there is no shared
   * in-memory registry or Redis broker. Any process with the right `sandbox`
   * + `runId` (+ optional provider-native `sessionId`) can issue commands
   * against a run started on a different process.
   *
   * The originating process keeps owning the event stream that
   * `agent.stream()` returned; commands attached here cause the in-sandbox
   * server to emit the natural follow-up events (`turn/aborted`, message
   * events, etc.), which the originating process ingests through its
   * existing transport.
   *
   * The handle is short-lived: each method call opens a fresh connection,
   * performs the operation with a timeout, and tears the connection down.
   */
  static async attach<P extends AgentProviderName>(
    request: AgentAttachRequest<P>,
  ): Promise<AttachedRun> {
    const adapter = createAdapter(request.provider);
    return {
      abort: () => adapter.attachAbort(request),
      sendMessage: (content: UserContent) =>
        adapter.attachSendMessage(request, content),
    };
  }
}
