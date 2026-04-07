import path from "node:path";

import {
  createNormalizedEvent,
  type NormalizedAgentEvent,
  type PermissionRequestedEvent,
  type RawAgentEvent,
} from "../../events";
import type {
  AgentExecutionRequest,
  AgentProviderAdapter,
  AgentRunSink,
} from "../types";
import { isInteractiveApproval } from "../approval";
import {
  assertCommandsSupported,
  assertHooksSupported,
  buildCodexConfigToml,
  buildCodexSubagentArtifacts,
  createMaterializationTarget,
  installSkills,
  prepareSkillArtifacts,
  type PreparedSkill,
} from "../config";
import { JsonRpcLineClient } from "../transports/app-server";
import { linesFromNodeStream, spawnCommand } from "../transports/spawn";
import { linesFromTextChunks } from "../../shared/streams";

type CodexNotification = {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};

type CodexRuntime = {
  source: AsyncIterable<string>;
  writeLine: (line: string) => Promise<void>;
  cleanup: () => Promise<void>;
  raw: unknown;
  inputItems: Array<Record<string, unknown>>;
};

function compactEnv(
  values: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
}

function buildThreadParams(
  cwd: string,
  options: AgentExecutionRequest<"codex">["options"],
  request: AgentExecutionRequest<"codex">,
) {
  return {
    cwd,
    model: request.run.model ?? null,
    approvalPolicy: isInteractiveApproval(options) ? "untrusted" : "never",
    sandbox: options.sandbox ? "workspace-write" : "read-only",
    serviceName: "openagent",
    ephemeral: true,
    experimentalRawEvents: true,
  };
}

function buildResumeParams(
  cwd: string,
  options: AgentExecutionRequest<"codex">["options"],
  request: AgentExecutionRequest<"codex">,
) {
  return {
    threadId: request.run.resumeSessionId,
    cwd,
    model: request.run.model ?? null,
    approvalPolicy: isInteractiveApproval(options) ? "untrusted" : "never",
    sandbox: options.sandbox ? "workspace-write" : "read-only",
  };
}

