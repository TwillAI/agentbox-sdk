import path from "node:path";

import {
  createNormalizedEvent,
  normalizeRawAgentEvent,
  type PermissionRequestedEvent,
  type RawAgentEvent,
} from "../../events";
import type {
  AgentExecutionRequest,
  AgentProviderAdapter,
  AgentRunSink,
} from "../types";
import { isInteractiveApproval } from "../approval";
import { mapToOpenCodeParts, validateProviderUserInput } from "../input";
import {
  assertCommandsSupported,
  buildOpenCodeCommandsConfig,
} from "../config/commands";
import {
  assertHooksSupported,
  buildOpenCodePluginArtifacts,
} from "../config/hooks";
import { buildOpenCodeMcpConfig } from "../config/mcp";
import { createRuntimeTarget } from "../config/runtime";
import { installSkills, prepareSkillArtifacts } from "../config/skills";
import { buildOpenCodeSubagentConfig } from "../config/subagents";
import { fetchJson, streamSse } from "../transports/app-server";
import { spawnCommand, waitForHttpReady } from "../transports/spawn";
import { getAvailablePort, sleep } from "../../shared/network";
import { shellQuote } from "../../shared/shell";

type OpenCodeRuntime = {
  baseUrl: string;
  /**
   * Headers to attach to every request hitting `baseUrl`. Sandbox-backed
   * runtimes pass through `sandbox.previewHeaders` here so providers like
   * Vercel can inject their Deployment Protection bypass token.
   */
  previewHeaders: Record<string, string>;
  cleanup: () => Promise<void>;
  raw: unknown;
};

const SANDBOX_OPENCODE_PORT = 4096;
const SANDBOX_OPENCODE_READY_TIMEOUT_MS = 90_000;
const SHARED_OPENCODE_TARGET_ID = "shared-opencode-server";

