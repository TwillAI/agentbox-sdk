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
import { applyDifferentialSetup } from "../config/setup-manifest";
import { buildOpenCodeSubagentConfig } from "../config/subagents";
import { fetchJson, streamSse } from "../transports/app-server";
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

function extractText(value: unknown): string {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("");
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;

    if (record.type === "text" && typeof record.text === "string") {
      return record.text;
    }

    if (record.type === "reasoning") {
      return "";
    }

    if (record.message) {
      return extractText(record.message);
    }

    if (record.content) {
      return extractText(record.content);
    }

    if (record.parts) {
      return extractText(record.parts);
    }

    if (record.text) {
      return extractText(record.text);
    }
  }

  return "";
}

function extractAssistantMessageId(response: unknown): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const record = response as Record<string, unknown>;
  const info =
    record.info && typeof record.info === "object"
      ? (record.info as Record<string, unknown>)
      : record.message && typeof record.message === "object"
        ? (record.message as Record<string, unknown>)
        : undefined;
  const id = info?.id ?? record.id;
  return typeof id === "string" ? id : undefined;
}

function extractReasoning(value: unknown): string {
  if (!value) {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map(extractReasoning).filter(Boolean).join("");
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;

    if (record.type === "reasoning") {
      if (typeof record.text === "string") {
        return record.text;
      }
      if (typeof record.reasoning === "string") {
        return record.reasoning;
      }
    }

    return [
      extractReasoning(record.message),
      extractReasoning(record.content),
      extractReasoning(record.parts),
    ]
      .filter(Boolean)
      .join("");
  }

  return "";
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
  systemPrompt: string,
  interactiveApproval: boolean,
) {
  const mcpConfig = buildOpenCodeMcpConfig(options.mcps);
  const commandsConfig = buildOpenCodeCommandsConfig(options.commands);
  const baseAgent = {
    mode: "primary",
    prompt: systemPrompt,
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
  return {
    $schema: "https://opencode.ai/config.json",
    ...(mcpConfig ? { mcp: mcpConfig } : {}),
    ...(commandsConfig ? { command: commandsConfig } : {}),
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
 *   1. Probe `127.0.0.1:SANDBOX_OPENCODE_PORT/global/health` from
 *      inside the sandbox. If the previous setup() left the server
 *      running, return immediately.
 *   2. Cold path: upload artifacts (config, plugins, skills, sub-agent
 *      definitions) via the differential-setup manifest, spawn
 *      `opencode serve` on the static port, poll until ready.
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

    // OpenCode server port is expected to be pre-declared at sandbox
    // creation time (`AGENT_RESERVED_PORTS["open-code"]` -> 4096).
    const healthCheck = await time(
      debugOpencode,
      "health probe (warm path)",
      () =>
        sandbox.run(
          `curl -fsS http://127.0.0.1:${port}/global/health >/dev/null 2>&1`,
          { cwd: options.cwd, timeoutMs: 5_000 },
        ),
    );

    if (healthCheck.exitCode === 0) {
      debugOpencode("opencode server already running — reusing");
      return;
    }
    debugOpencode("opencode server not running — cold-spawning");

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
      request.config.systemPrompt ?? "",
      interactiveApproval,
    );
    const commonEnv = {
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: target.layout.opencodeDir,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    };

    await applyDifferentialSetup(
      target,
      [
        ...skillArtifacts,
        ...pluginArtifacts,
        {
          path: configPath,
          content: JSON.stringify(openCodeConfig, null, 2),
        },
      ],
      installCommands,
    );

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
  const openCodeConfig = buildOpenCodeConfig(
    options,
    request.config.systemPrompt ?? "",
    interactiveApproval,
  );
  const commonEnv = {
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: target.layout.opencodeDir,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  };

  await applyDifferentialSetup(
    target,
    [
      ...skillArtifacts,
      ...pluginArtifacts,
      {
        path: configPath,
        content: JSON.stringify(openCodeConfig, null, 2),
      },
    ],
    installCommands,
  );

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

    let pendingMessages = 0;
    let finalText = "";
    // Tracks how much text was streamed via SSE `message.part.delta`
    // events in this run. Used downstream to decide what portion of the
    // dispatch-response final text still needs to be emitted as a
    // `text.delta` (everything SSE missed) without double-emitting what
    // SSE already delivered.
    let streamedTextFromSse = "";
    // Once a dispatch has settled and emitted the final text, suppress
    // subsequent SSE text deltas for that same assistant message —
    // OpenCode sometimes flushes the trailing deltas after the POST
    // resolves, which would re-add text already covered by the
    // dispatch-side emission.
    const settledMessageIds = new Set<string>();
    let dispatchError: unknown;
    let firstSseEventLogged = false;
    let resolveAllDone!: () => void;
    const allDone = new Promise<void>((resolve) => {
      resolveAllDone = resolve;
    });
    const checkDone = () => {
      if (pendingMessages === 0) {
        resolveAllDone();
      }
    };

    // The session POST endpoint is only known once the remote OpenCode server
    // is up and we've created (or resumed) a session. We install `onMessage`
    // synchronously here so that callers can call `run.sendMessage(...)` as
    // soon as they have a handle on the run, even if startup takes a while.
    // Incoming messages are buffered and flushed once `sendToSession` is
    // wired up below.
    let sendToSession: ((parts: OpenCodePromptPart[]) => void) | undefined;
    const queuedParts: OpenCodePromptPart[][] = [];

    sink.onMessage(async (content: UserContent) => {
      pendingMessages++;
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
        pendingMessages--;
        if (!dispatchError) {
          dispatchError = error;
        }
        checkDone();
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
    // AbortController wired into every POST /session/:id/message fetch so a
    // Stop from the caller actually tears down the long-polling message
    // request. Without this, the HTTP POST silently keeps streaming even
    // after `run.abort()` because opencode's message endpoint doesn't
    // return until the turn finishes on the server side.
    const dispatchAbort = new AbortController();
    // Populated once the opencode session exists (either freshly created
    // or resumed). The abort handler closes over this ref and reads the
    // current value at call time.
    let capturedSessionId: string | undefined;

    // Abort handler: prefer opencode's `POST /session/:id/abort` so the
    // server terminates the turn cleanly and stops billing tokens. Then
    // abort any in-flight POST /message so the adapter unwinds instead
    // of hanging on the long-polling fetch. We deliberately avoid
    // `runtime.cleanup()` here because the opencode server is shared
    // across runs (see `ensureSandboxOpenCodeServer`); tearing it down
    // would break subsequent chats.
    sink.setAbort(async () => {
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
          // Best-effort; still abort the pending fetch below so the
          // run doesn't hang even if the abort RPC failed.
        }
      }
      dispatchAbort.abort();
    });

    try {
      const interactiveApproval = isInteractiveApproval(request.options);
      const createdSession = request.run.resumeSessionId
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
          for await (const event of streamSse(`${runtime.baseUrl}/event`, {
            headers: runtime.previewHeaders,
            signal: sseAbort.signal,
          })) {
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
            // here so the originating instance unwinds promptly when an
            // external `Agent.attach({...}).abort()` -> server `/abort`
            // happens — the server is sometimes slow to close the POST
            // connection on its own (see opencode issue #20095). For
            // natural completion this is a no-op: the POST has already
            // resolved by the time `session.idle` arrives.
            if (
              (payloadRecord?.type === "session.idle" ||
                payloadRecord?.type === "session.error") &&
              !dispatchAbort.signal.aborted
            ) {
              const properties = payloadRecord.properties as
                | Record<string, unknown>
                | undefined;
              const eventSessionId =
                typeof properties?.sessionID === "string"
                  ? properties.sessionID
                  : undefined;
              if (!eventSessionId || eventSessionId === sessionId) {
                debugOpencode(
                  "★ %s for session=%s — aborting in-flight dispatch",
                  payloadRecord.type,
                  sessionId,
                );
                dispatchAbort.abort();
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
              if (
                eventMessageId !== undefined &&
                settledMessageIds.has(eventMessageId)
              ) {
                continue;
              }
              const delta =
                typeof properties?.delta === "string" ? properties.delta : "";
              if (delta && properties?.field === "text") {
                streamedTextFromSse += delta;
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

      const dispatchMessage = async (
        parts: OpenCodePromptPart[],
      ): Promise<void> => {
        // Snapshot the SSE-accumulated text length before the POST so
        // we can tell whether THIS dispatch produced any streaming
        // deltas — independently of earlier turns in the same run. If
        // the length didn't grow by the time the POST resolves, SSE
        // was silent for this turn and we still need to surface the
        // response's full text via a `text.delta`.
        const sseTextLengthBeforeDispatch = streamedTextFromSse.length;
        try {
          const response = await fetchJson<unknown>(
            `${runtime.baseUrl}/session/${sessionId}/message`,
            {
              method: "POST",
              signal: dispatchAbort.signal,
              headers: {
                "content-type": "application/json",
                ...runtime.previewHeaders,
              },
              body: JSON.stringify({
                ...(request.run.model
                  ? { model: toOpenCodeModel(request.run.model) }
                  : {}),
                agent: agentSlug,
                parts,
              }),
            },
          );

          const rawResponse = toRawEvent(
            request.runId,
            response,
            "message.response",
          );
          if (
            response &&
            typeof response === "object" &&
            !Array.isArray(response)
          ) {
            rawPayloads.push(response as Record<string, unknown>);
          }
          sink.emitRaw(rawResponse);
          for (const event of normalizeRawAgentEvent(rawResponse)) {
            sink.emitEvent(event);
          }

          const reasoning = extractReasoning(response);
          if (reasoning) {
            sink.emitEvent(
              createNormalizedEvent(
                "reasoning.delta",
                {
                  provider: request.provider,
                  runId: request.runId,
                  raw: rawResponse,
                },
                { delta: reasoning },
              ),
            );
          }

          const text = extractText(response);
          if (text) {
            finalText = text;
            // SSE may have streamed any prefix of this turn's text
            // before the POST resolved (or none at all when the server
            // flushed the response synchronously). Compute what's
            // missing and emit just that suffix as a `text.delta`,
            // avoiding both duplication and dropped trailing text.
            const sseTextForThisDispatch = streamedTextFromSse.slice(
              sseTextLengthBeforeDispatch,
            );
            let missing: string;
            if (text.startsWith(sseTextForThisDispatch)) {
              missing = text.slice(sseTextForThisDispatch.length);
            } else if (sseTextForThisDispatch.length === 0) {
              missing = text;
            } else {
              missing = "";
            }
            if (missing.length > 0) {
              streamedTextFromSse += missing;
              sink.emitEvent(
                createNormalizedEvent(
                  "text.delta",
                  {
                    provider: request.provider,
                    runId: request.runId,
                  },
                  { delta: missing },
                ),
              );
            }
            // Block any post-dispatch SSE flush for this assistant
            // message from re-emitting text we just covered.
            const assistantMessageId = extractAssistantMessageId(response);
            if (assistantMessageId) {
              settledMessageIds.add(assistantMessageId);
            }
          }
        } catch (error) {
          if (!dispatchError) {
            dispatchError = error;
          }
        } finally {
          pendingMessages--;
          checkDone();
        }
      };

      // OpenCode queues concurrent POSTs to `/session/:id/message` (see
      // https://github.com/sst/opencode/issues/931), so mid-run injections can
      // reuse the same endpoint as the initial turn. Each POST resolves with
      // its own turn's assistant response.
      sendToSession = (parts) => {
        void dispatchMessage(parts);
      };

      // Flush any messages that arrived via `run.sendMessage(...)` before the
      // session was ready. They now become additional queued turns alongside
      // the initial input.
      for (const queued of queuedParts.splice(0)) {
        sendToSession(queued);
      }

      pendingMessages++;
      void dispatchMessage(mapToOpenCodeParts(inputParts));

      await allDone;

      // Treat dispatchAbort-induced errors as a clean termination: an
      // abort is the explicit "stop this turn" signal (either in-process
      // `run.abort()` or remote `Agent.attach({...}).abort()` whose
      // server-side `/abort` we then mirror locally via the SSE
      // `session.idle` listener above). Bubbling the AbortError as a
      // run failure was wrong — it surfaced a fake "OpenCode failed"
      // every time a user pressed Stop.
      if (dispatchError && !dispatchAbort.signal.aborted) {
        throw dispatchError;
      }

      debugOpencode(
        "★ run.completed (%dms since execute start) chars=%d",
        Date.now() - executeStartedAt,
        finalText.length,
      );
      sink.emitEvent(
        createNormalizedEvent(
          "run.completed",
          {
            provider: request.provider,
            runId: request.runId,
          },
          { text: finalText },
        ),
      );

      sseAbort.abort();
      await sseTask;
      sink.complete({
        text: finalText,
        costData: extractOpenCodeCostData(rawPayloads),
      });
    } finally {
      sseAbort.abort();
      if (sseTask) {
        await sseTask.catch(() => undefined);
      }
      // No runtime cleanup: the opencode server is shared across runs
      // (started by setup() once). Per-run state (HTTP fetches, SSE
      // task) is torn down via the abort controllers above.
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
   * Stateless message injection. POST a fresh user message to
   * `/session/:id/message` with `agent` defaulting to the build agent
   * — opencode appends it to the running session and the originating
   * instance picks up the new turn through its existing SSE stream.
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
    await fetchJson<unknown>(
      `${baseUrl}/session/${request.sessionId}/message`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...request.sandbox.previewHeaders,
        },
        body: JSON.stringify({
          agent: openCodeAgentSlug(undefined),
          parts,
        }),
      },
    );
  }
}
