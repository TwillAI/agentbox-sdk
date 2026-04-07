import { randomUUID } from "node:crypto";
import path from "node:path";

import { createNormalizedEvent, type RawAgentEvent } from "../../events";
import type { PermissionRequestedEvent } from "../../events";
import type {
  AgentExecutionRequest,
  AgentProviderAdapter,
  AgentRunSink,
} from "../types";
import { shouldAutoApproveClaudeTools } from "../approval";
import {
  assertCommandsSupported,
  assertHooksSupported,
  buildClaudeAgentsConfig,
  buildClaudeCommandArtifacts,
  buildClaudeHookSettings,
  buildClaudeMcpArtifact,
  createMaterializationTarget,
  installSkills,
  prepareSkillArtifacts,
  type MaterializationTarget,
} from "../config";
import { SdkWsServer, type SdkWsMessage } from "../transports/sdk-ws";
import { spawnCommand } from "../transports/spawn";

type ClaudeRuntime = {
  server: SdkWsServer;
  cleanup: () => Promise<void>;
  raw: unknown;
  initializeRequest?: Record<string, unknown>;
};

function toRawEvent(
  runId: string,
  payload: unknown,
  type: string,
): RawAgentEvent {
  return {
    provider: "claude-code",
    runId,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function extractAssistantText(message: SdkWsMessage): string {
  const content = message.message as
    | Array<Record<string, unknown>>
    | Record<string, unknown>
    | undefined;

  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("");
  }

  if (content && Array.isArray(content.content)) {
    return (content.content as Array<Record<string, unknown>>)
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("");
  }

  return "";
}

function extractStreamDelta(message: SdkWsMessage): string {
  const event = message.event as Record<string, unknown> | undefined;
  if (!event) {
    return "";
  }

  const delta = event.delta as Record<string, unknown> | undefined;
  if (typeof delta?.text === "string") {
    return delta.text;
  }

  if (typeof event.text === "string") {
    return event.text;
  }

  return "";
}

function createClaudePermissionEvent(
  request: AgentExecutionRequest<"claude-code">,
  message: SdkWsMessage,
): PermissionRequestedEvent {
  const requestPayload = (message.request ?? {}) as Record<string, unknown>;
  return createNormalizedEvent(
    "permission.requested",
    {
      provider: request.provider,
      runId: request.runId,
      raw: toRawEvent(request.runId, message, message.type),
    },
    {
      requestId: String(message.request_id ?? ""),
      kind: "tool",
      title: `Approve ${String(requestPayload.tool_name ?? "tool")} tool`,
      message: `Claude wants to use ${String(requestPayload.tool_name ?? "tool")}.`,
      input: requestPayload.input,
      canRemember: false,
    },
  ) as PermissionRequestedEvent;
}

async function prepareClaudeRuntime(
  request: AgentExecutionRequest<"claude-code">,
): Promise<{
  target: MaterializationTarget;
  args: string[];
  env: Record<string, string>;
  initializeRequest?: Record<string, unknown>;
}> {
  const options = request.options;
  const provider = options.provider;
  const target = await createMaterializationTarget(
    request.provider,
    request.runId,
    options,
  );

  assertHooksSupported(request.provider, options.hooks);
  assertCommandsSupported(request.provider, options.commands);

  const { artifacts: skillArtifacts, installCommands } =
    await prepareSkillArtifacts(
      request.provider,
      options.skills,
      target.layout,
    );

  const artifacts = [
    ...skillArtifacts,
    ...buildClaudeCommandArtifacts(options.commands, target.layout),
  ];

  const mcpArtifact = buildClaudeMcpArtifact(
    options.mcps,
    target.layout.claudeDir,
  );
  if (mcpArtifact) {
    artifacts.push(mcpArtifact);
  }

  const hookSettings = buildClaudeHookSettings(options.hooks);
  let settingsPath: string | undefined;
  if (hookSettings) {
    settingsPath = path.join(target.layout.claudeDir, "settings.json");
    artifacts.push({
      path: settingsPath,
      content: JSON.stringify(hookSettings, null, 2),
    });
  }

  for (const artifact of artifacts) {
    await target.writeArtifact(artifact);
  }
  await installSkills(target, installCommands);

  const agents = buildClaudeAgentsConfig(options.subAgents);
  const initializeRequest = Object.keys({
    ...(request.run.systemPrompt
      ? { systemPrompt: request.run.systemPrompt }
      : {}),
    ...(agents ? { agents } : {}),
  }).length
    ? {
        subtype: "initialize",
        ...(request.run.systemPrompt
          ? { systemPrompt: request.run.systemPrompt }
          : {}),
        ...(agents ? { agents } : {}),
      }
    : undefined;

  const args = [
    "--sdk-url",
    "", // placeholder, filled in createRuntime once the server exists
    "--print",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    ...(provider?.verbose ? ["--verbose"] : []),
    ...(request.run.model ? ["--model", request.run.model] : []),
    ...(provider?.permissionMode
      ? ["--permission-mode", provider.permissionMode]
      : []),
    ...(provider?.allowedTools?.length
      ? ["--allowedTools", provider.allowedTools.join(",")]
      : []),
    ...(request.run.resumeSessionId ? ["-r", request.run.resumeSessionId] : []),
    ...(settingsPath ? ["--settings", settingsPath] : []),
    ...(mcpArtifact ? ["--mcp-config", mcpArtifact.path] : []),
    ...(provider?.args ?? []),
    "-p",
    "",
  ];

  const env = {
    ...(options.env ?? {}),
    ...target.env,
    ...(provider?.sessionAccessToken
      ? {
          CLAUDE_CODE_SESSION_ACCESS_TOKEN: provider.sessionAccessToken,
        }
      : {}),
  };

  return {
    target,
    args,
    env,
    initializeRequest,
  };
}

async function createRuntime(
  request: AgentExecutionRequest<"claude-code">,
): Promise<ClaudeRuntime> {
  const sandboxProvider = request.options.sandbox?.provider;
  const server = new SdkWsServer({
    host: sandboxProvider === "local-docker" ? "0.0.0.0" : "127.0.0.1",
  });
  await server.start();

  const prepared = await prepareClaudeRuntime(request);
  const args = [...prepared.args];
  args[1] =
    sandboxProvider === "local-docker"
      ? server.url
          .replace("127.0.0.1", "host.docker.internal")
          .replace("0.0.0.0", "host.docker.internal")
      : server.url;

  if (request.options.sandbox) {
    const handle = await request.options.sandbox.runAsync(
      [request.options.provider?.binary ?? "claude", ...args],
      {
        cwd: request.options.cwd,
        env: {
          ...prepared.env,
        },
        pty: true,
      },
    );

    return {
      server,
      cleanup: async () => {
        await handle.kill();
        await server.close();
        await prepared.target.cleanup();
      },
      raw: { server, handle, layout: prepared.target.layout },
      initializeRequest: prepared.initializeRequest,
    };
  }

  const processHandle = spawnCommand({
    command: request.options.provider?.binary ?? "claude",
    args,
    cwd: request.options.cwd,
    env: {
      ...process.env,
      ...prepared.env,
    },
  });

  return {
    server,
    cleanup: async () => {
      await processHandle.kill();
      await server.close();
      await prepared.target.cleanup();
    },
    raw: { server, processHandle, layout: prepared.target.layout },
    initializeRequest: prepared.initializeRequest,
  };
}

export class ClaudeCodeAgentAdapter implements AgentProviderAdapter<"claude-code"> {
  async execute(
    request: AgentExecutionRequest<"claude-code">,
    sink: AgentRunSink,
  ): Promise<() => Promise<void>> {
    const runtime = await createRuntime(request);
    sink.setRaw(runtime.raw);
    sink.setAbort(runtime.cleanup);
    sink.emitEvent(
      createNormalizedEvent("run.started", {
        provider: request.provider,
        runId: request.runId,
      }),
    );

    let sessionId = "";
    let accumulatedText = "";
    let usedStreaming = false;
    const autoApproveTools = shouldAutoApproveClaudeTools(request.options);

    const completion = new Promise<{ text: string }>((resolve, reject) => {
      void (async () => {
        for await (const message of runtime.server.messages()) {
          sink.emitRaw(toRawEvent(request.runId, message, message.type));

          if (message.type === "system" && message.subtype === "init") {
            sessionId = String(message.session_id ?? "");
            if (sessionId) {
              sink.setSessionId(sessionId);
            }
            continue;
          }

          if (
            message.type === "control_request" &&
            (message.request as Record<string, unknown> | undefined)
              ?.subtype === "can_use_tool"
          ) {
            const requestId = String(message.request_id ?? "");
            const requestPayload = message.request as Record<string, unknown>;
            const response = autoApproveTools
              ? {
                  requestId,
                  decision: "allow" as const,
                }
              : await sink.requestPermission(
                  createClaudePermissionEvent(request, message),
                );

            if (response.decision === "allow") {
              sink.emitEvent(
                createNormalizedEvent(
                  "tool.call.started",
                  {
                    provider: request.provider,
                    runId: request.runId,
                  },
                  {
                    toolName: String(requestPayload.tool_name ?? "tool"),
                    callId: requestId,
                    input: requestPayload.input,
                  },
                ),
              );
            }

            await runtime.server.send({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: requestId,
                response:
                  response.decision === "allow"
                    ? {
                        behavior: "allow",
                        updatedInput: requestPayload.input,
                      }
                    : {
                        behavior: "deny",
                        message: "User denied this action.",
                      },
              },
            });
            continue;
          }

          if (message.type === "stream_event") {
            const delta = extractStreamDelta(message);
            if (delta) {
              usedStreaming = true;
              accumulatedText += delta;
              sink.emitEvent(
                createNormalizedEvent(
                  "text.delta",
                  {
                    provider: request.provider,
                    runId: request.runId,
                  },
                  {
                    delta,
                  },
                ),
              );
            }
            continue;
          }

          if (message.type === "assistant") {
            const text = extractAssistantText(message);
            if (!usedStreaming && text) {
              accumulatedText = text;
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
                "message.completed",
                {
                  provider: request.provider,
                  runId: request.runId,
                },
                {
                  text,
                },
              ),
            );
            continue;
          }

          if (message.type === "result") {
            const subtype = String(message.subtype ?? "success");
            if (subtype === "success") {
              resolve({ text: accumulatedText });
            } else {
              reject(
                new Error(
                  String(
                    message.result ??
                      message.error ??
                      "Claude Code run failed.",
                  ),
                ),
              );
            }
            return;
          }

          if (
            message.type === "auth_status" &&
            message.authenticated === false
          ) {
            reject(
              new Error("Claude Code reported an authentication failure."),
            );
            return;
          }
        }
      })().catch(reject);
    });

    await runtime.server.waitForConnection(30_000);
    if (runtime.initializeRequest) {
      const response = await runtime.server.request(runtime.initializeRequest);
      sink.emitRaw(
        toRawEvent(request.runId, response, "control_response:initialize"),
      );
    }
    await runtime.server.send({
      type: "user",
      message: {
        role: "user",
        content: request.run.input,
      },
      parent_tool_use_id: null,
      session_id: request.run.resumeSessionId ?? "",
      uuid: randomUUID(),
    });
    sink.emitEvent(
      createNormalizedEvent("message.started", {
        provider: request.provider,
        runId: request.runId,
      }),
    );
    const { text } = await completion;
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
    sink.complete({ text });

    return runtime.cleanup;
  }
}