function toRawEvent(
  runId: string,
  payload: unknown,
  type: string,
): RawAgentEvent {
  return {
    provider: "codex",
    runId,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function toNormalizedCodexEvents(
  runId: string,
  notification: CodexNotification,
): NormalizedAgentEvent[] {
  const base = {
    provider: "codex",
    runId,
    raw: toRawEvent(runId, notification, notification.method),
  };

  if (notification.method === "turn/started") {
    return [createNormalizedEvent("message.started", base)];
  }

  if (notification.method === "item/completed") {
    const item = notification.params?.item as
      | Record<string, unknown>
      | undefined;
    if (!item) {
      return [];
    }

    if (item.type === "agentMessage" && typeof item.text === "string") {
      return [
        createNormalizedEvent("text.delta", base, { delta: item.text }),
        createNormalizedEvent("message.completed", base, { text: item.text }),
      ];
    }

    if (item.type === "reasoning" && item.summary) {
      return [
        createNormalizedEvent("reasoning.delta", base, {
          delta:
            typeof item.summary === "string"
              ? item.summary
              : JSON.stringify(item.summary),
        }),
      ];
    }

    if (
      item.type === "commandExecution" ||
      item.type === "dynamicToolCall" ||
      item.type === "mcpToolCall" ||
      item.type === "webSearch"
    ) {
      return [
        createNormalizedEvent("tool.call.completed", base, {
          toolName: String(
            item.tool ?? item.command ?? item.server ?? item.query ?? item.type,
          ),
          callId: String(item.id ?? ""),
          output: item,
        }),
      ];
    }
  }

  if (notification.method === "item/started") {
    const item = notification.params?.item as
      | Record<string, unknown>
      | undefined;
    if (
      item &&
      (item.type === "commandExecution" ||
        item.type === "dynamicToolCall" ||
        item.type === "mcpToolCall" ||
        item.type === "webSearch")
    ) {
      return [
        createNormalizedEvent("tool.call.started", base, {
          toolName: String(
            item.tool ?? item.command ?? item.server ?? item.query ?? item.type,
          ),
          callId: String(item.id ?? ""),
          input: item,
        }),
      ];
    }
  }

  if (notification.method === "turn/completed") {
    const turn = notification.params?.turn as
      | Record<string, unknown>
      | undefined;
    const text =
      typeof turn?.lastAgentMessage === "string"
        ? turn.lastAgentMessage
        : undefined;
    return [createNormalizedEvent("run.completed", base, { text })];
  }

  if (notification.method === "error") {
    const error = notification.params?.error as
      | Record<string, unknown>
      | undefined;
    return [
      createNormalizedEvent("run.error", base, {
        error: String(error?.message ?? "Codex app-server error"),
      }),
    ];
  }

  return [];
}

function createCodexPermissionEvent(
  request: AgentExecutionRequest<"codex">,
  notification: CodexNotification,
): PermissionRequestedEvent | null {
  const raw = toRawEvent(request.runId, notification, notification.method);
  const params = notification.params;
  const requestId = notification.id;
  if (!params || requestId === undefined) {
    return null;
  }

  if (notification.method === "item/commandExecution/requestApproval") {
    const networkContext = params.networkApprovalContext as
      | Record<string, unknown>
      | undefined;
    const availableDecisions = Array.isArray(params.availableDecisions)
      ? params.availableDecisions
      : [];
    const title = networkContext
      ? "Approve network access"
      : "Approve command execution";
    const message =
      typeof params.reason === "string"
        ? params.reason
        : typeof params.command === "string"
          ? params.command
          : undefined;

    return createNormalizedEvent(
      "permission.requested",
      {
        provider: request.provider,
        runId: request.runId,
        raw,
      },
      {
        requestId: String(requestId),
        kind: networkContext ? "network" : "bash",
        title,
        message,
        input: params,
        canRemember: availableDecisions.includes("acceptForSession"),
      },
    ) as PermissionRequestedEvent;
  }

  if (notification.method === "item/fileChange/requestApproval") {
    const availableDecisions = Array.isArray(params.availableDecisions)
      ? params.availableDecisions
      : [];
    return createNormalizedEvent(
      "permission.requested",
      {
        provider: request.provider,
        runId: request.runId,
        raw,
      },
      {
        requestId: String(requestId),
        kind: "file-change",
        title: "Approve file changes",
        message:
          typeof params.reason === "string"
            ? params.reason
            : "Codex wants to modify files.",
        input: params,
        canRemember: availableDecisions.includes("acceptForSession"),
      },
    ) as PermissionRequestedEvent;
  }

  return null;
}

function toCodexApprovalDecision(
  notification: CodexNotification,
  response: {
    decision: "allow" | "deny";
    remember?: boolean;
  },
):
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: string[];
      };
    } {
  const params = notification.params ?? {};
  const availableDecisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
    : [];
  const proposedExecpolicyAmendment = Array.isArray(
    params.proposedExecpolicyAmendment,
  )
    ? params.proposedExecpolicyAmendment.filter(
        (part): part is string => typeof part === "string",
      )
    : [];

  if (response.decision === "deny") {
    return availableDecisions.includes("decline") ? "decline" : "cancel";
  }

  if (response.remember && availableDecisions.includes("acceptForSession")) {
    return "acceptForSession";
  }

  if (
    proposedExecpolicyAmendment.length > 0 &&
    availableDecisions.some(
      (decision) =>
        typeof decision === "object" &&
        decision !== null &&
        "acceptWithExecpolicyAmendment" in decision,
    )
  ) {
    return {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: proposedExecpolicyAmendment,
      },
    };
  }

  return "accept";
}

function buildCodexSkillInputItems(
  skills: PreparedSkill[],
): Array<Record<string, unknown>> {
  return skills.map((skill) => ({
    type: "skill",
    name: skill.name,
    path: skill.skillFilePath,
  }));
}

