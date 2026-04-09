import path from "node:path";

import {
  createNormalizedEvent,
  type NormalizedAgentEvent,
  type PermissionRequestedEvent,
  type RawAgentEvent,
} from "../../events";
import { AsyncQueue } from "../../shared/async-queue";
import type {
  AgentExecutionRequest,
  AgentProviderAdapter,
  AgentRunSink,
} from "../types";
import { isInteractiveApproval } from "../approval";
import {
  joinTextParts,
  mapToCodexPromptParts,
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
};

type CodexRpcClient = {
  request<TResult>(method: string, params: unknown): Promise<TResult>;
  notify(method: string, params?: unknown): Promise<void>;
  respond(id: number, result: unknown): Promise<void>;
  messages(): AsyncIterable<CodexNotification>;
  bindThread?(threadId: string): void;
};

const REMOTE_CODEX_APP_SERVER_PORT = 43181;
const REMOTE_CODEX_APP_SERVER_PORTS = Array.from(
  { length: 10 },
  (_, index) => REMOTE_CODEX_APP_SERVER_PORT + index,
);
const remoteCodexPortPoolBySandbox = new WeakMap<
  object,
  {
    init?: Promise<void>;
    available: number[];
    inUse: Set<number>;
  }
>();

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

  if (options.sandbox.provider === "local-docker") {
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

async function ensureCodexLogin(
  request: AgentExecutionRequest<"codex">,
): Promise<void> {
  const openAiApiKey = request.options.env?.OPENAI_API_KEY;
  if (!openAiApiKey) {
    return;
  }

  const target = await createRuntimeTarget(
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

function toRemoteCodexWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString();
}

async function connectRemoteCodexAppServer(url: string) {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 30_000) {
    try {
      return await connectJsonRpcWebSocket(url);
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw (
    lastError ?? new Error(`Could not connect to Codex app-server at ${url}.`)
  );
}

function extractThreadId(message: CodexNotification): string | undefined {
  const params = message.params;
  if (!params) {
    return undefined;
  }

  if (typeof params.threadId === "string") {
    return params.threadId;
  }

  const thread = params.thread as Record<string, unknown> | undefined;
  if (typeof thread?.id === "string") {
    return thread.id;
  }

  return undefined;
}

class SharedCodexRunClient implements CodexRpcClient {
  readonly notifications = new AsyncQueue<CodexNotification>();
  threadId?: string;
  closed = false;

  constructor(
    private readonly connection: SharedCodexAppServerConnection,
    readonly runId: string,
  ) {}

  bindThread(threadId: string): void {
    if (this.threadId === threadId) {
      return;
    }

    this.threadId = threadId;
    this.connection.bindThread(threadId, this);
  }

  push(message: CodexNotification): void {
    if (!this.closed) {
      this.notifications.push(message);
    }
  }

  fail(error: unknown): void {
    if (!this.closed) {
      this.notifications.fail(error);
    }
  }

  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    return this.connection.request(method, params);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.connection.notify(method, params);
  }

  async respond(id: number, result: unknown): Promise<void> {
    await this.connection.respond(id, result);
  }

  messages(): AsyncIterable<CodexNotification> {
    return this.notifications;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.notifications.finish();
    this.connection.unbindRun(this);
  }
}

class SharedCodexAppServerConnection {
  private readonly runs = new Set<SharedCodexRunClient>();
  private readonly runsByThreadId = new Map<string, SharedCodexRunClient>();
  private readonly pendingByThreadId = new Map<string, CodexNotification[]>();
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }
  >();
  private nextId = 1;
  private initialized = false;
  private initializePromise?: Promise<void>;

  constructor(
    private readonly transport: Awaited<
      ReturnType<typeof connectJsonRpcWebSocket>
    >,
  ) {
    void this.consume();
  }

  private async consume(): Promise<void> {
    try {
      for await (const line of this.transport.source) {
        if (!line.trim()) {
          continue;
        }

        const message = JSON.parse(line) as Record<string, unknown>;
        if (typeof message.method === "string") {
          this.routeNotification(message as CodexNotification);
          continue;
        }

        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) {
            continue;
          }

          this.pending.delete(message.id);
          if (message.error) {
            pending.reject(message.error);
          } else {
            pending.resolve(message.result);
          }
        }
      }

      const error = new Error("Shared Codex app-server connection closed.");
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      for (const run of this.runs) {
        run.fail(error);
      }
    } catch (error) {
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      for (const run of this.runs) {
        run.fail(error);
      }
    }
  }

  private routeNotification(message: CodexNotification): void {
    const threadId = extractThreadId(message);
    if (threadId) {
      const run = this.runsByThreadId.get(threadId);
      if (run) {
        run.push(message);
        return;
      }

      const queued = this.pendingByThreadId.get(threadId) ?? [];
      queued.push(message);
      this.pendingByThreadId.set(threadId, queued);
      return;
    }

    for (const run of this.runs) {
      run.push(message);
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }

    this.initializePromise = (async () => {
      await this.request("initialize", {
        clientInfo: {
          title: "OpenAgent",
          name: "OpenAgent",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      await this.notify("initialized", {});
      this.initialized = true;
    })().finally(() => {
      this.initializePromise = undefined;
    });

    await this.initializePromise;
  }

  createRun(runId: string): SharedCodexRunClient {
    const run = new SharedCodexRunClient(this, runId);
    this.runs.add(run);
    return run;
  }

  bindThread(threadId: string, run: SharedCodexRunClient): void {
    this.runsByThreadId.set(threadId, run);
    const queued = this.pendingByThreadId.get(threadId);
    if (!queued) {
      return;
    }

    this.pendingByThreadId.delete(threadId);
    for (const message of queued) {
      run.push(message);
    }
  }

  unbindRun(run: SharedCodexRunClient): void {
    this.runs.delete(run);
    if (run.threadId) {
      const current = this.runsByThreadId.get(run.threadId);
      if (current === run) {
        this.runsByThreadId.delete(run.threadId);
      }
    }
  }

  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    const id = this.nextId++;
    const response = new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });

    await this.transport.send(JSON.stringify({ id, method, params }));
    return response;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.transport.send(JSON.stringify({ method, params: params ?? {} }));
  }

  async respond(id: number, result: unknown): Promise<void> {
    await this.transport.send(JSON.stringify({ id, result }));
  }
}

