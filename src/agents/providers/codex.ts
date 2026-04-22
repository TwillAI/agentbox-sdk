import path from "node:path";

import {
  createNormalizedEvent,
  type NormalizedAgentEvent,
  type PermissionRequestedEvent,
  type RawAgentEvent,
} from "../../events";
import {
  AgentProvider,
  type AgentExecutionRequest,
  type AgentProviderAdapter,
  type AgentRunSink,
  type UserContent,
} from "../types";
import { SandboxProvider } from "../../sandboxes/types";
import { isInteractiveApproval } from "../approval";
import {
  joinTextParts,
  mapToCodexPromptParts,
  normalizeUserInput,
  type ResolvedImagePart,
  validateProviderUserInput,
} from "../input";
import { assertCommandsSupported } from "../config/commands";
import { assertHooksSupported, buildCodexHooksFile } from "../config/hooks";
import { buildCodexConfigToml } from "../config/mcp";
import { createRuntimeTarget } from "../config/runtime";
import { installSkills, prepareSkillArtifacts } from "../config/skills";
import { buildCodexSubagentArtifacts } from "../config/subagents";
import type { PreparedSkill, RuntimeTarget } from "../config/types";
import {
  connectJsonRpcWebSocket,
  JsonRpcLineClient,
} from "../transports/app-server";
import { linesFromNodeStream, spawnCommand } from "../transports/spawn";
import { linesFromTextChunks } from "../../shared/streams";
import { shellQuote } from "../../shared/shell";
import { sleep } from "../../shared/network";

type CodexNotification = {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};

type CodexRuntime = {
  client?: CodexRpcClient;
  source?: AsyncIterable<string>;
  writeLine?: (line: string) => Promise<void>;
  cleanup: () => Promise<void>;
  raw: unknown;
  inputItems: Array<Record<string, unknown>>;
  turnStartOverrides?: Record<string, unknown>;
};

type CodexRpcClient = {
  request<TResult>(method: string, params: unknown): Promise<TResult>;
  notify(method: string, params?: unknown): Promise<void>;
  respond(id: number, result: unknown): Promise<void>;
  messages(): AsyncIterable<CodexNotification>;
  bindThread?(threadId: string): void;
};

const REMOTE_CODEX_APP_SERVER_PORT = 43181;
const REMOTE_CODEX_APP_SERVER_ID = "shared-app-server";

function compactEnv(
  values: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
}

function buildCodexSandboxMode(
  options: AgentExecutionRequest<"codex">["options"],
) {
  return options.sandbox ? "workspace-write" : "read-only";
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
    sandbox: buildCodexSandboxMode(options),
    serviceName: "agentbox",
    // Persist the rollout on disk so follow-up runs can call `thread/resume`.
    // `ephemeral: true` threads have no rollout file and resume fails with
    // "no rollout found for thread id ...".
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
    sandbox: buildCodexSandboxMode(options),
  };
}

function buildTurnSandboxPolicy(
  options: AgentExecutionRequest<"codex">["options"],
):
  | {
      type: "workspaceWrite";
      networkAccess: boolean;
    }
  | {
      type: "externalSandbox";
      networkAccess: "enabled" | "restricted";
    }
  | undefined {
  if (!options.sandbox) {
    return undefined;
  }

  if (options.sandbox.provider === SandboxProvider.LocalDocker) {
    return {
      type: "workspaceWrite",
      networkAccess: true,
    };
  }

  return {
    type: "externalSandbox",
    networkAccess: "enabled",
  };
}

function buildTurnCollaborationMode(
  request: AgentExecutionRequest<"codex">,
): Record<string, unknown> | undefined {
  if (!request.run.systemPrompt) {
    return undefined;
  }

  return {
    mode: "custom",
    settings: {
      developer_instructions: request.run.systemPrompt,
    },
  };
}