function buildCodexPromptText(prompt: string, skills: PreparedSkill[]): string {
  if (skills.length === 0) {
    return prompt;
  }

  return [
    `Available skills for this run: ${skills.map((skill) => `$${skill.name}`).join(", ")}.`,
    prompt,
  ].join("\n\n");
}

async function ensureCodexLogin(
  request: AgentExecutionRequest<"codex">,
): Promise<void> {
  const openAiApiKey = request.options.env?.OPENAI_API_KEY;
  if (!openAiApiKey) {
    return;
  }

  const target = await createMaterializationTarget(
    request.provider,
    `${request.runId}-codex-login`,
    request.options,
  );

  try {
    await target.runCommand(
      'if [ -z "$OPENAI_API_KEY" ]; then exit 1; fi; mkdir -p "${CODEX_HOME:-$HOME/.codex}" && printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1',
      {
        OPENAI_API_KEY: openAiApiKey,
      },
    );
  } finally {
    await target.cleanup();
  }
}

async function createRuntime(
  request: AgentExecutionRequest<"codex">,
): Promise<CodexRuntime> {
  const options = request.options;
  assertHooksSupported(request.provider, options.hooks);
  assertCommandsSupported(request.provider, options.commands);
  await ensureCodexLogin(request);

  const target = await createMaterializationTarget(
    request.provider,
    request.runId,
    options,
  );
  const env = compactEnv({
    ...(options.env ?? {}),
    ...target.env,
    ...(options.provider?.env ?? {}),
  });

  const {
    artifacts: skillArtifacts,
    installCommands,
    preparedSkills,
  } = await prepareSkillArtifacts(
    request.provider,
    options.skills,
    target.layout,
  );
  const {
    artifacts: subAgentArtifacts,
    agentSections,
    enableMultiAgent,
  } = buildCodexSubagentArtifacts(options.subAgents, target.layout);

  const artifacts = [...skillArtifacts, ...subAgentArtifacts];
  const configToml = buildCodexConfigToml(options.mcps, agentSections);
  if (configToml) {
    artifacts.push({
      path: path.join(target.layout.codexDir, "config.toml"),
      content: configToml,
    });
  }

  let instructionsFilePath: string | undefined;
  if (request.run.systemPrompt) {
    instructionsFilePath = path.join(
      target.layout.codexDir,
      "prompts",
      "openagent-system.md",
    );
    artifacts.push({
      path: instructionsFilePath,
      content: request.run.systemPrompt,
    });
  }

  for (const artifact of artifacts) {
    await target.writeArtifact(artifact);
  }
  await installSkills(target, installCommands);

  const configArgs: string[] = [];
  if (instructionsFilePath) {
    configArgs.push(
      "-c",
      `model_instructions_file=${JSON.stringify(instructionsFilePath)}`,
    );
  }
  configArgs.push("-c", `features.multi_agent=${enableMultiAgent}`);

  const inputItems = [
    {
      type: "text",
      text: buildCodexPromptText(request.run.input, preparedSkills),
      text_elements: [],
    },
    ...buildCodexSkillInputItems(preparedSkills),
  ];

  if (options.sandbox) {
    const handle = await options.sandbox.runAsync(
      [options.provider?.binary ?? "codex", ...configArgs, "app-server"],
      {
        cwd: options.cwd,
        env,
      },
    );

    if (!handle.write) {
      throw new Error(
        "The selected sandbox does not expose an interactive stdin channel for Codex.",
      );
    }

    async function* stdoutLines(): AsyncIterable<string> {
      async function* stdoutChunks() {
        for await (const event of handle) {
          if (event.type === "stdout" && event.chunk) {
            yield event.chunk;
          }
        }
      }

      yield* linesFromTextChunks(stdoutChunks());
    }

    return {
      source: stdoutLines(),
      writeLine: async (line: string) => {
        await handle.write?.(`${line}\n`);
      },
      cleanup: async () => {
        await handle.kill();
        await target.cleanup();
      },
      raw: { handle, layout: target.layout },
      inputItems,
    };
  }

  const processHandle = spawnCommand({
    command: options.provider?.binary ?? "codex",
    args: [...configArgs, "app-server"],
    cwd: options.cwd,
    env: {
      ...process.env,
      ...env,
    },
  });

  return {
    source: linesFromNodeStream(processHandle.child.stdout),
    writeLine: async (line: string) => {
      processHandle.child.stdin.write(`${line}\n`);
    },
    cleanup: async () => {
      await processHandle.kill();
      await target.cleanup();
    },
    raw: { processHandle, layout: target.layout },
    inputItems,
  };
}

