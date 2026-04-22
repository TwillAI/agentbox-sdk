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
import { ClaudeCodeAgentAdapter } from "./providers/claude-code";
import { CodexAgentAdapter } from "./providers/codex";
import { OpenCodeAgentAdapter } from "./providers/opencode";
import { AGENT_RESERVED_PORTS } from "./ports";
import {
  AgentProvider,
  type AgentExecutionRequest,
  type AgentProviderAdapter,
  type AgentProviderName,
  type AgentResult,
  type AgentRun,
  type AgentRunConfig,
  type AgentOptions,
  type AgentRunSink,
  type AgentPermissionResponse,
  type UserContent,
} from "./types";
import { normalizeUserInput } from "./input";

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
  provider: P,
  options: AgentOptions<P>,
): AgentOptions<P> {
  const ports = AGENT_RESERVED_PORTS[provider] ?? [];
  for (const port of ports) {
    // Best-effort: fire-and-forget. Most providers mutate options synchronously
    // and return a resolved promise; we rely on that to ensure the ports are
    // staged before the sandbox is first provisioned. Failures (e.g. a Modal
    // sandbox that's already running without the port) are surfaced later via
    // `openPort` itself with an actionable error message.
    void options.sandbox?.openPort(port);
  }

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
  private messageHandler?: (content: UserContent) => Promise<void>;
  private text = "";
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

  onMessage(handler: (content: UserContent) => Promise<void>): void {
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

    this.pushEvent(
      createNormalizedEvent(
        "message.injected",
        { provider: this.provider, runId: this.id },
        { content: textContent || "(non-text content)" },
      ),
    );

    await this.messageHandler(content);
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

  complete(result?: { text?: string }): void {
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
  private readonly provider: P;
  private readonly options: AgentOptions<P>;

  constructor(provider: P, options: AgentOptions<P>) {
    this.provider = provider;
    this.options = prepareAgentOptions(provider, options);
    this.adapter = createAdapter(provider);
  }

  stream(runConfig: AgentRunConfig): AgentRun {
    const runId = randomUUID();
    const run = new AgentRunController(this.provider, runId);
    const request: AgentExecutionRequest<P> = {
      runId,
      provider: this.provider,
      options: this.options,
      run: buildRunConfig(this.options, runConfig),
    };

    void (async () => {
      try {
        const cleanup = await this.adapter.execute(request, run);
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
}
