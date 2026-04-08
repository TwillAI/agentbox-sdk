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
import { assertHooksSupported } from "../config/hooks";
import { buildOpenCodeMcpConfig } from "../config/mcp";
import { createRuntimeTarget } from "../config/runtime";
import { installSkills, prepareSkillArtifacts } from "../config/skills";
import { buildOpenCodeSubagentConfig } from "../config/subagents";
import { fetchJson, streamSse } from "../transports/app-server";
import { spawnCommand, waitForHttpReady } from "../transports/spawn";
import { getAvailablePort } from "../../shared/network";

type OpenCodeRuntime = {
  baseUrl: string;
  cleanup: () => Promise<void>;
  raw: unknown;
  configPath?: string;
};

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

function buildAuthHeaders(
  options: AgentExecutionRequest<"opencode">["options"],
): HeadersInit | undefined {
  const password = options.provider?.password;
  if (!password) {
    return undefined;
  }

  const username = options.provider?.username ?? "opencode";
  const token = Buffer.from(`${username}:${password}`).toString("base64");
  return {
    Authorization: `Basic ${token}`,
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

async function createRuntime(
  request: AgentExecutionRequest<"opencode">,
): Promise<OpenCodeRuntime> {
  if (
    request.options.provider?.serverUrl &&
    ((request.options.mcps?.length ?? 0) > 0 ||
      (request.options.skills?.length ?? 0) > 0 ||
      (request.options.subAgents?.length ?? 0) > 0 ||
      (request.options.commands?.length ?? 0) > 0 ||
      (request.options.hooks?.length ?? 0) > 0)
  ) {
    throw new Error(
      "OpenCode serverUrl mode does not support OpenAgent-managed MCPs, skills, sub-agents, hooks, or commands. Start the runtime through OpenAgent instead.",
    );
  }

  if (request.options.provider?.serverUrl) {
    return {
      baseUrl: request.options.provider.serverUrl.replace(/\/$/, ""),
      cleanup: async () => undefined,
      raw: { serverUrl: request.options.provider.serverUrl },
    };
  }

  const options = request.options;
  assertHooksSupported(request.provider, options.hooks);
  assertCommandsSupported(request.provider, options.commands);
  const port = options.provider?.port ?? 4096;
  if (options.sandbox) {
    await options.sandbox.openPort(port);
  }

  const target = await createRuntimeTarget(
    request.provider,
    request.runId,
    options,
  );
  const interactiveApproval = isInteractiveApproval(options);
  const { artifacts: skillArtifacts, installCommands } =
    await prepareSkillArtifacts(
      request.provider,
      options.skills,
      target.layout,
    );

  for (const artifact of skillArtifacts) {
    await target.writeArtifact(artifact);
  }
  await installSkills(target, installCommands);

  const configPath = path.join(target.layout.opencodeDir, "openagent.json");
  const mcpConfig = buildOpenCodeMcpConfig(options.mcps);
  const commandsConfig = buildOpenCodeCommandsConfig(options.commands);
  const openCodeConfig = {
    $schema: "https://opencode.ai/config.json",
    ...(mcpConfig ? { mcp: mcpConfig } : {}),
    ...(commandsConfig ? { command: commandsConfig } : {}),
    agent: {
      openagent: {
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

  await target.writeArtifact({
    path: configPath,
    content: JSON.stringify(openCodeConfig, null, 2),
  });

  const commonEnv = {
    ...target.env,
    OPENCODE_CONFIG: configPath,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  };

  if (options.sandbox) {
    const handle = await options.sandbox.runAsync(
      [
        options.provider?.binary ?? "opencode",
        "serve",
        "--hostname",
        "0.0.0.0",
        "--port",
        String(port),
        ...(options.provider?.args ?? []),
      ],
      {
        cwd: options.cwd,
        env: {
          ...(options.env ?? {}),
          ...commonEnv,
          ...(options.provider?.password
            ? { OPENCODE_SERVER_PASSWORD: options.provider.password }
            : {}),
          ...(options.provider?.username
            ? { OPENCODE_SERVER_USERNAME: options.provider.username }
            : {}),
        },
      },
    );
    const baseUrl = (await options.sandbox.getPreviewLink(port)).replace(
      /\/$/,
      "",
    );
    await waitForHttpReady(`${baseUrl}/global/health`, {
      timeoutMs: 20_000,
      init: {
        headers: buildAuthHeaders(options),
      },
    });

    return {
      baseUrl,
      cleanup: async () => {
        await handle.kill();
        await target.cleanup();
      },
      raw: { handle, layout: target.layout },
      configPath,
    };
  }

  const hostPort = options.provider?.port ?? (await getAvailablePort());
  const processHandle = spawnCommand({
    command: options.provider?.binary ?? "opencode",
    args: [
      "serve",
      "--hostname",
      options.provider?.hostname ?? "127.0.0.1",
      "--port",
      String(hostPort),
      ...(options.provider?.args ?? []),
    ],
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      ...commonEnv,
      ...(options.provider?.password
        ? { OPENCODE_SERVER_PASSWORD: options.provider.password }
        : {}),
      ...(options.provider?.username
        ? { OPENCODE_SERVER_USERNAME: options.provider.username }
        : {}),
    },
  });
  const baseUrl = `http://${options.provider?.hostname ?? "127.0.0.1"}:${hostPort}`;
  await waitForHttpReady(`${baseUrl}/global/health`, { timeoutMs: 20_000 });

  return {
    baseUrl,
    cleanup: async () => {
      await processHandle.kill();
      await target.cleanup();
    },
    raw: { processHandle, layout: target.layout },
    configPath,
  };
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

    const headers = buildAuthHeaders(request.options);
    const interactiveApproval = isInteractiveApproval(request.options);
    const createdSession = request.run.resumeSessionId
      ? null
      : await fetchJson<{ id?: string; sessionId?: string }>(
          `${runtime.baseUrl}/session`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(headers ?? {}),
            },
            body: JSON.stringify({
              title: `OpenAgent ${request.runId}`,
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

    const sseAbort = new AbortController();
    const sseTask = (async () => {
      try {
        for await (const event of streamSse(`${runtime.baseUrl}/event`, {
          headers,
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
                    ...(headers ?? {}),
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
        // SSE is best effort here; the direct response is still authoritative.
      }
    })();

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
          ...(headers ?? {}),
        },
        body: JSON.stringify({
          ...(request.run.model
            ? { model: toOpenCodeModel(request.run.model) }
            : {}),
          agent: "openagent",
          parts: mapToOpenCodeParts(inputParts),
        }),
      },
    );

    const rawResponse = toRawEvent(request.runId, response, "message.response");
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
          {
            delta: text,
          },
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
        {
          text,
        },
      ),
    );

    sseAbort.abort();
    await sseTask;
    sink.complete({ text });

    return runtime.cleanup;
  }
}