function toRawEvent(
  runId: string,
  payload: unknown,
  type: string,
): RawAgentEvent {
  return {
    provider: AgentProvider.Codex,
    runId,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function shouldIgnoreCodexError(notification: CodexNotification): boolean {
  if (notification.method !== "error") {
    return false;
  }

  return notification.params?.willRetry === true;
}

function buildCodexCommandArgs(binary: string, args: string[]): string[] {
  return ["-u", "CODEX_HOME", "-u", "XDG_CONFIG_HOME", binary, ...args];
}

function toNormalizedCodexEvents(
  runId: string,
  notification: CodexNotification,
): NormalizedAgentEvent[] {
  const base = {
    provider: AgentProvider.Codex,
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

function codexImageExtension(mediaType: string): string {
  switch (mediaType) {
    case "image/gif":
      return ".gif";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      return ".img";
  }
}

async function materializeCodexImage(
  target: RuntimeTarget,
  part: ResolvedImagePart,
  index: number,
): Promise<string> {
  if (part.source.type === "url") {
    return part.source.url;
  }

  const imagePath = path.join(
    target.layout.rootDir,
    "inputs",
    `codex-image-${index}${codexImageExtension(part.mediaType)}`,
  );
  const encodedPath = `${imagePath}.b64`;

  await target.writeArtifact({
    path: encodedPath,
    content: part.source.data,
  });
  await target.runCommand(
    [
      `mkdir -p ${shellQuote(path.posix.dirname(imagePath))}`,
      `(base64 --decode < ${shellQuote(encodedPath)} > ${shellQuote(imagePath)} || base64 -D < ${shellQuote(encodedPath)} > ${shellQuote(imagePath)})`,
      `rm -f ${shellQuote(encodedPath)}`,
    ].join(" && "),
  );

  return imagePath;
}

function resolveCodexOpenAiBaseUrl(
  request: AgentExecutionRequest<"codex">,
): string | undefined {
  return (
    request.options.env?.OPENAI_BASE_URL ??
    request.options.provider?.env?.OPENAI_BASE_URL
  );
}

async function ensureCodexLogin(
  request: AgentExecutionRequest<"codex">,
  target: RuntimeTarget,
): Promise<void> {
  const openAiApiKey =
    request.options.env?.OPENAI_API_KEY ??
    request.options.provider?.env?.OPENAI_API_KEY;
  const openAiBaseUrl = resolveCodexOpenAiBaseUrl(request);

  // Best-effort login. If OPENAI_API_KEY is exposed via the agent options, the
  // sandbox's base env, or the host process env, the shell guard below detects
  // it and runs `codex login --with-api-key`. Otherwise it silently no-ops so
  // callers relying on a pre-existing `auth.json` (or other auth mechanisms)
  // are not broken.
  const extraEnv: Record<string, string> = {};
  if (openAiApiKey) {
    extraEnv.OPENAI_API_KEY = openAiApiKey;
  }
  if (openAiBaseUrl) {
    extraEnv.OPENAI_BASE_URL = openAiBaseUrl;
  }
  await target.runCommand(
    'if [ -z "${OPENAI_API_KEY:-}" ]; then exit 0; fi; printenv OPENAI_API_KEY | env -u CODEX_HOME -u XDG_CONFIG_HOME codex login --with-api-key >/dev/null 2>&1',
    Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
  );
}

function toRemoteCodexWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString();
}

async function connectRemoteCodexAppServer(
  url: string,
  headers: Record<string, string> = {},
) {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 30_000) {
    try {
      return await connectJsonRpcWebSocket(url, { headers });
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw (
    lastError ?? new Error(`Could not connect to Codex app-server at ${url}.`)
  );
}

async function waitForInternalCodexReady(
  sandbox: NonNullable<AgentExecutionRequest<"codex">["options"]["sandbox"]>,
  port: number,
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const result = await sandbox
      .run(`curl -fsS http://127.0.0.1:${port}/readyz >/dev/null`, {
        cwd,
        env,
        timeoutMs: 5_000,
      })
      .catch(() => undefined);
    if (result?.exitCode === 0) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Codex internal app-server did not become ready on ${port}.`);
}

async function createRuntime(
  request: AgentExecutionRequest<"codex">,
  inputParts: Awaited<ReturnType<typeof validateProviderUserInput>>,
): Promise<CodexRuntime> {
  const options = request.options;
  const usesRemoteWebSocket =
    options.sandbox && options.sandbox.provider !== SandboxProvider.LocalDocker;
  const hooks = assertHooksSupported(request.provider, options);
  assertCommandsSupported(request.provider, options.commands);

  if (usesRemoteWebSocket && options.sandbox) {
    const sandbox = options.sandbox;
    await sandbox.openPort(REMOTE_CODEX_APP_SERVER_PORT);
    const sharedTarget = await createRuntimeTarget(
      request.provider,
      REMOTE_CODEX_APP_SERVER_ID,
      options,
    );
    await ensureCodexLogin(request, sharedTarget);
    const env = compactEnv({
      ...(options.env ?? {}),
      ...sharedTarget.env,
      ...(options.provider?.env ?? {}),
    });
    const serverCwd = sharedTarget.layout.rootDir;
    const previewUrl = await sandbox.getPreviewLink(
      REMOTE_CODEX_APP_SERVER_PORT,
    );
    const {
      artifacts: subAgentArtifacts,
      agentSections,
      enableMultiAgent,
    } = buildCodexSubagentArtifacts(options.subAgents, sharedTarget.layout);

    const serverArtifacts = [...subAgentArtifacts];
    const hooksFile = buildCodexHooksFile(hooks);
    const configToml = buildCodexConfigToml(
      options.mcps,
      agentSections,
      Boolean(hooksFile),
    );
    if (configToml) {
      serverArtifacts.push({
        path: path.join(sharedTarget.layout.codexDir, "config.toml"),
        content: configToml,
      });
    }
    if (hooksFile) {
      serverArtifacts.push({
        path: path.join(sharedTarget.layout.codexDir, "hooks.json"),
        content: JSON.stringify(hooksFile, null, 2),
      });
    }

    for (const artifact of serverArtifacts) {
      await sharedTarget.writeArtifact(artifact);
    }

    const configArgs: string[] = [];
    configArgs.push("-c", `features.multi_agent=${enableMultiAgent}`);
    const openAiBaseUrl = resolveCodexOpenAiBaseUrl(request);
    if (openAiBaseUrl) {
      configArgs.push("-c", `openai_base_url=${JSON.stringify(openAiBaseUrl)}`);
    }
    const binary = options.provider?.binary ?? "codex";
    const pidFilePath = path.posix.join(
      sharedTarget.layout.rootDir,
      "codex-app-server.pid",
    );
    const logFilePath = path.posix.join(
      sharedTarget.layout.rootDir,
      "codex-app-server.log",
    );
    const launchResult = await sandbox.run(
      [
        `mkdir -p ${shellQuote(sharedTarget.layout.rootDir)}`,
        `if curl -fsS http://127.0.0.1:${REMOTE_CODEX_APP_SERVER_PORT}/readyz >/dev/null 2>&1; then exit 0; fi`,
        `if [ -f ${shellQuote(pidFilePath)} ]; then kill "$(cat ${shellQuote(pidFilePath)})" >/dev/null 2>&1 || true; rm -f ${shellQuote(pidFilePath)}; fi`,
        `(${[
          `nohup ${[
            "env",
            ...buildCodexCommandArgs(binary, [
              ...configArgs,
              "app-server",
              "--listen",
              `ws://0.0.0.0:${REMOTE_CODEX_APP_SERVER_PORT}`,
            ]),
          ]
            .map(shellQuote)
            .join(" ")} > ${shellQuote(logFilePath)} 2>&1 &`,
          `echo $! > ${shellQuote(pidFilePath)}`,
        ].join(" ")})`,
      ].join(" && "),
      {
        cwd: serverCwd,
        env,
      },
    );
    if (launchResult.exitCode !== 0) {
      throw new Error(
        `Could not start Codex app-server: ${launchResult.combinedOutput || launchResult.stderr}`,
      );
    }
    await waitForInternalCodexReady(
      sandbox,
      REMOTE_CODEX_APP_SERVER_PORT,
      serverCwd,
      env,
    );

    const target = await createRuntimeTarget(
      request.provider,
      request.runId,
      options,
    );
    try {
      const {
        artifacts: skillArtifacts,
        installCommands,
        preparedSkills,
      } = await prepareSkillArtifacts(
        request.provider,
        options.skills,
        target.layout,
      );

      for (const artifact of skillArtifacts) {
        await target.writeArtifact(artifact);
      }
      await installSkills(target, installCommands);

      const textPrompt = joinTextParts(
        inputParts.filter(
          (part): part is Extract<typeof part, { type: "text" }> =>
            part.type === "text",
        ),
      );
      const codexPromptText = buildCodexPromptText(textPrompt, preparedSkills);
      const inputItems: Array<Record<string, unknown>> = [];

      if (codexPromptText.trim().length > 0) {
        inputItems.push({
          type: "text",
          text: codexPromptText,
          text_elements: [],
        });
      }

      inputItems.push(
        ...(await mapToCodexPromptParts(inputParts, async (part, index) =>
          materializeCodexImage(target, part, index),
        )),
      );
      inputItems.push(...buildCodexSkillInputItems(preparedSkills));

      const transport = await connectRemoteCodexAppServer(
        toRemoteCodexWebSocketUrl(previewUrl),
        sandbox.previewHeaders,
      );
      return {
        source: transport.source,
        writeLine: transport.send,
        cleanup: async () => {
          await transport?.close().catch(() => undefined);
          await target.cleanup().catch(() => undefined);
        },
        raw: {
          transport: transport.raw,
          previewUrl,
          port: REMOTE_CODEX_APP_SERVER_PORT,
          serverLayout: sharedTarget.layout,
          layout: target.layout,
        },
        inputItems,
        turnStartOverrides: buildTurnCollaborationMode(request),
      };
    } catch (error) {
      await target.cleanup().catch(() => undefined);
      throw error;
    }
  }

  const target = await createRuntimeTarget(
    request.provider,
    request.runId,
    options,
  );
  try {
    await ensureCodexLogin(request, target);
  } catch (error) {
    await target.cleanup().catch(() => undefined);
    throw error;
  }
  const env = compactEnv({
    ...(options.env ?? {}),
    ...target.env,
    ...(options.provider?.env ?? {}),
  });
  const runtimeCwd = target.layout.rootDir;

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
  const hooksFile = buildCodexHooksFile(hooks);
  const configToml = buildCodexConfigToml(
    options.mcps,
    agentSections,
    Boolean(hooksFile),
  );
  if (configToml) {
    artifacts.push({
      path: path.join(target.layout.codexDir, "config.toml"),
      content: configToml,
    });
  }
  if (hooksFile) {
    artifacts.push({
      path: path.join(target.layout.codexDir, "hooks.json"),
      content: JSON.stringify(hooksFile, null, 2),
    });
  }

  let instructionsFilePath: string | undefined;
  if (request.run.systemPrompt) {
    instructionsFilePath = path.join(
      target.layout.codexDir,
      "prompts",
      "agentbox-system.md",
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
  const openAiBaseUrl = resolveCodexOpenAiBaseUrl(request);
  if (openAiBaseUrl) {
    configArgs.push("-c", `openai_base_url=${JSON.stringify(openAiBaseUrl)}`);
  }

  const textPrompt = joinTextParts(
    inputParts.filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text",
    ),
  );
  const codexPromptText = buildCodexPromptText(textPrompt, preparedSkills);
  const inputItems: Array<Record<string, unknown>> = [];

  if (codexPromptText.trim().length > 0) {
    inputItems.push({
      type: "text",
      text: codexPromptText,
      text_elements: [],
    });
  }

  inputItems.push(
    ...(await mapToCodexPromptParts(inputParts, async (part, index) =>
      materializeCodexImage(target, part, index),
    )),
  );
  inputItems.push(...buildCodexSkillInputItems(preparedSkills));

  if (options.sandbox) {
    const handle = await options.sandbox.runAsync(
      [
        "env",
        ...buildCodexCommandArgs(options.provider?.binary ?? "codex", [
          ...configArgs,
          "app-server",
        ]),
      ],
      {
        cwd: runtimeCwd,
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
    command: "env",
    args: buildCodexCommandArgs(options.provider?.binary ?? "codex", [
      ...configArgs,
      "app-server",
    ]),
    cwd: runtimeCwd,
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
    const inputParts = await validateProviderUserInput(
      request.provider,
      request.run.input,
    );
    const runtime = await createRuntime(request, inputParts);
    sink.setRaw(runtime.raw);
    sink.emitEvent(
      createNormalizedEvent("run.started", {
        provider: request.provider,
        runId: request.runId,
      }),
    );

    const client =
      runtime.client ??
      new JsonRpcLineClient<CodexNotification>(
        runtime.source!,
        runtime.writeLine!,
      );
    const interactiveApproval = isInteractiveApproval(request.options);

    let rootThreadId: string | undefined;
    let turnId: string | undefined;
    let pendingTurns = 1;

    // Abort handler: first issue `turn/interrupt` so codex writes a
    // proper "interrupted" status into the rollout (without this, a
    // subsequent `thread/resume` makes the model continue the aborted
    // response instead of treating it as finished). Then unconditionally
    // tear down the transport so the run unwinds within a bounded time
    // — we cannot rely on `turn/completed` arriving on the event stream
    // after an interrupt, and leaving the transport open would strand
    // the caller's event loop, keeping the run's isRunning state stuck
    // and blocking the next user message.
    sink.setAbort(async () => {
      const threadIdAtAbort = rootThreadId;
      const turnIdAtAbort = turnId;
      if (threadIdAtAbort && turnIdAtAbort) {
        try {
          await Promise.race([
            client.request("turn/interrupt", {
              threadId: threadIdAtAbort,
              turnId: turnIdAtAbort,
            }),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("codex turn/interrupt timed out")),
                3_000,
              ),
            ),
          ]);
        } catch {
          // Best-effort; fall through to hard cleanup regardless.
        }
      }
      await runtime.cleanup().catch(() => undefined);
    });

    const sendTurn = async (content: UserContent) => {
      if (!rootThreadId) {
        throw new Error("Cannot send message before thread is started.");
      }
      const parts = normalizeUserInput(content);
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      const inputItems: Array<Record<string, unknown>> = [];
      if (text.trim().length > 0) {
        inputItems.push({ type: "text", text, text_elements: [] });
      }
      pendingTurns++;
      const sandboxPolicy = buildTurnSandboxPolicy(request.options);
      await client.request<{ turn?: { id?: string } }>("turn/start", {
        threadId: rootThreadId,
        input: inputItems,
        approvalPolicy: isInteractiveApproval(request.options)
          ? "untrusted"
          : "never",
        ...(sandboxPolicy ? { sandboxPolicy } : {}),
        model: request.run.model ?? null,
        effort: null,
        outputSchema: null,
      });
    };

    sink.onMessage(sendTurn);

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
                "Codex tool/requestUserInput approvals are not yet supported by AgentBox.",
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
              finalText += event.delta;
            }
          }

          if (message.method === "thread/started" && !rootThreadId) {
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
            pendingTurns--;
            if (pendingTurns <= 0) {
              resolve({ text: finalText, turnId, threadId: rootThreadId });
              return;
            }
          }

          if (message.method === "error" && !shouldIgnoreCodexError(message)) {
            reject(message);
            return;
          }
        }

        reject(new Error("Codex transport closed before run completed."));
      })().catch(reject);
    });

    try {
      if (!runtime.client) {
        await client.request("initialize", {
          clientInfo: {
            title: "AgentBox",
            name: "AgentBox",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
          },
        });
        await client.notify("initialized", {});
      }

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
      if ("bindThread" in client && typeof client.bindThread === "function") {
        client.bindThread(threadResponse.thread.id);
      }
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

      const sandboxPolicy = buildTurnSandboxPolicy(request.options);
      await client.request<{ turn?: { id?: string } }>("turn/start", {
        threadId: threadResponse.thread.id,
        input: runtime.inputItems,
        approvalPolicy: isInteractiveApproval(request.options)
          ? "untrusted"
          : "never",
        ...(sandboxPolicy ? { sandboxPolicy } : {}),
        ...(runtime.turnStartOverrides ?? {}),
        model: request.run.model ?? null,
        effort: null,
        outputSchema: null,
      });

      const { text } = await completion;
      sink.complete({ text });
    } finally {
      await runtime.cleanup().catch(() => undefined);
    }

    return async () => undefined;
  }
}
