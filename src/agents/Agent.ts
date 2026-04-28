import { randomUUID } from "node:crypto";

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
  type AgentExecutionRequest,
  type AgentForkRequest,
  type AgentForkResult,
  type AgentProviderAdapter,
  type AgentProviderName,
  type AgentResult,
  type AgentRun,
  type AgentRunConfig,
  type AgentOptions,
  type AgentRunSink,
  type AgentPermissionResponse,
  type AgentSetupConfig,
  type UserContent,
  type AgentCostData,
} from "./types";
import { normalizeUserInput } from "./input";
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
  return options;
}

class AgentRunController implements AgentRun, AgentRunSink {
  readonly id: string;
  readonly provider: AgentProviderName;
  sessionId?: string;
  raw?: unknown;
  readonly sessionIdReady: Promise<string>;
  private abortHandler: () => Promise<void> = async () => undefined;
  private abortRequested = false;
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
  private costData: AgentCostData | null = null;
  private settled = false;
  readonly finished: Promise<AgentResult>;
  private readonly resolveSessionIdReady: (value: string) => void;
  private readonly rejectSessionIdReady: (reason?: unknown) => void;
  private readonly resolveFinished: (value: AgentResult) => void;
  private readonly rejectFinished: (reason?: unknown) => void;

  constructor(provider: AgentProviderName, id: string) {
    this.provider = provider;
    this.id = id;

    let resolveFinished!: (value: AgentResult) => void;
    let rejectFinished!: (reason?: unknown) => void;
    let resolveSessionIdReady!: (value: string) => void;
    let rejectSessionIdReady!: (reason?: unknown) => void;
    this.finished = new Promise<AgentResult>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    this.sessionIdReady = new Promise<string>((resolve, reject) => {
      resolveSessionIdReady = resolve;
      rejectSessionIdReady = reject;
    });
    void this.sessionIdReady.catch(() => undefined);
    this.resolveFinished = resolveFinished;
    this.rejectFinished = rejectFinished;
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

  setSessionId(sessionId: string): void {
    if (this.sessionId) {
      return;
    }

    this.sessionId = sessionId;
    this.resolveSessionIdReady(sessionId);
  }

  emitRaw(event: RawAgentEvent): void {
    this.rawEventsList.push(event);
    this.rawQueue.push(event);
  }

  private pushEvent(event: NormalizedAgentEvent): void {
    this.events.push(event);
    if (event.type === "text.delta") {
      this.text += event.delta;
    } else if (
      (event.type === "message.completed" || event.type === "run.completed") &&
      event.text
    ) {
      this.text = event.text;
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

    this.pendingPermissions.delete(response.requestId);
    const remember = pending.event.canRemember ? response.remember : undefined;
    const resolvedResponse: AgentPermissionResponse = {
      requestId: response.requestId,
      decision: response.decision,
      ...(remember !== undefined ? { remember } : {}),
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

  complete(result?: { text?: string; costData?: AgentCostData | null }): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.clearPendingPermissions(
      new Error(
        "Agent run completed before pending permission requests resolved.",
      ),
    );
    if (result?.text) {
      this.text = result.text;
    }
    if (result && "costData" in result) {
      this.costData = result.costData ?? null;
    }

    this.eventQueue.finish();
    this.rawQueue.finish();
    if (!this.sessionId) {
      const error = new Error(
        "Agent run completed before a provider session id was set.",
      );
      this.rejectSessionIdReady(error);
      this.rejectFinished(error);
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
    });
  }

  fail(error: unknown): void {
    if (this.settled) {
      return;
    }

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
    this.rejectFinished(normalizedError);
  }

  async abort(): Promise<void> {
    this.abortRequested = true;
    await this.abortHandler();
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
  async setup(config: AgentSetupConfig = {}): Promise<void> {
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
        config,
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

  stream(runConfig: AgentRunConfig): AgentRun {
    const runId = runConfig.runId ?? randomUUID();
    const streamCalledAt = Date.now();
    debugAgent("stream() provider=%s runId=%s", this.provider, runId);
    const run = new AgentRunController(this.provider, runId);
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
        const cleanup = await adapter.execute(request, run);
        debugAgent(
          "adapter.execute() returned for runId=%s after %dms",
          runId,
          Date.now() - streamCalledAt,
        );
        run.setAbort(async () => {
          await cleanup();
        });
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
   * Truncate a session at a specific user message and produce a forked
   * sessionId that can be passed to `Agent.stream({ resumeSessionId })`.
   *
   * The fork drops the message at `messageId` and everything after it. The
   * caller should start a new run with the returned sessionId and an edited
   * input which effectively replaces the dropped message.
   *
   * Like {@link Agent.stream}, `forkAt` does NOT auto-run `setup`.
   * Callers are expected to have invoked `await agent.setup()` before
   * forking on a sandbox-backed run; otherwise the underlying RPC /
   * file lookup fails naturally because the server isn't running and
   * the layout doesn't exist on disk yet.
   *
   * Provider-specific notes:
   * - **open-code**: in-place revert via `POST /session/:id/revert`.
   *   Returns the same sessionId. Reverts file changes via the OpenCode
   *   server's internal git snapshot system.
   * - **codex**: copies the thread (`thread/fork`) then drops trailing
   *   turns (`thread/rollback`). Returns a new threadId. Filesystem
   *   unchanged.
   * - **claude-code**: rewrites the JSONL session transcript under
   *   `<claudeDir>/projects/<encoded-cwd>/<sessionId>.jsonl` (the same
   *   `claudeDir` `setup()` populated and `execute()` points the CLI
   *   at via `CLAUDE_CONFIG_DIR`), keeping only ancestors of the target
   *   uuid and writing to a new sessionId file.
   */
  async forkAt(
    request: Omit<AgentForkRequest<P>, "options">,
  ): Promise<AgentForkResult> {
    return this.adapter.forkAt({
      sessionId: request.sessionId,
      messageId: request.messageId,
      options: this.options,
    });
  }
}
