import path from "node:path";

import {
  createNormalizedEvent,
  normalizeRawAgentEvent,
  type PermissionRequestedEvent,
  type RawAgentEvent,
} from "../../events";
import {
  AgentProvider,
  type AgentAttachRequest,
  type AgentExecutionRequest,
  type AgentOptions,
  type AgentProviderAdapter,
  type AgentRunSink,
  type AgentSetupRequest,
  type UserContent,
} from "../types";
import { isInteractiveApproval } from "../approval";
import {
  mapToOpenCodeParts,
  validateProviderUserInput,
  type OpenCodePromptPart,
} from "../input";
import {
  assertCommandsSupported,
  buildOpenCodeCommandsConfig,
} from "../config/commands";
import {
  assertHooksSupported,
  buildOpenCodePluginArtifacts,
} from "../config/hooks";
import { buildOpenCodeMcpConfig } from "../config/mcp";
import { createSetupTarget } from "../config/setup";
import { prepareSkillArtifacts } from "../config/skills";
import {
  applyDifferentialSetup,
  computeSetupId,
  markSetupComplete,
  preflightSetup,
} from "../config/setup-manifest";
import { buildOpenCodeSubagentConfig } from "../config/subagents";
import { fetchJson, streamSseResilient } from "../transports/app-server";
import { spawnCommand, waitForHttpReady } from "../transports/spawn";
import { sleep } from "../../shared/network";
import { shellQuote } from "../../shared/shell";
import { extractOpenCodeCostData } from "../cost";
import { debugOpencode, time } from "../../shared/debug";

/**
 * Per-call runtime handle for opencode. Built independently in `execute`
 * from the deterministic constants below — there is no setup → execute
 * data channel.
 */
type OpenCodeRuntime = {
  baseUrl: string;
  /**
   * Headers to attach to every request hitting `baseUrl`. Sandbox-backed
   * runtimes pass through `sandbox.previewHeaders` here so providers like
   * Vercel can inject their Deployment Protection bypass token.
   */
  previewHeaders: Record<string, string>;
  raw: unknown;
};

const SANDBOX_OPENCODE_PORT = 4096;
const LOCAL_OPENCODE_PORT = 4096;
const SANDBOX_OPENCODE_READY_TIMEOUT_MS = 90_000;
const LOCAL_OPENCODE_READY_TIMEOUT_MS = 20_000;
const SHARED_OPENCODE_TARGET_ID = "shared-opencode-server";