export class CodexAgentAdapter implements AgentProviderAdapter<"codex"> {
  async execute(
    request: AgentExecutionRequest<"codex">,
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

    const client = new JsonRpcLineClient<CodexNotification>(
      runtime.source,
      runtime.writeLine,
    );
    const interactiveApproval = isInteractiveApproval(request.options);

    let rootThreadId: string | undefined;
    let turnId: string | undefined;

    const completion = new Promise<{
      text?: string;
      turnId?: string;
      threadId?: string;
    }>((resolve, reject) => {
      let finalText = "";

      void (async () => {
        for await (const message of client.messages()) {
          const raw = toRawEvent(request.runId, message, message.method);
          sink.emitRaw(raw);

          if (
            message.method === "tool/requestUserInput" &&
            message.id !== undefined
          ) {
            reject(
              new Error(
                "Codex tool/requestUserInput approvals are not yet supported by OpenAgent.",
              ),
            );
            return;
          }

          const permissionEvent = createCodexPermissionEvent(request, message);
          if (permissionEvent && message.id !== undefined) {
            const response = interactiveApproval
              ? await sink.requestPermission(permissionEvent)
              : {
                  requestId: permissionEvent.requestId,
                  decision: "allow" as const,
                };
            await client.respond(message.id, {
              decision: toCodexApprovalDecision(message, response),
            });
            continue;
          }

          for (const event of toNormalizedCodexEvents(request.runId, message)) {
            sink.emitEvent(event);
            if (event.type === "text.delta") {
              finalText = event.delta;
            }
          }

          if (message.method === "thread/started") {
            rootThreadId =
              ((message.params?.thread as Record<string, unknown> | undefined)
                ?.id as string | undefined) ?? rootThreadId;
          }

          if (message.method === "turn/started") {
            turnId =
              ((message.params?.turn as Record<string, unknown> | undefined)
                ?.id as string | undefined) ?? turnId;
          }

          if (
            message.method === "turn/completed" &&
            (!message.params?.threadId ||
              message.params.threadId === rootThreadId)
          ) {
            resolve({ text: finalText, turnId, threadId: rootThreadId });
            return;
          }

          if (message.method === "error") {
            reject(message);
            return;
          }
        }
      })().catch(reject);
    });

    await client.request("initialize", {
      clientInfo: {
        title: "OpenAgent",
        name: "OpenAgent",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    await client.notify("initialized", {});

    const cwd = request.options.cwd ?? process.cwd();
    const threadResponse = request.run.resumeSessionId
      ? await client.request<{ thread: { id: string } }>(
          "thread/resume",
          buildResumeParams(cwd, request.options, request),
        )
      : await client.request<{ thread: { id: string } }>(
          "thread/start",
          buildThreadParams(cwd, request.options, request),
        );
    rootThreadId = threadResponse.thread.id;
    sink.setSessionId(threadResponse.thread.id);
    sink.emitRaw(
      toRawEvent(
        request.runId,
        threadResponse,
        request.run.resumeSessionId
          ? "thread/resume:result"
          : "thread/start:result",
      ),
    );

    await client.request<{ turn?: { id?: string } }>("turn/start", {
      threadId: threadResponse.thread.id,
      input: runtime.inputItems,
      approvalPolicy: isInteractiveApproval(request.options)
        ? "untrusted"
        : "never",
      model: request.run.model ?? null,
      effort: null,
      outputSchema: null,
    });

    const { text } = await completion;
    sink.complete({ text });

    return runtime.cleanup;
  }
}