async function acquireRemoteCodexPort(
  sandbox: NonNullable<AgentExecutionRequest<"codex">["options"]["sandbox"]>,
): Promise<number> {
  const key = sandbox as object;
  let pool = remoteCodexPortPoolBySandbox.get(key);
  if (!pool) {
    pool = {
      available: [...REMOTE_CODEX_APP_SERVER_PORTS],
      inUse: new Set<number>(),
    };
    pool.init = (async () => {
      for (const port of REMOTE_CODEX_APP_SERVER_PORTS) {
        await sandbox.openPort(port);
      }
    })();
    remoteCodexPortPoolBySandbox.set(key, pool);
  }

  if (pool.init) {
    await pool.init;
    pool.init = undefined;
  }

  const port = pool.available.shift();
  if (port === undefined) {
    throw new Error("No available remote Codex app-server ports.");
  }
  pool.inUse.add(port);
  return port;
}

function releaseRemoteCodexPort(
  sandbox: NonNullable<AgentExecutionRequest<"codex">["options"]["sandbox"]>,
  port: number,
): void {
  const pool = remoteCodexPortPoolBySandbox.get(sandbox as object);
  if (!pool) {
    return;
  }
  if (!pool.inUse.delete(port)) {
    return;
  }
  if (!pool.available.includes(port)) {
    pool.available.push(port);
    pool.available.sort((left, right) => left - right);
  }
}