function toRawEvent(
  runId: string,
  payload: unknown,
  type: string,
): RawAgentEvent {
  return {
    provider: AgentProvider.OpenCode,
    runId,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function toOpenCodeModel(
  model: string | undefined,
): { providerID?: string; modelID: string } | undefined {
  if (!model) {
    return undefined;
  }

  const slashIndex = model.indexOf("/");
  if (slashIndex === -1) {
    return { modelID: model };
  }

  const providerID = model.slice(0, slashIndex).trim();
  const modelID = model.slice(slashIndex + 1).trim();
  if (!providerID || !modelID) {
    return { modelID: model };
  }

  return { providerID, modelID };
}

function buildOpenCodePermissionConfig(interactive: boolean) {
  if (!interactive) {
    return {
      read: { "*": "allow" },
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      external_directory: "allow",
      skill: { "*": "allow" },
      task: "allow",
    };
  }

  return {
    read: { "*": "allow" },
    edit: "ask",
    bash: "ask",
    webfetch: "ask",
    external_directory: "ask",
    skill: { "*": "allow" },
    task: "ask",
  };
}

function createOpenCodePermissionEvent(
  request: AgentExecutionRequest<"open-code">,
  raw: RawAgentEvent,
  payload: Record<string, unknown>,
): PermissionRequestedEvent {
  const properties = (payload.properties ?? {}) as Record<string, unknown>;
  const permission = String(properties.permission ?? "tool");
  return createNormalizedEvent(
    "permission.requested",
    {
      provider: request.provider,
      runId: request.runId,
      raw,
    },
    {
      requestId: String(properties.id ?? ""),
      kind:
        permission === "bash"
          ? "bash"
          : permission === "edit"
            ? "edit"
            : permission === "external_directory"
              ? "file-change"
              : permission === "webfetch"
                ? "network"
                : permission === "task"
                  ? "tool"
                  : "unknown",
      title: `Approve ${permission} permission`,
      message:
        typeof properties.metadata === "object" && properties.metadata !== null
          ? JSON.stringify(properties.metadata)
          : `OpenCode requested ${permission} permission.`,
      input: properties,
      canRemember:
        Array.isArray(properties.always) && properties.always.length > 0,
    },
  ) as PermissionRequestedEvent;
}

const OPEN_CODE_REASONING_LEVELS = ["low", "medium", "high", "xhigh"] as const;

export function openCodeAgentSlug(reasoning?: string): string {
  return reasoning ? `agentbox-${reasoning}` : "agentbox";
}

export function buildOpenCodeConfig(
  options: AgentOptions<"open-code">,
  interactiveApproval: boolean,
) {
  const mcpConfig = buildOpenCodeMcpConfig(options.mcps);
  const commandsConfig = buildOpenCodeCommandsConfig(options.commands);
  // System prompt is intentionally NOT baked into the agent here.
  // `dispatchPrompt` passes `system: request.run.systemPrompt` on the
  // POST /session/:id/prompt_async body, so changing the system prompt
  // doesn't invalidate setupId and doesn't trigger a re-setup. See:
  // https://opencode.ai/docs/server/ and packages/opencode/src/session/prompt.ts
  // (createUserMessage assigns `system: input.system`).
  const baseAgent = {
    mode: "primary",
    // Suppress opencode's default provider system prompt (e.g.
    // PROMPT_ANTHROPIC's "You are OpenCode...") so request.run.systemPrompt
    // is the dominant identity statement the model sees. opencode's
    // session/llm.ts uses agent.prompt instead of SystemPrompt.provider(model)
    // when this field is truthy — codex already takes that branch via a
    // separate options.instructions channel, so this brings anthropic et al.
    // in line. Constant value, so setupId stays stable.
    prompt: "You are an AI coding assistant. Follow the user's instructions.",
    permission: buildOpenCodePermissionConfig(interactiveApproval),
    tools: {
      write: true,
      edit: true,
      bash: true,
      webfetch: true,
      skill: true,
    },
  };
  const reasoningVariants = Object.fromEntries(
    OPEN_CODE_REASONING_LEVELS.map((level) => [
      `agentbox-${level}`,
      { ...baseAgent, reasoningEffort: level },
    ]),
  );
  const googleBaseUrl = options.env?.GOOGLE_BASE_URL;

  return {
    $schema: "https://opencode.ai/config.json",
    ...(mcpConfig ? { mcp: mcpConfig } : {}),
    ...(commandsConfig ? { command: commandsConfig } : {}),
    provider: {
      openrouter: { options: { baseURL: "https://openrouter.ai/api/v1" } },
      ...(googleBaseUrl
        ? { google: { options: { baseURL: googleBaseUrl } } }
        : {}),
    },
    agent: {
      agentbox: baseAgent,
      ...reasoningVariants,
      ...buildOpenCodeSubagentConfig(options.subAgents),
    },
  };
}

/**
 * Sandbox-side preparation for opencode (remote case). Idempotent:
 *
 *   1. Compute setupId for the artifact set + daemon expectation, then
 *      run `preflightSetup`: one no-upload sandbox.run that checks the
 *      `setup.id` marker AND probes loopback `/global/health`. If both
 *      match, return immediately — no tarball stream, no spawn.
 *   2. Cold/drifted path: upload artifacts (config, plugins, skills,
 *      sub-agent definitions) via the differential-setup manifest,
 *      spawn `opencode serve` on the static port, poll until ready,
 *      then mark setup complete.
 *
 * No return value: `execute` recomputes baseUrl from
 * `sandbox.getPreviewLink(SANDBOX_OPENCODE_PORT)` independently.
 */
async function ensureSandboxOpenCodeServer(
  request: AgentSetupRequest<"open-code">,
): Promise<void> {
  return time(debugOpencode, "ensureSandboxOpenCodeServer", async () => {
    const sandbox = request.options.sandbox!;
    const options = request.options;
    const port = SANDBOX_OPENCODE_PORT;

    const plugins = assertHooksSupported(request.provider, options);
    assertCommandsSupported(request.provider, options.commands);
    const interactiveApproval = isInteractiveApproval(options);

    const target = await createSetupTarget(
      request.provider,
      SHARED_OPENCODE_TARGET_ID,
      options,
    );

    const { artifacts: skillArtifacts, installCommands } =
      await prepareSkillArtifacts(
        request.provider,
        options.skills,
        target.layout,
      );
    const pluginArtifacts = buildOpenCodePluginArtifacts(
      plugins,
      target.layout.opencodeDir,
    );

    const configPath = path.join(target.layout.opencodeDir, "agentbox.json");
    const openCodeConfig = buildOpenCodeConfig(
      options,
      interactiveApproval,
    );
    const allArtifacts = [
      ...skillArtifacts,
      ...pluginArtifacts,
      {
        path: configPath,
        content: JSON.stringify(openCodeConfig, null, 2),
      },
    ];

    const daemonInfo = { port, healthPath: "/global/health" };
    const setupId = computeSetupId({
      artifacts: allArtifacts,
      installCommands,
      daemon: daemonInfo,
    });
    if (await preflightSetup(target, setupId, daemonInfo)) {
      debugOpencode("opencode setup() preflight hit — skipping");
      return;
    }

    const commonEnv = {
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: target.layout.opencodeDir,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    };

    await applyDifferentialSetup(target, allArtifacts, installCommands);

    const binary = options.provider?.binary ?? "opencode";
    const pidFilePath = path.posix.join(
      target.layout.rootDir,
      "opencode-serve.pid",
    );
    const logFilePath = path.posix.join(
      target.layout.rootDir,
      "opencode-serve.log",
    );
    const serveEnv = { ...(options.env ?? {}), ...commonEnv };
    const launchCommand = [
      `mkdir -p ${shellQuote(target.layout.rootDir)}`,
      `(${[
        `nohup ${[
          binary,
          "serve",
          "--hostname",
          "0.0.0.0",
          "--port",
          String(port),
          ...(options.provider?.args ?? []),
        ]
          .map(shellQuote)
          .join(" ")} > ${shellQuote(logFilePath)} 2>&1 &`,
        `echo $! > ${shellQuote(pidFilePath)}`,
      ].join(" ")})`,
    ].join(" && ");

    const launchResult = await time(
      debugOpencode,
      "spawn opencode serve",
      async () => {
        const launchHandle = await sandbox.runAsync(launchCommand, {
          cwd: options.cwd,
          env: serveEnv,
        });
        return launchHandle.wait();
      },
    );
    if (launchResult.exitCode !== 0) {
      await target.cleanup().catch(() => undefined);
      throw new Error(
        `Could not start OpenCode server: ${launchResult.combinedOutput || launchResult.stderr}`,
      );
    }

    // Poll opencode readiness from INSIDE the sandbox via curl localhost.
    // We can't poll the preview URL because some sandbox proxies (Vercel's
    // in particular) return a synthetic 200 OK with an empty body for
    // requests to ports whose listeners haven't started accepting
    // connections yet — a trivial fetch-based readiness check would get a
    // false positive while opencode is still doing its first-run DB
    // migration, and the subsequent POST /session would race the migration
    // and come back with the same empty 200.
    await time(debugOpencode, "poll opencode until ready", async () => {
      const readyDeadline = Date.now() + SANDBOX_OPENCODE_READY_TIMEOUT_MS;
      let attempt = 0;
      while (Date.now() < readyDeadline) {
        attempt++;
        const probe = await sandbox.run(
          `curl -fsS http://127.0.0.1:${port}/global/health >/dev/null 2>&1`,
          { cwd: options.cwd, timeoutMs: 5_000 },
        );
        if (probe.exitCode === 0) {
          debugOpencode("ready after %d probe attempt(s)", attempt);
          return;
        }
        await sleep(500);
      }
      await target.cleanup().catch(() => undefined);
      throw new Error(
        `OpenCode server did not become ready within ${SANDBOX_OPENCODE_READY_TIMEOUT_MS}ms.`,
      );
    });

    await markSetupComplete(target, setupId);
  });
}

/**
 * Host-side preparation for opencode (local mode). Idempotent:
 *
 *   1. Probe `127.0.0.1:LOCAL_OPENCODE_PORT/global/health`. If a
 *      previous setup() (or anything else) left a server running on
 *      the static port, return immediately.
 *   2. Cold path: build the on-disk config, spawn `opencode serve` on
 *      the static port, wait for ready.
 *
 * The spawned process is left running across runs — `execute` doesn't
 * own its lifecycle, the process is the property of the host that
 * invoked `setup()`.
 */
async function ensureLocalOpenCodeServer(
  request: AgentSetupRequest<"open-code">,
): Promise<void> {
  const options = request.options;

  try {
    await waitForHttpReady(
      `http://127.0.0.1:${LOCAL_OPENCODE_PORT}/global/health`,
      { timeoutMs: 1_000 },
    );
    debugOpencode("local opencode server already running — reusing");
    return;
  } catch {
    debugOpencode("local opencode server not running — cold-spawning");
  }

  const plugins = assertHooksSupported(request.provider, options);
  assertCommandsSupported(request.provider, options.commands);
  const interactiveApproval = isInteractiveApproval(options);

  const target = await createSetupTarget(
    request.provider,
    "shared-setup",
    options,
  );

  const { artifacts: skillArtifacts, installCommands } =
    await prepareSkillArtifacts(
      request.provider,
      options.skills,
      target.layout,
    );
  const pluginArtifacts = buildOpenCodePluginArtifacts(
    plugins,
    target.layout.opencodeDir,
  );

  const configPath = path.join(target.layout.opencodeDir, "agentbox.json");
  const openCodeConfig = buildOpenCodeConfig(options, interactiveApproval);
  const commonEnv = {
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: target.layout.opencodeDir,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  };

  const allArtifacts = [
    ...skillArtifacts,
    ...pluginArtifacts,
    {
      path: configPath,
      content: JSON.stringify(openCodeConfig, null, 2),
    },
  ];
  // Local mode already short-circuits the spawn when the host server is
  // up (waitForHttpReady at the top). The setupId check covers the
  // artifact set, so re-running with new config still triggers a
  // re-apply (the spawn would still be skipped since the server is up
  // — that's a known limitation, separate from this change).
  const setupId = computeSetupId({
    artifacts: allArtifacts,
    installCommands,
  });
  const preflightHit = await preflightSetup(target, setupId);
  if (!preflightHit) {
    await applyDifferentialSetup(target, allArtifacts, installCommands);
  }

  spawnCommand({
    command: options.provider?.binary ?? "opencode",
    args: [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(LOCAL_OPENCODE_PORT),
      ...(options.provider?.args ?? []),
    ],
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      ...commonEnv,
    },
  });

  await waitForHttpReady(
    `http://127.0.0.1:${LOCAL_OPENCODE_PORT}/global/health`,
    { timeoutMs: LOCAL_OPENCODE_READY_TIMEOUT_MS },
  );

  await markSetupComplete(target, setupId);
}

async function setupOpenCode(
  request: AgentSetupRequest<"open-code">,
): Promise<void> {
  if (request.options.sandbox) {
    await ensureSandboxOpenCodeServer(request);
    return;
  }
  await ensureLocalOpenCodeServer(request);
}

/**
 * Build the per-call runtime handle. Pure deterministic computation in
 * the local case; one cheap `sandbox.getPreviewLink` (cached inside the
 * provider adapter) in the sandbox case. Assumes the corresponding
 * server was already started by `setup()`.
 */
async function buildOpenCodeRuntime(
  options: AgentOptions<"open-code">,
): Promise<OpenCodeRuntime> {
  if (options.sandbox) {
    const sandbox = options.sandbox;
    const baseUrl = (
      await sandbox.getPreviewLink(SANDBOX_OPENCODE_PORT)
    ).replace(/\/$/, "");
    return {
      baseUrl,
      previewHeaders: sandbox.previewHeaders,
      raw: { baseUrl, port: SANDBOX_OPENCODE_PORT },
    };
  }

  const baseUrl = `http://127.0.0.1:${LOCAL_OPENCODE_PORT}`;
  return {
    baseUrl,
    previewHeaders: {},
    raw: { baseUrl, port: LOCAL_OPENCODE_PORT },
  };
}

export class OpenCodeAgentAdapter implements AgentProviderAdapter<"open-code"> {
  async setup(request: AgentSetupRequest<"open-code">): Promise<void> {
    await setupOpenCode(request);
  }

  async execute(
    request: AgentExecutionRequest<"open-code">,
    sink: AgentRunSink,
  ): Promise<() => Promise<void>> {
    const executeStartedAt = Date.now();
    debugOpencode("execute() start runId=%s", request.runId);
    const inputParts = await time(
      debugOpencode,
      "validateProviderUserInput",
      () => validateProviderUserInput(request.provider, request.run.input),
    );

    // Tracks how much text was streamed via SSE `message.part.delta`
    // events in this run. Retained as a fallback for the cancel path
    // (a cancel may pre-empt the terminal `message.updated`); the
    // success path emits `message.completed` per assistant message
    // instead, so the host's REPLACE-on-`message.completed` logic
    // surfaces only the LAST message as `result.text`.
    let streamedTextFromSse = "";
    // Per-assistant-message text buffers, keyed by `properties.messageID`
    // from `message.part.delta`. Flushed as `message.completed` events
    // when the matching `message.updated` arrives with `info.time.completed`,
    // and again on `session.idle` for any unflushed assistant messages.
    const assistantTextByMessageId = new Map<string, string>();
    const announcedAssistantCompletions = new Set<string>();
    // Cost/tokens for the run. Captured on each `message.updated`
    // SSE event for our session's assistant messages (see SSE handler
    // below) and surfaced via `sink.complete` at run end. The
    // `extractOpenCodeCostData` fallback over `rawPayloads` covers the
    // step-finish part shape if it's the only carrier.
    let dispatchError: unknown;
    let firstSseEventLogged = false;

    // The session POST endpoint is only known once the remote OpenCode server
    // is up and we've created (or resumed) a session. We install `onMessage`
    // synchronously here so that callers can call `run.sendMessage(...)` as
    // soon as they have a handle on the run, even if startup takes a while.
    // Incoming messages are buffered and flushed once `sendToSession` is
    // wired up below.
    let sendToSession: ((parts: OpenCodePromptPart[]) => void) | undefined;
    const queuedParts: OpenCodePromptPart[][] = [];

    sink.onMessage(async (content: UserContent) => {
      try {
        const parts = await validateProviderUserInput(
          request.provider,
          content,
        );
        const mapped = mapToOpenCodeParts(parts);
        if (sendToSession) {
          sendToSession(mapped);
        } else {
          queuedParts.push(mapped);
        }
      } catch (error) {
        if (!dispatchError) {
          dispatchError = error;
        }
        // Bail the wait loop so the run unwinds with the dispatch error.
        resolveSessionTerminal();
        throw error;
      }
    });

    // No setup → execute data channel: rebuild the runtime from
    // deterministic constants (preview link for sandbox, fixed
    // 127.0.0.1:LOCAL_OPENCODE_PORT for local). The opencode server
    // itself was already started by `setup()`.
    const runtime = await time(debugOpencode, "buildOpenCodeRuntime", () =>
      buildOpenCodeRuntime(request.options),
    );
    sink.setRaw(runtime.raw);
    sink.emitEvent(
      createNormalizedEvent("run.started", {
        provider: request.provider,
        runId: request.runId,
      }),
    );
    const rawPayloads: Array<Record<string, unknown>> = [];

    const sseAbort = new AbortController();
    let sseTask: Promise<void> | undefined;
    // Populated once the opencode session exists (either freshly created
    // or resumed). The abort handler closes over this ref and reads the
    // current value at call time.
    let capturedSessionId: string | undefined;
    let sessionErrorFromSse: Error | undefined;
    let sessionAbortedFromSse = false;
    // Set when SSE delivers `session.idle` for our session — opencode's
    // authoritative signal that the turn finished cleanly. Resolves
    // `sessionTerminal` and drives `sink.complete()` directly.
    let sessionIdleFromSse = false;
    let resolveSessionTerminal!: () => void;
    const sessionTerminal = new Promise<void>((resolve) => {
      resolveSessionTerminal = resolve;
    });
    // Updated on every SSE event we receive (any session, including
    // server-wide heartbeats). Used by the wait loop to detect whether
    // SSE is still alive — if events keep arriving we keep waiting for
    // a terminal signal regardless of wall-clock; if the channel goes
    // silent we eventually give up and fail the run.
    let lastSseActivityAt = Date.now();

    // Abort handler: prefer opencode's `POST /session/:id/abort` so the
    // server terminates the turn cleanly and stops billing tokens. We
    // deliberately avoid `runtime.cleanup()` here because the opencode
    // server is shared across runs (see `ensureSandboxOpenCodeServer`);
    // tearing it down would break subsequent chats. With prompt_async
    // there is no long-polling fetch to cancel — the abort propagates
    // server-side and we observe it via `session.error{MessageAborted}`
    // on the SSE stream.
    let userAbortRequested = false;
    sink.setAbort(async () => {
      userAbortRequested = true;
      const sessionIdAtAbort = capturedSessionId;
      if (sessionIdAtAbort) {
        try {
          await Promise.race([
            fetchJson<boolean>(
              `${runtime.baseUrl}/session/${sessionIdAtAbort}/abort`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...runtime.previewHeaders,
                },
              },
            ),
            new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(new Error("opencode POST /session/abort timed out")),
                3_000,
              ),
            ),
          ]);
        } catch {
          // Best-effort.
        }
      }
      // Bail the wait loop in case the SSE-side cancel signal is slow.
      resolveSessionTerminal();
    });

    try {
      const interactiveApproval = isInteractiveApproval(request.options);
      // Three branches around session resolution:
      // 1. resumeSessionId — reuse the session id directly, no HTTP call.
      // 2. forkSessionId   — POST /session/:id/fork { messageID } to slice
      //    the source session up to the chosen message and continue under
      //    a new session id.
      // 3. neither         — POST /session to create a fresh session.
      let forkedSession: { id?: string; sessionId?: string } | null = null;
      if (request.run.forkSessionId) {
        forkedSession = await fetchJson<{ id?: string; sessionId?: string }>(
          `${runtime.baseUrl}/session/${encodeURIComponent(request.run.forkSessionId)}/fork`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...runtime.previewHeaders,
            },
            body: JSON.stringify({
              messageID: request.run.forkAtMessageId,
            }),
          },
        );
      }
      const createdSession =
        request.run.resumeSessionId || forkedSession
          ? null
          : await fetchJson<{ id?: string; sessionId?: string }>(
              `${runtime.baseUrl}/session`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...runtime.previewHeaders,
                },
                body: JSON.stringify({
                  title: `AgentBox ${request.runId}`,
                }),
              },
            );
      const sessionId =
        request.run.resumeSessionId ??
        forkedSession?.id ??
        forkedSession?.sessionId ??
        createdSession?.id ??
        createdSession?.sessionId;
      if (!sessionId) {
        throw new Error("OpenCode did not return a session id.");
      }

      const announcedUserMessageIds = new Set<string>();
      // Tracks message ids the SSE bus has reported as belonging to a
      // *different* session. The OpenCode `/event` stream is server-wide,
      // so when multiple concurrent runs share a sandbox each run's
      // listener observes every session's `message.part.delta` events.
      // Deltas don't always carry `sessionID`, so we use this set as a
      // fallback filter: any delta whose `messageID` is known-foreign
      // gets dropped. Deltas with unknown messageIDs default to allowed,
      // since assistant deltas can arrive before that message's own
      // `message.updated` notification reaches us.
      const foreignMessageIds = new Set<string>();
      sseTask = (async () => {
        try {
          for await (const event of streamSseResilient(
            `${runtime.baseUrl}/event`,
            {
              headers: runtime.previewHeaders,
              signal: sseAbort.signal,
            },
          )) {
            lastSseActivityAt = Date.now();
            if (!firstSseEventLogged) {
              firstSseEventLogged = true;
              debugOpencode(
                "★ first SSE event (%dms since execute start) type=%s",
                Date.now() - executeStartedAt,
                event.event,
              );
            }
            let payload: unknown = event.data;
            try {
              payload = JSON.parse(event.data);
            } catch {
              // Preserve raw text payloads when event data is not JSON.
            }

            const raw = toRawEvent(
              request.runId,
              payload,
              `sse:${event.event ?? "message"}`,
            );
            if (
              payload &&
              typeof payload === "object" &&
              !Array.isArray(payload)
            ) {
              rawPayloads.push(payload as Record<string, unknown>);
            }
            sink.emitRaw(raw);

            const eventType =
              typeof (payload as Record<string, unknown>)?.type === "string"
                ? String((payload as Record<string, unknown>).type)
                : event.event;

            // Surface each user message id as a `message.started` event so
            // callers can correlate user bubbles with provider message ids.
            if (eventType === "message.updated") {
              const properties = (payload as Record<string, unknown>)
                .properties as Record<string, unknown> | undefined;
              const info = properties?.info as
                | Record<string, unknown>
                | undefined;
              if (
                info &&
                typeof info.id === "string" &&
                typeof info.sessionID === "string"
              ) {
                if (info.sessionID !== sessionId) {
                  foreignMessageIds.add(info.id);
                } else if (
                  info.role === "user" &&
                  !announcedUserMessageIds.has(info.id)
                ) {
                  announcedUserMessageIds.add(info.id);
                  sink.emitEvent(
                    createNormalizedEvent(
                      "message.started",
                      {
                        provider: request.provider,
                        runId: request.runId,
                        raw,
                      },
                      { messageId: info.id },
                    ),
                  );
                } else if (
                  info.role === "assistant" &&
                  !announcedAssistantCompletions.has(info.id)
                ) {
                  const time = info.time as
                    | Record<string, unknown>
                    | undefined;
                  if (typeof time?.completed === "number") {
                    announcedAssistantCompletions.add(info.id);
                    sink.emitEvent(
                      createNormalizedEvent(
                        "message.completed",
                        {
                          provider: request.provider,
                          runId: request.runId,
                          raw,
                        },
                        { text: assistantTextByMessageId.get(info.id) ?? "" },
                      ),
                    );
                  }
                }
              }
            }
            if (eventType === "permission.asked") {
              const properties = (payload as Record<string, unknown>)
                .properties as Record<string, unknown> | undefined;
              if (
                properties &&
                typeof properties.sessionID === "string" &&
                properties.sessionID === sessionId
              ) {
                const permissionEvent = createOpenCodePermissionEvent(
                  request,
                  raw,
                  payload as Record<string, unknown>,
                );
                const response = interactiveApproval
                  ? await sink.requestPermission(permissionEvent)
                  : {
                      requestId: permissionEvent.requestId,
                      decision: "allow" as const,
                    };

                await fetchJson<boolean>(
                  `${runtime.baseUrl}/session/${sessionId}/permissions/${permissionEvent.requestId}`,
                  {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      ...runtime.previewHeaders,
                    },
                    body: JSON.stringify({
                      response:
                        response.decision === "allow"
                          ? response.remember
                            ? "always"
                            : "once"
                          : "reject",
                    }),
                  },
                );
              }
              continue;
            }

            const payloadRecord =
              payload && typeof payload === "object" && !Array.isArray(payload)
                ? (payload as Record<string, unknown>)
                : null;

            // OpenCode signals end-of-turn via `session.idle` on the SSE
            // bus. We abort the in-flight `POST /session/:id/message`
            // OpenCode signals end-of-turn via `session.idle` (and the
            // modern `session.status{type:"idle"}`) on the SSE bus.
            // This is the authoritative completion signal — the SDK
            // dispatches via `POST /prompt_async` (fire-and-forget,
            // 204), so SSE is the only channel telling us a turn is
            // done.
            if (
              payloadRecord?.type === "session.idle" ||
              payloadRecord?.type === "session.error"
            ) {
              const properties = payloadRecord.properties as
                | Record<string, unknown>
                | undefined;
              const eventSessionId =
                typeof properties?.sessionID === "string"
                  ? properties.sessionID
                  : undefined;
              if (!eventSessionId || eventSessionId === sessionId) {
                if (payloadRecord.type === "session.error") {
                  const errData = properties?.error as
                    | Record<string, unknown>
                    | undefined;
                  if (errData?.name === "MessageAbortedError") {
                    // opencode reports user-initiated (or server-side)
                    // message abort as MessageAbortedError — treat as cancel.
                    sessionAbortedFromSse = true;
                  } else {
                    const errMsg =
                      typeof (errData?.data as Record<string, unknown>)
                        ?.message === "string"
                        ? ((errData!.data as Record<string, unknown>)
                            .message as string)
                        : typeof errData?.message === "string"
                          ? (errData.message as string)
                          : "OpenCode session error";
                    sessionErrorFromSse = new Error(errMsg);
                  }
                } else {
                  sessionIdleFromSse = true;
                }
                debugOpencode(
                  "★ %s for session=%s",
                  payloadRecord.type,
                  sessionId,
                );
                resolveSessionTerminal();
              }
            }
            // Modern terminal signal: `session.status` with type idle.
            // Fires alongside the deprecated `session.idle`; we accept
            // either.
            if (payloadRecord?.type === "session.status") {
              const properties = payloadRecord.properties as
                | Record<string, unknown>
                | undefined;
              const status = properties?.status as
                | Record<string, unknown>
                | undefined;
              const eventSessionId =
                typeof properties?.sessionID === "string"
                  ? properties.sessionID
                  : undefined;
              if (
                (!eventSessionId || eventSessionId === sessionId) &&
                status?.type === "idle"
              ) {
                sessionIdleFromSse = true;
                debugOpencode(
                  "★ session.status{idle} for session=%s",
                  sessionId,
                );
                resolveSessionTerminal();
              }
            }

            if (payloadRecord?.type === "message.part.delta") {
              const properties = payloadRecord.properties as
                | Record<string, unknown>
                | undefined;
              // The OpenCode `/event` bus is server-wide; concurrent runs
              // sharing a sandbox each receive every other session's
              // deltas. Drop foreign deltas using `properties.sessionID`
              // when present, else fall back to the messageID set built
              // from `message.updated` (which always carries sessionID).
              const eventSessionId =
                typeof properties?.sessionID === "string"
                  ? properties.sessionID
                  : undefined;
              const eventMessageId =
                typeof properties?.messageID === "string"
                  ? properties.messageID
                  : undefined;
              const isForeignSession =
                (eventSessionId !== undefined &&
                  eventSessionId !== sessionId) ||
                (eventSessionId === undefined &&
                  eventMessageId !== undefined &&
                  foreignMessageIds.has(eventMessageId));
              if (isForeignSession) {
                continue;
              }
              const delta =
                typeof properties?.delta === "string" ? properties.delta : "";
              if (delta && properties?.field === "text") {
                streamedTextFromSse += delta;
                if (eventMessageId) {
                  assistantTextByMessageId.set(
                    eventMessageId,
                    (assistantTextByMessageId.get(eventMessageId) ?? "") +
                      delta,
                  );
                }
                sink.emitEvent(
                  createNormalizedEvent(
                    "text.delta",
                    {
                      provider: request.provider,
                      runId: request.runId,
                      raw,
                    },
                    { delta },
                  ),
                );
              } else if (
                delta &&
                (properties?.field === "reasoning" ||
                  properties?.field === "thinking")
              ) {
                sink.emitEvent(
                  createNormalizedEvent(
                    "reasoning.delta",
                    {
                      provider: request.provider,
                      runId: request.runId,
                      raw,
                    },
                    { delta },
                  ),
                );
              }
            } else {
              for (const normalized of normalizeRawAgentEvent(raw)) {
                sink.emitEvent(normalized);
              }
            }
          }
        } catch {
          // SSE is best effort; the direct response is authoritative.
        }
      })();

      capturedSessionId = sessionId;
      sink.setSessionId(sessionId);
      sink.emitRaw(
        toRawEvent(
          request.runId,
          createdSession ?? { sessionId },
          request.run.resumeSessionId ? "session.resumed" : "session.created",
        ),
      );
      if (createdSession) {
        rawPayloads.push(createdSession);
      }
      sink.emitEvent(
        createNormalizedEvent("message.started", {
          provider: request.provider,
          runId: request.runId,
        }),
      );

      const agentSlug = openCodeAgentSlug(request.run.reasoning);

      // Fire-and-forget dispatch via opencode's async prompt endpoint.
      // The server enqueues the turn and returns 204 immediately —
      // results flow exclusively through the SSE event stream we're
      // already consuming. One retry on transport failure; if both
      // attempts fail we surface the error and the run unwinds.
      //
      // This replaces the old `POST /session/:id/message` long-polling
      // call, which held the HTTP connection open for the entire
      // turn. That design was the unique source of `fetch failed`
      // errors when sandbox networks dropped multi-minute connections;
      // prompt_async eliminates that whole class of failure.
      const dispatchPrompt = async (
        parts: OpenCodePromptPart[],
      ): Promise<void> => {
        const body = JSON.stringify({
          ...(request.run.model
            ? { model: toOpenCodeModel(request.run.model) }
            : {}),
          // Per-message system prompt — keeps systemPrompt out of
          // the on-disk agent config so changing it doesn't
          // invalidate setupId. Sent on every dispatch (the field
          // is per-message, not session-sticky).
          ...(request.run.systemPrompt
            ? { system: request.run.systemPrompt }
            : {}),
          agent: agentSlug,
          parts,
        });
        const url = `${runtime.baseUrl}/session/${sessionId}/prompt_async`;

        const attempt = async (): Promise<Response> => {
          return fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...runtime.previewHeaders,
            },
            body,
          });
        };

        let lastError: unknown;
        for (let i = 0; i < 2; i++) {
          try {
            const response = await attempt();
            if (response.ok || response.status === 204) {
              return;
            }
            lastError = new Error(
              `POST ${url} returned ${response.status}`,
            );
          } catch (error) {
            lastError = error;
          }
          if (i === 0) {
            debugOpencode(
              "prompt_async dispatch attempt %d failed (%s); retrying once",
              i + 1,
              (lastError as Error)?.message ?? String(lastError),
            );
            await sleep(500);
          }
        }
        throw lastError instanceof Error
          ? lastError
          : new Error(String(lastError));
      };

      // OpenCode queues concurrent prompts on the same session, so
      // mid-run injections via `run.sendMessage(...)` reuse the same
      // endpoint as the initial turn.
      sendToSession = (parts) => {
        void (async () => {
          try {
            await dispatchPrompt(parts);
          } catch (error) {
            if (!dispatchError) {
              dispatchError = error;
            }
            // Bail the wait loop so the run fails promptly.
            resolveSessionTerminal();
          }
        })();
      };

      // Flush any messages that arrived via `run.sendMessage(...)` before the
      // session was ready. They become additional queued turns alongside the
      // initial input.
      for (const queued of queuedParts.splice(0)) {
        sendToSession(queued);
      }

      // Initial dispatch. We await this one because if it fails we
      // want to surface the error before entering the wait loop.
      try {
        await dispatchPrompt(mapToOpenCodeParts(inputParts));
      } catch (error) {
        if (!dispatchError) {
          dispatchError = error;
        }
        resolveSessionTerminal();
      }

      // Wait for the SSE-driven terminal signal. As long as SSE keeps
      // producing events (deltas, heartbeats, anything) we keep
      // waiting; if the channel goes silent for the threshold window
      // we give up and fail the run. The consumer (e.g. Twill) is
      // responsible for resuming via `resumeSessionId` if needed —
      // the SDK does not attempt to recover lost state on its own.
      const SSE_SILENCE_THRESHOLD_MS = 180_000; // 3 min of no events = dead
      const SSE_POLL_INTERVAL_MS = 5_000;
      lastSseActivityAt = Date.now();
      let sseSilent = false;
      while (
        !sessionIdleFromSse &&
        !sessionErrorFromSse &&
        !sessionAbortedFromSse &&
        !userAbortRequested &&
        !dispatchError
      ) {
        const silence = Date.now() - lastSseActivityAt;
        if (silence > SSE_SILENCE_THRESHOLD_MS) {
          sseSilent = true;
          debugOpencode("SSE went silent (%dms) — giving up", silence);
          break;
        }
        await Promise.race([
          sessionTerminal,
          new Promise<void>((resolve) =>
            setTimeout(resolve, SSE_POLL_INTERVAL_MS),
          ),
        ]);
      }

      sseAbort.abort();
      await sseTask;

      if (userAbortRequested || sessionAbortedFromSse) {
        debugOpencode(
          "★ run.cancelled (%dms since execute start)",
          Date.now() - executeStartedAt,
        );
        sink.cancel({
          text: streamedTextFromSse || undefined,
          costData: extractOpenCodeCostData(rawPayloads),
        });
      } else if (sessionErrorFromSse) {
        sink.fail(sessionErrorFromSse);
      } else if (dispatchError) {
        sink.fail(dispatchError);
      } else if (sessionIdleFromSse) {
        debugOpencode(
          "★ run.completed (%dms since execute start) chars=%d",
          Date.now() - executeStartedAt,
          streamedTextFromSse.length,
        );
        // Flush any assistant message buffers that didn't receive a
        // terminal `message.updated{info.time.completed}` before
        // `session.idle`. Map iteration order is insertion order, so
        // the LAST emitted `message.completed` is the most recent
        // assistant message — exactly the REPLACE target the host
        // uses to settle `result.text`.
        let lastAssistantText = "";
        for (const [messageId, text] of assistantTextByMessageId) {
          lastAssistantText = text;
          if (!announcedAssistantCompletions.has(messageId)) {
            announcedAssistantCompletions.add(messageId);
            sink.emitEvent(
              createNormalizedEvent(
                "message.completed",
                {
                  provider: request.provider,
                  runId: request.runId,
                },
                { text },
              ),
            );
          }
        }
        sink.emitEvent(
          createNormalizedEvent(
            "run.completed",
            {
              provider: request.provider,
              runId: request.runId,
            },
            { text: lastAssistantText },
          ),
        );
        sink.complete({
          text: lastAssistantText,
          costData: extractOpenCodeCostData(rawPayloads),
        });
      } else if (sseSilent) {
        sink.fail(
          new Error(
            "opencode SSE went silent before the session reached idle",
          ),
        );
      } else {
        sink.fail(
          new Error("opencode run ended without a terminal signal"),
        );
      }
    } finally {
      sseAbort.abort();
      if (sseTask) {
        await sseTask.catch(() => undefined);
      }
      // No runtime cleanup: the opencode server is shared across runs
      // (started by setup() once). Per-run state (SSE task) is torn
      // down via the abort controller above.
    }

    return async () => undefined;
  }

  /**
   * Stateless abort. Resolve the in-sandbox base URL via
   * `sandbox.getPreviewLink` and POST to `/session/:id/abort`. Best-effort:
   * a 3s timeout protects against an unresponsive server, and any error
   * is swallowed since the originating run will tear itself down once
   * the server-side abort takes effect.
   */
  async attachAbort(request: AgentAttachRequest<"open-code">): Promise<void> {
    if (!request.sessionId) {
      throw new Error(
        `Cannot attachAbort to opencode run ${request.runId}: sessionId is required.`,
      );
    }
    const baseUrl = (
      await request.sandbox.getPreviewLink(SANDBOX_OPENCODE_PORT)
    ).replace(/\/$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      await fetch(`${baseUrl}/session/${request.sessionId}/abort`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...request.sandbox.previewHeaders,
        },
      }).catch((error) => {
        debugOpencode(
          "attachAbort runId=%s POST /abort failed: %o",
          request.runId,
          error,
        );
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Stateless message injection. Fire-and-forget POST to
   * `/session/:id/prompt_async` (returns 204) — opencode appends the
   * message to the running session and the originating instance picks
   * up the new turn through its existing SSE stream.
   */
  async attachSendMessage(
    request: AgentAttachRequest<"open-code">,
    content: UserContent,
  ): Promise<void> {
    if (!request.sessionId) {
      throw new Error(
        `Cannot attachSendMessage to opencode run ${request.runId}: sessionId is required.`,
      );
    }
    const baseUrl = (
      await request.sandbox.getPreviewLink(SANDBOX_OPENCODE_PORT)
    ).replace(/\/$/, "");
    const inputParts = await validateProviderUserInput(
      AgentProvider.OpenCode,
      content,
    );
    const parts = mapToOpenCodeParts(inputParts);
    const url = `${baseUrl}/session/${request.sessionId}/prompt_async`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...request.sandbox.previewHeaders,
      },
      body: JSON.stringify({
        agent: openCodeAgentSlug(undefined),
        parts,
      }),
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(`POST ${url} returned ${response.status}`);
    }
  }
}