function toRawEvent(
  runId: string,
  payload: unknown,
  type: string,
): RawAgentEvent {
  return {
    provider: "opencode",
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
  request: AgentExecutionRequest<"opencode">,
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

function buildOpenCodeConfig(
  request: AgentExecutionRequest<"opencode">,
  interactiveApproval: boolean,
) {
  const options = request.options;
  const mcpConfig = buildOpenCodeMcpConfig(options.mcps);
  const commandsConfig = buildOpenCodeCommandsConfig(options.commands);
  return {
    $schema: "https://opencode.ai/config.json",
    ...(mcpConfig ? { mcp: mcpConfig } : {}),
    ...(commandsConfig ? { command: commandsConfig } : {}),
    agent: {
      agentbox: {
        mode: "primary",
        prompt: request.run.systemPrompt ?? "",
        permission: buildOpenCodePermissionConfig(interactiveApproval),
        tools: {
          write: true,
          edit: true,
          bash: true,
          webfetch: true,
          skill: true,
        },
      },
      ...buildOpenCodeSubagentConfig(options.subAgents),
    },
  };
}

async function ensureSandboxOpenCodeServer(
  request: AgentExecutionRequest<"opencode">,
): Promise<OpenCodeRuntime> {
  const sandbox = request.options.sandbox!;
  const options = request.options;
  const port = SANDBOX_OPENCODE_PORT;

  await sandbox.openPort(port);
  const previewHeaders = sandbox.previewHeaders;

  const healthCheck = await sandbox.run(
    `curl -fsS http://127.0.0.1:${port}/global/health >/dev/null 2>&1`,
    { cwd: options.cwd, timeoutMs: 5_000 },
  );

  if (healthCheck.exitCode === 0) {
    const baseUrl = (await sandbox.getPreviewLink(port)).replace(/\/$/, "");
    return {
      baseUrl,
      previewHeaders,
      cleanup: async () => {},
      raw: { baseUrl, port, reused: true },
    };
  }

  const plugins = assertHooksSupported(request.provider, options);
  assertCommandsSupported(request.provider, options.commands);
  const interactiveApproval = isInteractiveApproval(options);

  const target = await createRuntimeTarget(
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

  for (const artifact of [...skillArtifacts, ...pluginArtifacts]) {
    await target.writeArtifact(artifact);
  }

  const configPath = path.join(target.layout.opencodeDir, "agentbox.json");
  const openCodeConfig = buildOpenCodeConfig(request, interactiveApproval);
  await target.writeArtifact({
    path: configPath,
    content: JSON.stringify(openCodeConfig, null, 2),
  });

  const commonEnv = {
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: target.layout.opencodeDir,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  };
  await installSkills(target, installCommands, commonEnv);

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

  const launchHandle = await sandbox.runAsync(launchCommand, {
    cwd: options.cwd,
    env: serveEnv,
  });
  const launchResult = await launchHandle.wait();
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
  const readyDeadline = Date.now() + SANDBOX_OPENCODE_READY_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < readyDeadline) {
    const probe = await sandbox.run(
      `curl -fsS http://127.0.0.1:${port}/global/health >/dev/null 2>&1`,
      { cwd: options.cwd, timeoutMs: 5_000 },
    );
    if (probe.exitCode === 0) {
      ready = true;
      break;
    }
    await sleep(500);
  }
  if (!ready) {
    await target.cleanup().catch(() => undefined);
    throw new Error(
      `OpenCode server did not become ready within ${SANDBOX_OPENCODE_READY_TIMEOUT_MS}ms.`,
    );
  }

  const baseUrl = (await sandbox.getPreviewLink(port)).replace(/\/$/, "");

  return {
    baseUrl,
    previewHeaders,
    cleanup: async () => {
      await target.cleanup().catch(() => undefined);
    },
    raw: { pidFilePath, logFilePath, baseUrl, layout: target.layout, port },
  };
}

async function createLocalRuntime(
  request: AgentExecutionRequest<"opencode">,
): Promise<OpenCodeRuntime> {
  const options = request.options;
  const plugins = assertHooksSupported(request.provider, options);
  assertCommandsSupported(request.provider, options.commands);
  const interactiveApproval = isInteractiveApproval(options);

  const target = await createRuntimeTarget(
    request.provider,
    request.runId,
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

  for (const artifact of [...skillArtifacts, ...pluginArtifacts]) {
    await target.writeArtifact(artifact);
  }

  const configPath = path.join(target.layout.opencodeDir, "agentbox.json");
  const openCodeConfig = buildOpenCodeConfig(request, interactiveApproval);
  await target.writeArtifact({
    path: configPath,
    content: JSON.stringify(openCodeConfig, null, 2),
  });

  const commonEnv = {
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: target.layout.opencodeDir,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  };
  await installSkills(target, installCommands, commonEnv);

  const hostPort = await getAvailablePort();
  const processHandle = spawnCommand({
    command: options.provider?.binary ?? "opencode",
    args: [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(hostPort),
      ...(options.provider?.args ?? []),
    ],
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      ...commonEnv,
    },
  });
  const baseUrl = `http://127.0.0.1:${hostPort}`;
  await waitForHttpReady(`${baseUrl}/global/health`, { timeoutMs: 20_000 });

  return {
    baseUrl,
    previewHeaders: {},
    cleanup: async () => {
      await processHandle.kill();
      await target.cleanup();
    },
    raw: { processHandle, layout: target.layout },
  };
}

async function createRuntime(
  request: AgentExecutionRequest<"opencode">,
): Promise<OpenCodeRuntime> {
  if (request.options.sandbox) {
    return ensureSandboxOpenCodeServer(request);
  }
  return createLocalRuntime(request);
}

export class OpenCodeAgentAdapter implements AgentProviderAdapter<"opencode"> {
  async execute(
    request: AgentExecutionRequest<"opencode">,
    sink: AgentRunSink,
  ): Promise<() => Promise<void>> {
    const inputParts = await validateProviderUserInput(
      request.provider,
      request.run.input,
    );
    const runtime = await createRuntime(request);
    sink.setRaw(runtime.raw);
    sink.setAbort(runtime.cleanup);
    sink.emitEvent(
      createNormalizedEvent("run.started", {
        provider: request.provider,
        runId: request.runId,
      }),
    );

    const sseAbort = new AbortController();
    let sseTask: Promise<void> | undefined;

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

      sseTask = (async () => {
        try {
          for await (const event of streamSse(`${runtime.baseUrl}/event`, {
            headers: runtime.previewHeaders,
            signal: sseAbort.signal,
          })) {
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
            sink.emitRaw(raw);

            const eventType =
              typeof (payload as Record<string, unknown>)?.type === "string"
                ? String((payload as Record<string, unknown>).type)
                : event.event;
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

            for (const normalized of normalizeRawAgentEvent(raw)) {
              sink.emitEvent(normalized);
            }
          }
        } catch {
          // SSE is best effort; the direct response is authoritative.
        }
      })();

      sink.onMessage(async () => {
        console.warn(
          "[agentbox] sendMessage is not yet supported for the opencode provider. Use resumeSessionId for follow-ups instead.",
        );
      });

      sink.setSessionId(sessionId);
      sink.emitRaw(
        toRawEvent(
          request.runId,
          createdSession ?? { sessionId },
          request.run.resumeSessionId ? "session.resumed" : "session.created",
        ),
      );
      sink.emitEvent(
        createNormalizedEvent("message.started", {
          provider: request.provider,
          runId: request.runId,
        }),
      );

      const response = await fetchJson<unknown>(
        `${runtime.baseUrl}/session/${sessionId}/message`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...runtime.previewHeaders,
          },
          body: JSON.stringify({
            ...(request.run.model
              ? { model: toOpenCodeModel(request.run.model) }
              : {}),
            agent: "agentbox",
            parts: mapToOpenCodeParts(inputParts),
          }),
        },
      );

      const rawResponse = toRawEvent(
        request.runId,
        response,
        "message.response",
      );
      sink.emitRaw(rawResponse);
      for (const event of normalizeRawAgentEvent(rawResponse)) {
        sink.emitEvent(event);
      }

      const text = extractText(response);
      if (text) {
        sink.emitEvent(
          createNormalizedEvent(
            "text.delta",
            {
              provider: request.provider,
              runId: request.runId,
            },
            { delta: text },
          ),
        );
      }
      sink.emitEvent(
        createNormalizedEvent(
          "run.completed",
          {
            provider: request.provider,
            runId: request.runId,
          },
          { text },
        ),
      );

      sseAbort.abort();
      await sseTask;
      sink.complete({ text });
    } finally {
      sseAbort.abort();
      if (sseTask) {
        await sseTask.catch(() => undefined);
      }
      await runtime.cleanup().catch(() => undefined);
    }

    return async () => undefined;
  }
}