async function createRuntime(
  request: AgentExecutionRequest<"codex">,
  inputParts: Awaited<ReturnType<typeof validateProviderUserInput>>,
): Promise<CodexRuntime> {
  const options = request.options;
  const usesRemoteWebSocket =
    options.sandbox && options.sandbox.provider !== "local-docker";
  const remoteAppServerPort =
    usesRemoteWebSocket && options.sandbox
      ? await acquireRemoteCodexPort(options.sandbox)
      : undefined;
  const hooks = assertHooksSupported(request.provider, options);
  assertCommandsSupported(request.provider, options.commands);
  await ensureCodexLogin(request);

  const target = await createRuntimeTarget(
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

  if (
    usesRemoteWebSocket &&
    options.sandbox &&
    remoteAppServerPort !== undefined
  ) {
    const sandbox = options.sandbox;
    const binary = options.provider?.binary ?? "codex";
    const pidFilePath = path.posix.join(
      target.layout.rootDir,
      "codex-app-server.pid",
    );
    const logFilePath = path.posix.join(
      target.layout.rootDir,
      "codex-app-server.log",
    );
    const launchCommand = [
      `mkdir -p ${shellQuote(target.layout.rootDir)}`,
      `(${[
        `nohup ${[
          binary,
          ...configArgs,
          "app-server",
          "--listen",
          `ws://0.0.0.0:${remoteAppServerPort}`,
        ]
          .map(shellQuote)
          .join(" ")} > ${shellQuote(logFilePath)} 2>&1 &`,
        `echo $! > ${shellQuote(pidFilePath)}`,
      ].join(" ")})`,
    ].join(" && ");
    const launchHandle = await sandbox.runAsync(launchCommand, {
      cwd: options.cwd,
      env,
    });
    const launchResult = await launchHandle.wait();
    if (launchResult.exitCode !== 0) {
      releaseRemoteCodexPort(sandbox, remoteAppServerPort);
      throw new Error(
        `Could not start Codex app-server: ${launchResult.combinedOutput || launchResult.stderr}`,
      );
    }
    let cleanedUp = false;
    const cleanupRemoteRun = async () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      await sandbox
        .run(
          `if [ -f ${shellQuote(pidFilePath)} ]; then kill "$(cat ${shellQuote(pidFilePath)})" >/dev/null 2>&1 || true; rm -f ${shellQuote(pidFilePath)}; fi`,
          {
            cwd: options.cwd,
            env,
            timeoutMs: 30_000,
          },
        )
        .catch(() => undefined);
      releaseRemoteCodexPort(sandbox, remoteAppServerPort);
      await target.cleanup().catch(() => undefined);
    };

    let previewUrl: string | undefined;
    let transport:
      | Awaited<ReturnType<typeof connectJsonRpcWebSocket>>
      | undefined;
    try {
      previewUrl = await sandbox.getPreviewLink(remoteAppServerPort);
      transport = await connectRemoteCodexAppServer(
        toRemoteCodexWebSocketUrl(previewUrl),
      );
    } catch (error) {
      await cleanupRemoteRun();
      throw error;
    }

    return {
      source: transport.source,
      writeLine: transport.send,
      cleanup: async () => {
        await transport.close().catch(() => undefined);
        await cleanupRemoteRun();
      },
      raw: {
        transport: transport.raw,
        previewUrl,
        pidFilePath,
        logFilePath,
        port: remoteAppServerPort,
        layout: target.layout,
      },
      inputItems,
    };
  }

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
    const inputParts = await validateProviderUserInput(
      request.provider,
      request.run.input,
    );
    const runtime = await createRuntime(request, inputParts);
    sink.setRaw(runtime.raw);
    sink.setAbort(runtime.cleanup);
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

    if (!runtime.client) {
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

    await client.request<{ turn?: { id?: string } }>("turn/start", {
      threadId: threadResponse.thread.id,
      input: runtime.inputItems,
      approvalPolicy: isInteractiveApproval(request.options)
        ? "untrusted"
        : "never",
      ...(buildTurnSandboxPolicy(request.options)
        ? { sandboxPolicy: buildTurnSandboxPolicy(request.options) }
        : {}),
      model: request.run.model ?? null,
      effort: null,
      outputSchema: null,
    });

    try {
      const { text } = await completion;
      sink.complete({ text });
    } finally {
      await runtime.cleanup().catch(() => undefined);
    }

    return async () => undefined;
  }
}
