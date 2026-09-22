import crypto from "node:crypto";
import path from "node:path";

import {
  createNormalizedEvent,
  type NormalizedAgentEvent,
  type PermissionRequestedEvent,
  type RawAgentEvent,
} from "../../events";
import type { Sandbox } from "../../sandboxes";
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
import { SandboxProvider } from "../../sandboxes/types";
import { isInteractiveApproval, hasInteractiveQuestions } from "../approval";
import {
  builtinHarnessCommands,
  codexHarnessCommands,
  codexSkillMention,
  type HarnessCommandDescriptor,
  type HarnessCommandInvocation,
} from "../harness-commands";
import { normalizeAsyncUserQuestions, normalizeUserQuestions, questionReply } from "../questions";
import {
  joinTextParts,
  mapToCodexPromptParts,
  normalizeUserInput,
  type ResolvedImagePart,
  validateProviderUserInput,
} from "../input";
import { assertCommandsSupported } from "../config/commands";
import type { CodexModelProviderConfig } from "../config/types";
import { assertHooksSupported, buildCodexHooksFile } from "../config/hooks";
import { activateRtk } from "../config/rtk";
import { buildCodexConfigToml } from "../config/mcp";
import { agentboxRoot, createSetupTarget } from "../config/setup";
import {
  applyDifferentialSetup,
  computeSetupId,
  markSetupComplete,
  preflightSetup,
} from "../config/setup-manifest";
import { prepareSkillArtifacts } from "../config/skills";
import { buildCodexSubagentArtifacts } from "../config/subagents";
import type { SetupTarget } from "../config/types";
import {
  connectJsonRpcWebSocket,
  JsonRpcLineClient,
} from "../transports/app-server";
import { linesFromNodeStream, spawnCommand } from "../transports/spawn";
import { linesFromTextChunks } from "../../shared/streams";
import { shellQuote } from "../../shared/shell";
import { sleep } from "../../shared/network";
import { extractCodexCostData } from "../cost";
import { debugCodex, time } from "../../shared/debug";
import {
  BACKGROUND_TASK_GRACE_MS,
  BackgroundWait,
  BackgroundWaitFinish,
  type BackgroundWaitExpiry,
  resolveBackgroundTaskTimeoutMs,
  STOP_TASKS_TIMEOUT_MS,
  withTimeout,
} from "../background-tasks";

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
  isAlive?: () => boolean;
  raw: unknown;
  inputItems: Array<Record<string, unknown>>;
};

type CodexRpcClient = {
  request<TResult>(method: string, params: unknown): Promise<TResult>;
  notify(method: string, params?: unknown): Promise<void>;
  respond(id: number, result: unknown): Promise<void>;
  respondError(id: number, error: unknown): Promise<void>;
  messages(): AsyncIterable<CodexNotification>;
  bindThread?(threadId: string): void;
};

/**
 * Path to the on-disk `.codex` config directory agentbox uses for a
 * given run. Resolves to `/tmp/agentbox/codex/.codex` in a sandbox, or
 * `<os.tmpdir()>/agentbox-codex/.codex` on the host.
 *
 * Setup writes config.toml, hooks.json, sub-agent .toml files, and
 * skills/ under this directory. Execute points the codex CLI at it via
 * `CODEX_HOME`.
 */
function codexConfigDir(options: AgentOptions<"codex">): string {
  return path.join(
    agentboxRoot(AgentProvider.Codex, Boolean(options.sandbox), options.stateDirectory),
    ".codex",
  );
}

const REMOTE_CODEX_APP_SERVER_PORT = 43181;
const REMOTE_CODEX_APP_SERVER_ID = "shared-app-server";
const CODEX_APP_SERVER_TOKEN_FILENAME = "codex-app-server-token";

function defaultRemoteCodexTokenPath(): string {
  return path.posix.join(
    agentboxRoot(AgentProvider.Codex, true),
    CODEX_APP_SERVER_TOKEN_FILENAME,
  );
}

const codexAppServerTokenCache = new WeakMap<Sandbox, Promise<string>>();

async function readCodexAppServerTokenFile(
  sandbox: Sandbox,
  tokenFilePath: string,
): Promise<string | undefined> {
  const result = await sandbox.run(
    `if [ -f ${shellQuote(tokenFilePath)} ]; then cat ${shellQuote(tokenFilePath)}; fi`,
  );
  if (result.exitCode !== 0) {
    return undefined;
  }
  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

/**
 * Resolve the capability token guarding the remote codex app-server,
 * memoized per sandbox. With `create: true` (setup path) a fresh token is
 * minted when the file is absent; otherwise (connect/attach path) a missing
 * file is a hard error — setup() must have run first.
 *
 * On failure the cache entry is evicted so a transient `sandbox.run` error
 * (or a not-yet-written file) doesn't permanently poison every later connect
 * on this sandbox.
 */
function resolveCodexAppServerToken(
  sandbox: Sandbox,
  tokenFilePath: string,
  create: boolean,
): Promise<string> {
  let cached = codexAppServerTokenCache.get(sandbox);
  if (!cached) {
    cached = (async () => {
      const existing = await readCodexAppServerTokenFile(
        sandbox,
        tokenFilePath,
      );
      if (existing) {
        return existing;
      }
      if (create) {
        return crypto.randomBytes(32).toString("hex");
      }
      throw new Error(
        `Codex app-server token file is missing at ${tokenFilePath}. ` +
          `setup() must run before connecting to the codex app-server.`,
      );
    })().catch((error) => {
      codexAppServerTokenCache.delete(sandbox);
      throw error;
    });
    codexAppServerTokenCache.set(sandbox, cached);
  }
  return cached;
}

function ensureCodexAppServerToken(
  sandbox: Sandbox,
  tokenFilePath: string,
): Promise<string> {
  return resolveCodexAppServerToken(sandbox, tokenFilePath, true);
}

function getCodexAppServerToken(
  sandbox: Sandbox,
  tokenFilePath: string = defaultRemoteCodexTokenPath(),
): Promise<string> {
  return resolveCodexAppServerToken(sandbox, tokenFilePath, false);
}

function withCodexAppServerAuthHeaders(
  base: Record<string, string>,
  token: string,
): Record<string, string> {
  return {
    ...base,
    Authorization: `Bearer ${token}`,
  };
}

function compactEnv(
  values: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;
}

export function buildCodexSandboxMode(
  options: AgentExecutionRequest<"codex">["options"],
) {
  return options.fullAccess ? "danger-full-access" : options.provider?.sandboxMode ?? (options.configuration === "native" ? undefined : options.sandbox ? "workspace-write" : "read-only");
}

/**
 * Thread-level config overrides, same shape as `codex -c key=value`.
 *
 * `effort` is turn-scoped in the protocol, and `thread/compact/start` and
 * `review/start` take no parameters beyond the thread (and a review
 * target), so their server-started turns run at the thread default. Naming
 * the effort here makes that default match what the run asked for. The
 * active collaboration mode has no such knob — it is turn-scoped with no
 * config equivalent — so compact and review always run in the default mode.
 */
function buildCodexThreadConfig(request: AgentExecutionRequest<"codex">) {
  return request.run.reasoning
    ? { config: { model_reasoning_effort: request.run.reasoning } }
    : {};
}

function buildThreadParams(
  cwd: string,
  options: AgentExecutionRequest<"codex">["options"],
  request: AgentExecutionRequest<"codex">,
) {
  return {
    cwd,
    model: request.run.model ?? null,
    ...(request.options.provider?.serviceTier !== undefined ? { serviceTier: request.options.provider.serviceTier } : {}),
    ...(options.provider?.approvalPolicy ? { approvalPolicy: options.provider.approvalPolicy } : options.configuration === "native" && !options.fullAccess ? {} : { approvalPolicy: !options.fullAccess && isInteractiveApproval(options) ? "untrusted" : "never" }),
    sandbox: buildCodexSandboxMode(options),
    ...buildCodexThreadConfig(request),
    serviceName: "agentbox",
    // Persist the rollout on disk so follow-up runs can call `thread/resume`.
    // `ephemeral: true` threads have no rollout file and resume fails with
    // "no rollout found for thread id ...".
    experimentalRawEvents: true,
    ...(request.run.systemPrompt ? { developerInstructions: request.run.systemPrompt } : options.configuration === "native" ? {} : { developerInstructions: null }),
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
    ...(request.options.provider?.serviceTier !== undefined ? { serviceTier: request.options.provider.serviceTier } : {}),
    ...(options.provider?.approvalPolicy ? { approvalPolicy: options.provider.approvalPolicy } : options.configuration === "native" && !options.fullAccess ? {} : { approvalPolicy: !options.fullAccess && isInteractiveApproval(options) ? "untrusted" : "never" }),
    sandbox: buildCodexSandboxMode(options),
    ...buildCodexThreadConfig(request),
    ...(request.run.systemPrompt ? { developerInstructions: request.run.systemPrompt } : options.configuration === "native" ? {} : { developerInstructions: null }),
    // We only need the thread id back; we never read `thread.turns`.
    // Without this Codex hydrates the full history into the response and
    // emits a `deprecationNotice` ("Full-history hydration is deprecated
    // for paginated threads").
    excludeTurns: true,
  };
}

/**
 * Fork-at-message maps onto Codex's native `thread/fork`:
 *
 *   - `threadId: forkSessionId` clones the source thread into a new id.
 *   - `lastTurnId: forkAtMessageId` (a turn id captured from a prior run)
 *     tells Codex to fork through that turn inclusive and drop everything
 *     after it, so no follow-up `thread/rollback` is needed. Codex rejects
 *     the request if the turn id is unknown or still in progress.
 *   - `excludeTurns: true` keeps `thread.turns` out of the response; we
 *     don't read it, and hydrating it triggers a `deprecationNotice`.
 *
 * Schema source of truth:
 *   - codex-rs/app-server-protocol/schema/typescript/v2/ThreadForkParams.ts
 *   - Turn.ts (Turn.id is the message id we fork through).
 */
function buildForkParams(
  cwd: string,
  options: AgentExecutionRequest<"codex">["options"],
  request: AgentExecutionRequest<"codex">,
) {
  return {
    threadId: request.run.forkSessionId,
    lastTurnId: request.run.forkAtMessageId ?? null,
    cwd,
    model: request.run.model ?? null,
    ...(request.options.provider?.serviceTier !== undefined ? { serviceTier: request.options.provider.serviceTier } : {}),
    ...(options.provider?.approvalPolicy ? { approvalPolicy: options.provider.approvalPolicy } : options.configuration === "native" && !options.fullAccess ? {} : { approvalPolicy: !options.fullAccess && isInteractiveApproval(options) ? "untrusted" : "never" }),
    sandbox: buildCodexSandboxMode(options),
    ...buildCodexThreadConfig(request),
    ...(request.run.systemPrompt ? { developerInstructions: request.run.systemPrompt } : options.configuration === "native" ? {} : { developerInstructions: null }),
    excludeTurns: true,
  };
}

function buildTurnSandboxPolicy(
  options: AgentExecutionRequest<"codex">["options"],
):
  | {
      type: "workspaceWrite";
      networkAccess: boolean;
      writableRoots?: string[];
    }
  | {
      type: "externalSandbox";
      networkAccess: "enabled" | "restricted";
    }
  | { type: "dangerFullAccess" }
  | undefined {
  if (options.fullAccess || options.provider?.sandboxMode === "danger-full-access") return { type: "dangerFullAccess" };
  if (!options.sandbox) {
    if (buildCodexSandboxMode(options) === undefined) return undefined;
    if (buildCodexSandboxMode(options) === "read-only") return undefined;
    return {
      type: "workspaceWrite",
      networkAccess: options.provider?.networkAccess ?? false,
      ...(options.provider?.writableRoots?.length
        ? { writableRoots: options.provider.writableRoots }
        : {}),
    };
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

export function buildCodexTurnStartParams(params: {
  threadId: string;
  inputItems: Array<Record<string, unknown>>;
  request: AgentExecutionRequest<"codex">;
}): Record<string, unknown> {
  const { threadId, inputItems, request } = params;
  const sandboxPolicy = buildTurnSandboxPolicy(request.options);
  return {
    threadId,
    input: inputItems,
    ...(request.options.provider?.approvalPolicy ? { approvalPolicy: request.options.provider.approvalPolicy } : request.options.configuration === "native" && !request.options.fullAccess ? {} : {
      approvalPolicy: !request.options.fullAccess && isInteractiveApproval(request.options) ? "untrusted" : "never",
    }),
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
    model: request.run.model ?? null,
    ...(request.options.provider?.serviceTier !== undefined ? { serviceTier: request.options.provider.serviceTier } : {}),
    effort: request.run.reasoning ?? null,
    ...(request.run.mode ? { collaborationMode: {
      mode: request.run.mode,
      settings: { model: request.run.model, reasoning_effort: request.run.reasoning ?? null, developer_instructions: null },
    } } : {}),
    outputSchema: null,
  };
}

/**
 * User text of the turn `attachAbort` starts only to interrupt it. A thread
 * waiting for native goal continuation has no active turn, so `turn/interrupt` alone
 * is rejected and reaches nobody; an interrupted turn is the one signal the
 * originating run already treats as a cancel.
 */
const CODEX_CANCEL_TURN_TEXT = "Run cancelled by the host.";

/** What the Codex TUI sends for `/init`; the app-server has no equivalent. */
const CODEX_INIT_PROMPT =
  "Generate a file named AGENTS.md that serves as a contributor guide for this repository.";
/** Commands resolved without the skill inventory. */
const CODEX_BUILTIN_COMMAND_NAMES = new Set(
  builtinHarnessCommands("codex").map((command) => command.name),
);

export type CodexCommandDispatch =
  | { kind: "compact" }
  | { kind: "review"; target: Record<string, unknown> }
  | { kind: "turn"; inputItems: Array<Record<string, unknown>> };

function replaceCodexPromptText(
  inputItems: Array<Record<string, unknown>>,
  text: string,
): Array<Record<string, unknown>> {
  let replaced = false;
  const next = inputItems.map((item) => {
    if (item.type !== "text" || replaced) return item;
    replaced = true;
    return { ...item, text };
  });
  return replaced ? next : [{ type: "text", text, text_elements: [] }, ...next];
}

/**
 * Codex never parses slash commands on `turn/start`, so a leading `/name`
 * maps here: `/compact` and `/review` become app-server calls, `/init`
 * becomes the TUI's canned prompt, a skill name becomes its `$name` mention,
 * and anything else stays plain text exactly as typed.
 */
export function resolveCodexCommandDispatch(
  command: HarnessCommandInvocation | undefined,
  inputItems: Array<Record<string, unknown>>,
  skillNames: ReadonlySet<string>,
): CodexCommandDispatch {
  if (!command) return { kind: "turn", inputItems };
  const args = command.args;
  switch (command.name) {
    case "compact":
      return { kind: "compact" };
    case "review":
      return {
        kind: "review",
        target: args ? { type: "custom", instructions: args } : { type: "uncommittedChanges" },
      };
    case "init":
      return { kind: "turn", inputItems: replaceCodexPromptText(inputItems, args ? `${CODEX_INIT_PROMPT} ${args}` : CODEX_INIT_PROMPT) };
    default:
      if (skillNames.has(command.name)) {
        const mention = codexSkillMention(command.name);
        return { kind: "turn", inputItems: replaceCodexPromptText(inputItems, args ? `${mention} ${args}` : mention) };
      }
      return { kind: "turn", inputItems };
  }
}

/**
 * How long a finished run waits for a still-pending skills listing before it
 * settles. See the emit in `execute` for why the wait exists at all.
 */
const HARNESS_COMMANDS_SETTLE_GRACE_MS = 500;

/**
 * Built-in commands plus the skills the app-server discovers for `cwd`. An
 * app-server without `skills/list` (or without the experimental API, which
 * answers -32600) still runs: the built-ins alone are reported.
 */
async function listCodexHarnessCommands(client: CodexRpcClient, cwd: string): Promise<HarnessCommandDescriptor[]> {
  type SkillsList = Parameters<typeof codexHarnessCommands>[0];
  try {
    const list = await withTimeout(client.request<SkillsList>("skills/list", { cwds: [cwd] }), 5_000);
    if (!list) throw new Error("skills/list timed out");
    return codexHarnessCommands(list);
  } catch (error) {
    debugCodex("skills/list unavailable; reporting built-in commands only: %o", error);
    return builtinHarnessCommands("codex");
  }
}

/**
 * Best-effort, bounded stop of every unified-exec process the app-server
 * still holds for the thread. Listing first also covers commands tracked
 * without a processId (an approval-flow `item/started` carries none). Any
 * error ends the pass: an app-server without the experimental API answers
 * with -32600 (invalid request), never -32601.
 */
async function terminateBackgroundTerminals(client: CodexRpcClient, threadId: string): Promise<void> {
  await withTimeout((async () => {
    try {
      const listed = await client.request<{ data?: Array<{ processId?: unknown }> }>(
        "thread/backgroundTerminals/list",
        { threadId },
      );
      for (const terminal of listed?.data ?? []) {
        if (typeof terminal?.processId !== "string") continue;
        await client.request("thread/backgroundTerminals/terminate", { threadId, processId: terminal.processId });
      }
    } catch (error) {
      debugCodex("background terminal termination stopped early: %o", error);
    }
  })(), STOP_TASKS_TIMEOUT_MS);
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

function buildCodexCommandArgs(
  binary: string,
  args: string[],
  options?: AgentOptions<"codex">,
): string[] {
  // We want codex to read its config from our deterministic layout
  // (`CODEX_HOME` is set by `SetupTarget` to `layout.codexDir`), so
  // unlike older versions of this code we do NOT strip `CODEX_HOME`
  // before launching. We still strip `XDG_CONFIG_HOME` because some
  // sandbox base images set it to a system path that codex would
  // otherwise prefer over `CODEX_HOME`.
  //
  // `-c key=value` overrides are inserted before the subcommand so
  // they apply across both `codex app-server` and the regular
  // turn-based invocation. Codex parses each `-c` value as TOML.
  const overrides: Array<[string, string]> = [];
  if (options?.provider?.supportsWebsockets === false) {
    overrides.push(["supports_websockets", "false"]);
  }
  const overrideArgs = overrides.flatMap(([k, v]) => ["-c", `${k}=${v}`]);
  return [...(options?.configuration === "native" ? [] : ["-u", "XDG_CONFIG_HOME"]), binary, ...overrideArgs, ...args];
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
    const turn = notification.params?.turn as
      | Record<string, unknown>
      | undefined;
    const turnId =
      typeof turn?.id === "string" ? (turn.id as string) : undefined;
    return [
      createNormalizedEvent(
        "message.started",
        base,
        turnId ? { messageId: turnId } : undefined,
      ),
    ];
  }

  if (notification.method === "item/agentMessage/delta") {
    const delta =
      typeof notification.params?.delta === "string"
        ? notification.params.delta
        : "";
    return delta ? [createNormalizedEvent("text.delta", base, { delta })] : [];
  }

  if (
    notification.method === "item/reasoning/summaryTextDelta" ||
    notification.method === "item/reasoning/textDelta"
  ) {
    const delta =
      typeof notification.params?.delta === "string"
        ? notification.params.delta
        : typeof notification.params?.text === "string"
          ? notification.params.text
          : "";
    return delta
      ? [createNormalizedEvent("reasoning.delta", base, { delta })]
      : [];
  }

  if (notification.method === "item/completed") {
    const item = notification.params?.item as
      | Record<string, unknown>
      | undefined;
    if (!item) {
      return [];
    }

    if (item.type === "agentMessage" && typeof item.text === "string") {
      // Each agentMessage item produces one `message.completed`. The host
      // tracks the LAST message text as the final `result.text`, so a
      // narration message emitted before tool calls is superseded by the
      // final answer message — only the last one wins.
      // A `request_user_input_async` call becomes an agentMessage with
      // `delivery: "async"` and `questions`; the app-server answers the tool
      // call itself and the turn continues, so the ask travels with the text
      // instead of pausing as `permission.requested`.
      const questions = normalizeAsyncUserQuestions(AgentProvider.Codex, item.questions);
      return [
        createNormalizedEvent("message.completed", base, {
          text: item.text,
          ...(questions ? { questions } : {}),
        }),
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
  fileChanges?: unknown[],
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
        input: fileChanges ? { ...params, changes: fileChanges } : params,
        canRemember: availableDecisions.includes("acceptForSession"),
      },
    ) as PermissionRequestedEvent;
  }

  return null;
}

const CODEX_ELICITATION_METHOD = "mcpServer/elicitation/request";

/** Codex gates MCP tool calls (code mode included) behind a form elicitation
 * tagged with `_meta.codex_approval_kind`. Unlike command or file approvals,
 * it is answered with an elicitation result rather than a decision. */
function createCodexElicitationPermissionEvent(
  request: AgentExecutionRequest<"codex">,
  notification: CodexNotification,
): PermissionRequestedEvent | null {
  if (notification.method !== CODEX_ELICITATION_METHOD || notification.id === undefined) {
    return null;
  }
  const params = notification.params ?? {};
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  if (meta.codex_approval_kind !== "mcp_tool_call") {
    return null;
  }
  const raw = toRawEvent(request.runId, notification, notification.method);
  const toolName =
    typeof meta.tool_name === "string" ? meta.tool_name : undefined;
  const server =
    typeof params.serverName === "string" ? params.serverName : undefined;
  const persist = Array.isArray(meta.persist) ? meta.persist : [];
  return createNormalizedEvent(
    "permission.requested",
    { provider: request.provider, runId: request.runId, raw },
    {
      requestId: String(notification.id),
      kind: "tool",
      toolName: toolName ?? server,
      title: "Approve tool call",
      message:
        typeof params.message === "string" && params.message.trim()
          ? params.message
          : `Codex wants to call ${toolName ?? "an MCP tool"}${server ? ` on ${server}` : ""}.`,
      input: { server, tool: toolName, arguments: meta.tool_params, ...params },
      canRemember: persist.includes("session"),
    },
  ) as PermissionRequestedEvent;
}

function toCodexElicitationResult(
  notification: CodexNotification,
  response: { decision: "allow" | "deny"; remember?: boolean },
): { action: "accept" | "decline"; content: null; _meta?: { persist: "session" } } {
  if (response.decision === "deny") {
    return { action: "decline", content: null };
  }
  const meta = (notification.params?._meta ?? {}) as Record<string, unknown>;
  const persist = Array.isArray(meta.persist) ? meta.persist : [];
  return response.remember && persist.includes("session")
    ? { action: "accept", content: null, _meta: { persist: "session" } }
    : { action: "accept", content: null };
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
    // A denial refuses this action; cancellation interrupts the entire turn.
    // availableDecisions is optional for commands and absent on file-change
    // approvals, so its omission must never turn Deny into Stop.
    return "decline";
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

/**
 * Materialize a per-turn image attachment to disk so codex can
 * reference it by path. Per-RUN concern — this is part of the user's
 * input for the current turn, not agent-config — so it lives on the
 * execute path. We dispatch on `options.sandbox`:
 *
 *  - **Sandbox**: stage the base64 payload via `sandbox.uploadAndRun`
 *    so the upload + decode + cleanup happen in a single RPC.
 *  - **Local host**: decode in JS and write the binary directly with
 *    `fs.writeFile`, avoiding a shell round-trip entirely.
 */
async function materializeCodexImage(
  options: AgentOptions<"codex">,
  part: ResolvedImagePart,
  index: number,
): Promise<string> {
  if (part.source.type === "url") {
    return part.source.url;
  }

  const data = Buffer.from(part.source.data, "base64");
  if (data.length === 0) {
    throw new Error("Cannot attach an empty image to Codex.");
  }

  const root = agentboxRoot(AgentProvider.Codex, Boolean(options.sandbox), options.stateDirectory);
  const imagePath = path.join(
    root,
    "inputs",
    `codex-image-${index}-${crypto.randomUUID()}${codexImageExtension(part.mediaType)}`,
  );

  if (options.sandbox) {
    const result = await options.sandbox.uploadAndRun(
      [{ path: imagePath, content: data }],
      `test "$(wc -c < ${shellQuote(imagePath)})" -eq ${data.length}`,
      { cwd: options.cwd, env: options.env },
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to upload image attachment to Codex (exit ${result.exitCode}): the file could not be written or its size did not match.`,
      );
    }

    return imagePath;
  }

  const fs = await import("node:fs/promises");
  await fs.mkdir(path.dirname(imagePath), { recursive: true });
  await fs.writeFile(imagePath, data);
  return imagePath;
}

function resolveCodexOpenAiBaseUrlFromOptions(
  options: AgentOptions<"codex">,
): string | undefined {
  return options.env?.OPENAI_BASE_URL ?? options.provider?.env?.OPENAI_BASE_URL;
}

/**
 * Env codex reads credentials from, merging the agent's base env and the
 * provider-scoped overrides (the same precedence `createRuntime` and the
 * app-server launch use). Used to detect provider API keys.
 */
function codexCredentialEnv(
  options: AgentOptions<"codex">,
): Record<string, string> {
  return { ...(options.env ?? {}), ...(options.provider?.env ?? {}) };
}

/**
 * Resolve the codex `model_providers` map + top-level `model_provider`
 * selection for an agent.
 *
 * Starts from the caller's explicit `provider.modelProviders`. Selection is
 * only the caller's explicit `provider.modelProvider`; when omitted, Codex
 * falls back to its built-in `openai` provider.
 */
export function resolveCodexModelProviders(options: AgentOptions<"codex">): {
  modelProviders: Record<string, CodexModelProviderConfig>;
  modelProvider: string | undefined;
} {
  const modelProviders: Record<string, CodexModelProviderConfig> = {
    ...(options.provider?.modelProviders ?? {}),
  };

  const modelProvider = options.provider?.modelProvider;

  const customHeaders = options.customHeaders;
  if (customHeaders && Object.keys(customHeaders).length > 0) {
    // Codex can only attach `http_headers` to a `[model_providers.<id>]` block.
    // When no explicit provider is selected, Codex uses its built-in `openai`
    // provider, which has no table to hang headers on and cannot be overridden
    // as `[model_providers.openai]`. Do not synthesize/select a replacement
    // provider solely for headers: that changes Codex's model-provider identity
    // and breaks child-agent model resolution in `spawn_agent`.
    for (const [id, cfg] of Object.entries(modelProviders)) {
      modelProviders[id] = {
        ...cfg,
        httpHeaders: { ...(cfg.httpHeaders ?? {}), ...customHeaders },
      };
    }
  }

  return { modelProviders, modelProvider };
}

/**
 * Stable fingerprint of the API-key secrets the resolved providers depend
 * on. The codex app-server reads these from its process env at launch
 * time only (the secret value is never written into config.toml — only
 * the `env_key` *name* is), so a key change is invisible to an
 * already-running shared server. Folding this into the setupId flips the
 * setup marker, misses the preflight, and forces a respawn so the new
 * credentials take effect — mirroring opencode's `hashLlmApiKeys`.
 */
function hashCodexProviderCredentials(
  options: AgentOptions<"codex">,
  modelProviders: Record<string, CodexModelProviderConfig>,
): string {
  const env = codexCredentialEnv(options);
  const envKeyNames = new Set<string>(["OPENAI_API_KEY"]);
  for (const cfg of Object.values(modelProviders)) {
    if (cfg.envKey) {
      envKeyNames.add(cfg.envKey);
    }
    for (const envVar of Object.values(cfg.envHttpHeaders ?? {})) {
      envKeyNames.add(envVar);
    }
  }
  const hasher = crypto.createHash("sha256");
  for (const name of [...envKeyNames].sort()) {
    if (env[name] !== undefined) {
      hasher.update(`${name}=${env[name]}\n`);
    }
  }
  return hasher.digest("hex");
}

async function ensureCodexLoginViaConfig(
  request: AgentSetupRequest<"codex">,
  target: SetupTarget,
): Promise<void> {
  const options = request.options;
  const openAiApiKey =
    options.env?.OPENAI_API_KEY ?? options.provider?.env?.OPENAI_API_KEY;
  const openAiBaseUrl = resolveCodexOpenAiBaseUrlFromOptions(options);

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
  // `CODEX_HOME` is inherited from `target.env` so the login token
  // lands in our layout's `<codexDir>/auth.json` (where the app-server
  // will look for it), not in the user's actual `~/.codex/`. We have
  // to `mkdir -p` first because sandbox layouts only get materialized
  // by the subsequent tar-extract during `applyDifferentialSetup`, and
  // `codex login` would otherwise fail trying to write `auth.json`
  // into a non-existent directory.
  //
  // We deliberately do NOT silence stdout/stderr — if `codex login`
  // fails, the sandbox surfaces the error and the operator can see why
  // (bad key, network, missing binary, etc.) instead of a bare
  // "exit 1".
  await target.runCommand(
    [
      'if [ -z "${OPENAI_API_KEY:-}" ]; then exit 0; fi',
      'mkdir -p "${CODEX_HOME:-$HOME/.codex}"',
      // Merge stderr into stdout so providers that don't surface stderr
      // (e.g. Daytona's `executeCommand`, which collapses to a single
      // `result` field) still propagate the underlying error message
      // back to the caller — otherwise a failed login leaves us with a
      // bare "exit 1" and no diagnostic.
      "printenv OPENAI_API_KEY | env -u XDG_CONFIG_HOME codex login --with-api-key 2>&1",
    ].join("; "),
    Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
  );
}

function toRemoteCodexWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString();
}

/**
 * Open a short-lived JSON-RPC client against the in-sandbox codex
 * app-server, run `body`, and close. Used by `attachAbort` /
 * `attachSendMessage` to perform a single RPC and disconnect.
 */
async function withCodexAppServer<T>(
  request: AgentAttachRequest<"codex">,
  body: (client: JsonRpcLineClient<CodexNotification>) => Promise<T>,
): Promise<T> {
  const sandbox = request.sandbox;
  if (sandbox.provider === SandboxProvider.LocalDocker) {
    throw new Error(
      "Codex stateless attach is not supported for local-docker sandboxes; the app-server is in-process.",
    );
  }
  const previewUrl = await sandbox.getPreviewLink(REMOTE_CODEX_APP_SERVER_PORT);
  const token = await getCodexAppServerToken(sandbox);
  const transport = await connectJsonRpcWebSocket(
    toRemoteCodexWebSocketUrl(previewUrl),
    { headers: withCodexAppServerAuthHeaders(sandbox.previewHeaders, token) },
  );
  const client = new JsonRpcLineClient<CodexNotification>(
    transport.source,
    transport.send,
  );
  try {
    await client.request("initialize", {
      clientInfo: { title: "AgentBox", name: "AgentBox", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    await client.notify("initialized", {});
    return await body(client);
  } finally {
    await transport.close().catch(() => undefined);
  }
}

async function connectRemoteCodexAppServer(
  url: string,
  headers: Record<string, string> = {},
) {
  return time(debugCodex, "connectRemoteCodexAppServer", async () => {
    const startedAt = Date.now();
    let attempt = 0;
    let lastError: unknown;

    while (Date.now() - startedAt < 30_000) {
      attempt++;
      try {
        const conn = await connectJsonRpcWebSocket(url, { headers });
        if (attempt > 1) {
          debugCodex("connected after %d attempt(s)", attempt);
        }
        return conn;
      } catch (error) {
        lastError = error;
        await sleep(250);
      }
    }

    throw (
      lastError ?? new Error(`Could not connect to Codex app-server at ${url}.`)
    );
  });
}

/**
 * Sandbox-side preparation for codex.
 *
 * `setup()` is the ONLY place agent-config (skills, commands, MCPs,
 * hooks, sub-agents) is read. All of it lands on disk under
 * `target.layout.codexDir` so the codex CLI auto-discovers it on the
 * next launch and `execute()` doesn't have to thread any of it through
 * the wire protocol.
 *
 * Side effects (all idempotent):
 *   1. `codex login` (writes `<codexDir>/auth.json` if missing).
 *   2. Upload artifacts: mcp/hook/sub-agent/skill files + `config.toml`
 *      with feature flags (`skills`, `multi_agent`, `codex_hooks`) and
 *      static `openai_base_url` baked in.
 *   3. For remote sandboxes, ensure the codex app-server is running
 *      on `REMOTE_CODEX_APP_SERVER_PORT` (probe + spawn on cold path).
 *
 * No system-prompt file is written: the system prompt is per-RUN
 * (`AgentRunConfig`) and passed as `developerInstructions` in the
 * `thread/start` params inside `execute()` instead.
 */
async function setupCodex(request: AgentSetupRequest<"codex">): Promise<void> {
  const options = request.options;
  if (options.configuration === "native") return;
  const provider = request.provider;
  const hooks = assertHooksSupported(provider, options);
  assertCommandsSupported(provider, options.commands);

  // Resolve custom model providers once so both the config.toml artifact and
  // the credential fingerprint below see the same provider map.
  const { modelProviders, modelProvider } = resolveCodexModelProviders(options);
  const providerCredHash = hashCodexProviderCredentials(
    options,
    modelProviders,
  );

  const usesRemoteWebSocket =
    options.sandbox && options.sandbox.provider !== SandboxProvider.LocalDocker;

  // Build everything that goes on disk in one place. The same
  // `buildCodexConfigToml` powers both modes; only WHERE we write the
  // artifacts (sharedTarget vs target) and whether we additionally
  // launch the remote app-server changes.
  function buildArtifactsFor(layoutTarget: SetupTarget): {
    artifacts: Array<{ path: string; content: string; executable?: boolean }>;
    installCommands: string[];
  } {
    const defaultModel = options.provider?.defaultModel;
    const { artifacts: subAgentArtifacts, agentSections } =
      buildCodexSubagentArtifacts(
        options.subAgents,
        layoutTarget.layout,
        defaultModel,
      );
    const hooksFile = buildCodexHooksFile(hooks);
    const enableMultiAgent = (options.subAgents?.length ?? 0) > 0;
    const enableSkills = (options.skills?.length ?? 0) > 0;
    const openAiBaseUrl = resolveCodexOpenAiBaseUrlFromOptions(options);

    const configToml = buildCodexConfigToml({
      mcps: options.mcps,
      agentSections,
      enableHooks: Boolean(hooksFile),
      enableSkills,
      enableMultiAgent,
      openAiBaseUrl,
      model: defaultModel,
      modelProvider,
      modelProviders,
    });

    const artifacts: Array<{
      path: string;
      content: string;
      executable?: boolean;
    }> = [...subAgentArtifacts];

    if (configToml) {
      artifacts.push({
        path: path.join(layoutTarget.layout.codexDir, "config.toml"),
        content: configToml,
      });
    }
    if (hooksFile) {
      artifacts.push({
        path: path.join(layoutTarget.layout.codexDir, "hooks.json"),
        content: JSON.stringify(hooksFile, null, 2),
      });
    }

    return { artifacts, installCommands: [] };
  }

  if (usesRemoteWebSocket && options.sandbox) {
    const sandbox = options.sandbox;
    const sharedTarget = await createSetupTarget(
      provider,
      REMOTE_CODEX_APP_SERVER_ID,
      options,
    );
    const target = await createSetupTarget(provider, "shared-setup", options);
    const env = compactEnv({
      ...(options.env ?? {}),
      ...sharedTarget.env,
      ...(options.provider?.env ?? {}),
    });

    const tokenFilePath = path.posix.join(
      sharedTarget.layout.rootDir,
      CODEX_APP_SERVER_TOKEN_FILENAME,
    );
    const appServerToken = await ensureCodexAppServerToken(
      sandbox,
      tokenFilePath,
    );

    const { artifacts: baseServerArtifacts } = buildArtifactsFor(sharedTarget);
    const serverArtifacts = [
      ...baseServerArtifacts,
      { path: tokenFilePath, content: appServerToken },
    ];
    const { artifacts: skillArtifacts, installCommands } =
      await prepareSkillArtifacts(provider, options.skills, target.layout);

    const enableRtk = options.enableRtk === true;
    const daemonInfo = {
      port: REMOTE_CODEX_APP_SERVER_PORT,
      healthPath: "/readyz",
    };
    const setupId = computeSetupId({
      artifacts: [...serverArtifacts, ...skillArtifacts],
      installCommands,
      daemon: daemonInfo,
      extras: [`enableRtk:${enableRtk}`, `providerCreds:${providerCredHash}`],
    });
    if (await preflightSetup(sharedTarget, setupId, daemonInfo)) {
      debugCodex("codex remote setup() preflight hit — skipping");
      return;
    }

    await time(debugCodex, "ensureCodexLogin", () =>
      ensureCodexLoginViaConfig(request, sharedTarget),
    );

    await applyDifferentialSetup(sharedTarget, serverArtifacts, []);

    const binary = options.provider?.binary ?? "codex";
    const pidFilePath = path.posix.join(
      sharedTarget.layout.rootDir,
      "codex-app-server.pid",
    );
    const logFilePath = path.posix.join(
      sharedTarget.layout.rootDir,
      "codex-app-server.log",
    );
    const serverCwd = sharedTarget.layout.rootDir;
    const launchResult = await time(
      debugCodex,
      "restart app-server after setup miss",
      () =>
        sandbox.run(
          [
            `mkdir -p ${shellQuote(sharedTarget.layout.rootDir)}`,
            [
              `if curl -fsS http://127.0.0.1:${REMOTE_CODEX_APP_SERVER_PORT}/readyz >/dev/null 2>&1; then`,
              `  if [ -f ${shellQuote(pidFilePath)} ]; then kill "$(cat ${shellQuote(pidFilePath)})" >/dev/null 2>&1 || true; else fuser -k -n tcp ${REMOTE_CODEX_APP_SERVER_PORT} >/dev/null 2>&1 || true; fi`,
              `  for i in 1 2 3 4 5; do if ! curl -fsS http://127.0.0.1:${REMOTE_CODEX_APP_SERVER_PORT}/readyz >/dev/null 2>&1; then break; fi; sleep 0.2; done`,
              `  if curl -fsS http://127.0.0.1:${REMOTE_CODEX_APP_SERVER_PORT}/readyz >/dev/null 2>&1; then if [ -f ${shellQuote(pidFilePath)} ]; then kill -9 "$(cat ${shellQuote(pidFilePath)})" >/dev/null 2>&1 || true; else fuser -k -n tcp ${REMOTE_CODEX_APP_SERVER_PORT} >/dev/null 2>&1 || true; fi; fi`,
              `  rm -f ${shellQuote(pidFilePath)}`,
              `fi`,
            ].join("\n"),
            `chmod 600 ${shellQuote(tokenFilePath)}`,
            `(${[
              `nohup ${[
                "env",
                ...buildCodexCommandArgs(
                  binary,
                  [
                    "app-server",
                    "--listen",
                    `ws://0.0.0.0:${REMOTE_CODEX_APP_SERVER_PORT}`,
                    // Auth on non-loopback listeners is opt-in in codex; without
                    // these flags the 0.0.0.0 app-server accepts unauthenticated
                    // clients. Requires codex >= 0.133 (`--ws-auth` flag); older
                    // pinned binaries will fail to launch on the unknown arg.
                    "--ws-auth",
                    "capability-token",
                    "--ws-token-file",
                    tokenFilePath,
                  ],
                  options,
                ),
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
        ),
    );
    if (launchResult.exitCode !== 0) {
      throw new Error(
        `Could not start Codex app-server: ${launchResult.combinedOutput || launchResult.stderr}`,
      );
    }

    // Skills land on the per-run `target` layout (not the shared
    // app-server one) because the skills CLI is allowed to mutate
    // sandboxed paths. The skill files end up at
    // `<codexDir>/skills/<name>/SKILL.md` which codex auto-discovers.
    try {
      await applyDifferentialSetup(target, skillArtifacts, installCommands);
    } catch (error) {
      await target.cleanup().catch(() => undefined);
      throw error;
    }

    if (enableRtk) {
      await time(debugCodex, "activateRtk", () => activateRtk(sharedTarget));
    }

    await markSetupComplete(sharedTarget, setupId);
    return;
  }

  // Local mode: everything goes on the same target.
  const target = await createSetupTarget(provider, "shared-setup", options);

  const { artifacts: skillArtifacts, installCommands } =
    await prepareSkillArtifacts(provider, options.skills, target.layout);
  const { artifacts: configArtifacts } = buildArtifactsFor(target);
  const allArtifacts = [...skillArtifacts, ...configArtifacts];

  const enableRtk = options.enableRtk === true;
  // Local mode has no in-process daemon to probe — only the artifact set
  // matters. setupId match short-circuits the upload + login.
  const setupId = computeSetupId({
    artifacts: allArtifacts,
    installCommands,
    extras: [`enableRtk:${enableRtk}`, `providerCreds:${providerCredHash}`],
  });
  if (await preflightSetup(target, setupId)) {
    debugCodex("codex local setup() preflight hit — skipping");
    return;
  }

  try {
    await ensureCodexLoginViaConfig(request, target);
  } catch (error) {
    await target.cleanup().catch(() => undefined);
    throw error;
  }

  await applyDifferentialSetup(target, allArtifacts, installCommands);

  if (enableRtk) {
    await time(debugCodex, "activateRtk", () => activateRtk(target));
  }

  await markSetupComplete(target, setupId);
}

async function createRuntime(
  request: Pick<AgentExecutionRequest<"codex">, "options">,
  inputParts: Awaited<ReturnType<typeof validateProviderUserInput>>,
): Promise<CodexRuntime> {
  const options = request.options;
  // Spawn context — constants only. `setup()` already wrote
  // config.toml, hooks.json, agents/, skills/ under `codexDir`; the
  // codex CLI auto-discovers them via `CODEX_HOME`.
  const codexDir = codexConfigDir(options);
  const env = compactEnv({
    ...(options.env ?? {}),
    ...(options.configuration === "native" ? {} : { CODEX_HOME: codexDir }),
    ...(options.provider?.env ?? {}),
  });
  // The codex daemon launches with cwd=<root>. The thread it runs
  // operates on whatever cwd the per-thread `thread/start` params
  // specify, which is `options.cwd` set by the caller.
  const runtimeCwd = options.configuration === "native" ? options.cwd : path.dirname(codexDir);
  const inputItems = await buildCodexInputItems(options, inputParts);

  const usesRemoteWebSocket =
    options.sandbox && options.sandbox.provider !== SandboxProvider.LocalDocker;

  if (usesRemoteWebSocket && options.sandbox) {
    const sandbox = options.sandbox;
    const previewUrl = await time(debugCodex, "getPreviewLink app-server", () =>
      sandbox.getPreviewLink(REMOTE_CODEX_APP_SERVER_PORT),
    );

    const token = await getCodexAppServerToken(sandbox);
    const transport = await connectRemoteCodexAppServer(
      toRemoteCodexWebSocketUrl(previewUrl),
      withCodexAppServerAuthHeaders(sandbox.previewHeaders, token),
    );
    debugCodex("★ codex transport established");
    return {
      source: transport.source,
      writeLine: transport.send,
      cleanup: async () => {
        await transport?.close().catch(() => undefined);
      },
      raw: {
        transport: transport.raw,
        previewUrl,
        port: REMOTE_CODEX_APP_SERVER_PORT,
        codexDir,
      },
      inputItems,
    };
  }

  // Local mode launches the codex binary fresh per execute call.
  // Every config flag previously passed via `-c` (multi_agent, skills,
  // openai_base_url, model_instructions_file) now lives in
  // `config.toml` written by `setup()`, so the CLI args are
  // spawn-context only.
  const codexArgs = buildCodexCommandArgs(
    options.provider?.binary ?? "codex",
    ["app-server"],
    options,
  );

  if (options.sandbox) {
    const handle = await options.sandbox.runAsync(["env", ...codexArgs], {
      cwd: runtimeCwd,
      env,
    });

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
      },
      raw: { handle, codexDir },
      inputItems,
    };
  }

  const processHandle = spawnCommand({
    processGroup: options.processGroup !== "inherited",
    command: "env",
    args: codexArgs,
    cwd: runtimeCwd,
    env: {
      ...process.env,
      ...env,
    },
  });

  processHandle.child.stderr.resume();
  return {
    source: linesFromNodeStream(processHandle.child.stdout),
    writeLine: async (line: string) => {
      processHandle.child.stdin.write(`${line}\n`);
    },
    cleanup: async () => {
      await processHandle.kill();
    },
    isAlive: () => processHandle.child.exitCode === null && processHandle.child.signalCode === null && !processHandle.child.killed,
    raw: { processHandle, codexDir },
    inputItems,
  };
}

/**
 * Build the per-turn `inputItems` array consumed by codex's
 * `turn/start`. Carries only the user prompt and materialized image
 * attachments — skill discovery is file-based (codex picks up
 * `<CODEX_HOME>/skills/<name>/SKILL.md` at startup), so no per-turn
 * skill input items are emitted here.
 */
async function buildCodexInputItems(
  options: AgentOptions<"codex">,
  inputParts: Awaited<ReturnType<typeof validateProviderUserInput>>,
): Promise<Array<Record<string, unknown>>> {
  // Keep text blocks separate: command dispatch replaces only the first
  // block, and later blocks may carry additional instructions or context.
  const inputItems: Array<Record<string, unknown>> = inputParts.flatMap(
    (part) => part.type === "text" && part.text.trim().length > 0
      ? [{ type: "text", text: part.text, text_elements: [] }]
      : [],
  );

  inputItems.push(
    ...(await mapToCodexPromptParts(inputParts, async (part, index) =>
      materializeCodexImage(options, part, index),
    )),
  );

  return inputItems;
}

/**
 * Explicit, developer-invoked teardown of the shared codex app-server
 * (see {@link AgentProviderAdapter.killServer}). agentbox never calls this
 * automatically. No-op in local mode, where codex spawns a fresh
 * `app-server` per run (its lifecycle is tied to the run, not shared).
 */
async function killCodexAppServer(
  request: AgentSetupRequest<"codex">,
): Promise<void> {
  const { options } = request;
  const sandbox = options.sandbox;
  if (!sandbox) return;
  const sharedTarget = await createSetupTarget(
    request.provider,
    REMOTE_CODEX_APP_SERVER_ID,
    options,
  );
  const pidFilePath = path.posix.join(
    sharedTarget.layout.rootDir,
    "codex-app-server.pid",
  );
  await sandbox
    .run(
      [
        `if [ -f ${shellQuote(pidFilePath)} ]; then kill "$(cat ${shellQuote(pidFilePath)})" 2>/dev/null || true; rm -f ${shellQuote(pidFilePath)}; fi`,
        `fuser -k -n tcp ${REMOTE_CODEX_APP_SERVER_PORT} 2>/dev/null || true`,
      ].join("; "),
      { cwd: options.cwd, timeoutMs: 10_000 },
    )
    .catch(() => undefined);
}

async function initializeCodexClient(client: CodexRpcClient): Promise<void> {
  await client.request("initialize", {
    clientInfo: { title: "AgentBox", name: "AgentBox", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  await client.notify("initialized", {});
}

export class CodexAgentAdapter implements AgentProviderAdapter<"codex"> {
  private prepared?: CodexRuntime;
  private preparationGeneration = 0;

  async setup(request: AgentSetupRequest<"codex">): Promise<void> {
    const generation = this.preparationGeneration;
    if (request.options.provider?.prewarm && request.options.sandbox) {
      throw new Error("Codex prewarm is only supported for host execution.");
    }
    await setupCodex(request);
    if (!request.options.provider?.prewarm || this.prepared?.isAlive?.()) return;
    await this.prepared?.cleanup();
    if (generation !== this.preparationGeneration) throw new Error("Codex preparation was cancelled.");
    const runtime = await createRuntime(request, []);
    if (generation !== this.preparationGeneration) {
      await runtime.cleanup();
      throw new Error("Codex preparation was cancelled.");
    }
    const client = new JsonRpcLineClient<CodexNotification>(runtime.source!, runtime.writeLine!);
    const prepared = { ...runtime, client };
    this.prepared = prepared;
    try {
      await withTimeout(initializeCodexClient(client), 10_000);
      if (this.prepared !== prepared) throw new Error("Codex preparation was cancelled.");
    } catch (error) {
      if (this.prepared === prepared) this.prepared = undefined;
      await runtime.cleanup();
      throw error;
    }
  }

  async killServer(request: AgentSetupRequest<"codex">): Promise<void> {
    this.preparationGeneration++;
    const prepared = this.prepared;
    this.prepared = undefined;
    await prepared?.cleanup();
    await killCodexAppServer(request);
  }

  async execute(
    request: AgentExecutionRequest<"codex">,
    sink: AgentRunSink,
  ): Promise<() => Promise<void>> {
    const executeStartedAt = Date.now();
    debugCodex("execute() start runId=%s", request.runId);
    const inputParts = await time(debugCodex, "validateProviderUserInput", () =>
      validateProviderUserInput(request.provider, request.run.input),
    );
    // The system prompt is per-RUN and delivered via `developerInstructions`
    // in the `thread/start` params. Agent-config is on disk and discovered
    // via `CODEX_HOME`. `createRuntime` does the wire dial / binary spawn
    // from `request.options` directly.
    // A prepared process is consumed exactly once. Execution and abort keep
    // their existing process ownership, including all tool descendants.
    const prepared = this.prepared;
    this.prepared = undefined;
    let runtime: CodexRuntime;
    if (prepared?.isAlive?.()) {
      try {
        runtime = { ...prepared, inputItems: await buildCodexInputItems(request.options, inputParts) };
      } catch (error) {
        await prepared.cleanup();
        throw error;
      }
    } else {
      await prepared?.cleanup();
      runtime = await time(debugCodex, "createRuntime", () => createRuntime(request, inputParts));
    }
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
    let abortInvoked = false;

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
      abortInvoked = true;
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

    const sendTurn = async (
      content: UserContent,
    ): Promise<{ messageId?: string }> => {
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
      // Codex's app-server consolidates a follow-up `turn/start` into
      // whichever turn is currently in flight on this thread — it
      // does NOT fire a separate `turn/started` / `turn/completed`
      // pair for the queued message. The next `turn/completed` carries the
      // merged response; only an active native goal keeps the run open.
      const response = await client.request<{ turn?: { id?: string } }>(
        "turn/start",
        buildCodexTurnStartParams({
          threadId: rootThreadId,
          inputItems,
          request,
        }),
      );
      return {
        ...(typeof response?.turn?.id === "string"
          ? { messageId: response.turn.id }
          : {}),
      };
    };

    sink.onMessage(sendTurn);

    const rawPayloads: Array<Record<string, unknown>> = [];
    // File approval frames only contain an item ID; the preceding item event
    // carries paths and diffs. Keep a bounded, thread/turn-scoped preview for
    // human review without changing the approval decision sent to Codex.
    const pendingFileChanges = new Map<string, unknown[]>();
    const fileItemKey = (params: Record<string, unknown> | undefined, itemId: unknown) =>
      typeof params?.threadId === "string" && typeof params.turnId === "string" && typeof itemId === "string"
        ? `${params.threadId}:${params.turnId}:${itemId}` : undefined;
    let streamedText = "";
    const timeoutMs = resolveBackgroundTaskTimeoutMs(request.options.backgroundTaskTimeoutMs);
    const isRootThread = (params: Record<string, unknown> | undefined) =>
      !params?.threadId || params.threadId === rootThreadId;
    // Goal state is authoritative for whether Codex intends to continue. A
    // terminal goal may leave preview servers running intentionally; an active
    // one can start another turn even without any outstanding shell commands.
    let goalStatus: string | undefined = request.run.goal ? "active" : undefined;
    // Codex owns command polling and subagent waits. A completed ordinary
    // turn is final even with live processes. Only native goal continuation
    // keeps this transport open between turns.
    let pendingWait: BackgroundWait | undefined;
    // The host moved on (finishBackgroundWait): latched, so a request made
    // mid-turn ends the wait that turn would otherwise start.
    const finishWait = new BackgroundWaitFinish();
    sink.setFinishBackgroundWait?.(() => finishWait.request());
    // Time already spent waiting: the ceiling bounds the run, not each wait.
    let waitedMs = 0;
    // Last agentMessage of the current turn; a follow-up turn's supersedes it.
    let turnMessageText = "";
    let lastTurn: { text: string; messageText: string } | undefined;
    let goalWaiting = false;
    const emitGoalWaiting = (waiting: boolean) => {
      if (waiting === goalWaiting) return;
      goalWaiting = waiting;
      sink.emitEvent(createNormalizedEvent("background.tasks", { provider: request.provider, runId: request.runId }, { tasks: [], waiting }));
    };
    const endWait = () => {
      if (!pendingWait) return;
      waitedMs += pendingWait.elapsedMs();
      pendingWait.clear();
      pendingWait = finishWait.watch(undefined);
      emitGoalWaiting(false);
    };
    const completion = new Promise<{
      text?: string;
      turnId?: string;
      threadId?: string;
      interrupted?: boolean;
    }>((resolve, reject) => {
      // Ends a wait with the last completed turn as the run's answer. That
      // turn's `run.completed` was withheld when the wait began: emit it now.
      const settle = () => {
        endWait();
        sink.emitEvent(createNormalizedEvent("run.completed", { provider: request.provider, runId: request.runId }, { text: lastTurn?.messageText || undefined }));
        resolve({ text: lastTurn?.text ?? streamedText, turnId, threadId: rootThreadId, interrupted: false });
      };
      // A transport failure while waiting for native goal continuation
      // must not turn a complete answer into a failed run.
      const settleOnFailure = (error: unknown): boolean => {
        if (!pendingWait || !lastTurn || abortInvoked) return false;
        debugCodex("★ transport failed during goal wait; settling on the last turn: %o", error);
        settle();
        return true;
      };
      void (async () => {
        let firstClientMessageLogged = false;
        const iterator = client.messages()[Symbol.asyncIterator]();
        type Step = { result: IteratorResult<CodexNotification> } | { reason: BackgroundWaitExpiry };
        // Manual iteration so a wait timer can race the transport read. A read
        // left pending by an expiry unwinds when cleanup() closes the transport.
        for (let next = iterator.next(); ; next = iterator.next()) {
          let step: Step;
          try {
            step = pendingWait
              ? await Promise.race([
                  next.then((result) => ({ result })),
                  pendingWait.expired.then((reason) => ({ reason })),
                ])
              : { result: await next };
          } catch (error) {
            if (settleOnFailure(error)) return;
            throw error;
          }
          if ("reason" in step) {
            if (!abortInvoked) {
              debugCodex("★ native goal wait over (%s)", step.reason);
              settle();
              return;
            }
            // The abort handler is closing the transport, which ends the
            // pending read (a failure there rejects into the cancel). A run
            // the host is cancelling never settles.
            endWait();
            step = { result: await next };
          }
          if (step.result.done) break;
          const message = step.result.value;
          if (!firstClientMessageLogged) {
            firstClientMessageLogged = true;
            debugCodex(
              "★ first transport message (%dms since execute start) method=%s",
              Date.now() - executeStartedAt,
              message.method,
            );
          }
          const raw = toRawEvent(request.runId, message, message.method);
          rawPayloads.push(message);
          sink.emitRaw(raw);

          const item = message.params?.item as Record<string, unknown> | undefined;
          const itemKey = fileItemKey(message.params, item?.id);
          if (itemKey && item?.type === "fileChange") {
            if (message.method === "item/completed") pendingFileChanges.delete(itemKey);
            else if (message.method === "item/started" && Array.isArray(item.changes)) {
              if (pendingFileChanges.size >= 128) pendingFileChanges.delete(pendingFileChanges.keys().next().value!);
              pendingFileChanges.set(itemKey, item.changes);
            }
          }

          if (
            (message.method === "item/tool/requestUserInput" || message.method === "tool/requestUserInput") &&
            message.id !== undefined
          ) {
            const questions = normalizeUserQuestions("codex", message.params);
            const response = hasInteractiveQuestions(request.options)
              ? await sink.requestPermission(createNormalizedEvent("permission.requested", {
                  provider: request.provider, runId: request.runId, raw,
                }, {
                  requestId: String(message.id), kind: "question", toolName: "request_user_input",
                  title: "Your input is needed", input: message.params, questions, canRemember: false,
                }) as PermissionRequestedEvent)
              : undefined;
            await client.respond(message.id, { answers: response?.decision === "allow"
              ? questionReply("codex", message.params, response.answers ?? []) : {} });
            continue;
          }

          const approvalKey = fileItemKey(message.params, message.params?.itemId);
          const permissionEvent = createCodexPermissionEvent(request, message,
            approvalKey ? pendingFileChanges.get(approvalKey) : undefined);
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
            if (approvalKey) pendingFileChanges.delete(approvalKey);
            continue;
          }

          const elicitation = createCodexElicitationPermissionEvent(request, message);
          if (elicitation && message.id !== undefined) {
            const response = interactiveApproval
              ? await sink.requestPermission(elicitation)
              : { requestId: elicitation.requestId, decision: "allow" as const };
            await client.respond(message.id, toCodexElicitationResult(message, response));
            continue;
          }

          // Codex blocks the turn until every server request is answered. A
          // request this SDK does not understand (a non-approval elicitation,
          // a newer approval kind, an auth refresh) must fail fast instead of
          // stalling the run forever.
          if (message.id !== undefined) {
            debugCodex("unsupported server request %s; declining", message.method);
            await (message.method === CODEX_ELICITATION_METHOD
              ? client.respond(message.id, { action: "cancel", content: null })
              : client.respondError(message.id, {
                  code: -32601,
                  message: `Unsupported request ${message.method}`,
                }));
            continue;
          }

          if (message.method === "item/completed") {
            const item = message.params?.item as { type?: string; text?: string } | undefined;
            if (item?.type === "plan" && typeof item.text === "string") {
              sink.emitEvent(createNormalizedEvent("plan.completed", { provider: request.provider, runId: request.runId }, { text: item.text }));
            }
          }
          if (rootThreadId && message.params && message.params.threadId === rootThreadId) {
            if (message.method === "thread/goal/updated") {
              const goal = message.params.goal as Record<string, unknown> | undefined;
              // A late update from an older turn must not end the current one.
              if (!message.params.turnId || message.params.turnId === turnId) {
                goalStatus = typeof goal?.status === "string" ? goal.status : undefined;
                // Goal updates normally precede turn/completed, but an idle
                // thread can also have its goal changed by another client.
                if (goalStatus !== "active" && pendingWait && !abortInvoked) {
                  settle();
                  return;
                }
              }
            } else if (message.method === "thread/goal/cleared") {
              goalStatus = undefined;
              if (pendingWait && !abortInvoked) {
                settle();
                return;
              }
            }
          }
          const turn = message.params?.turn as Record<string, unknown> | undefined;
          const rootTurnCompleted = message.method === "turn/completed" && isRootThread(message.params);
          // Trust turn completion regardless of live shell processes. Only an
          // active native goal may continue on its own after this turn.
          const waitAfterTurn = rootTurnCompleted && timeoutMs !== 0 && !abortInvoked &&
            turn?.status === "completed" && goalStatus === "active";
          for (const event of toNormalizedCodexEvents(request.runId, message)) {
            // Child turns cannot finish the root run. An active goal may
            // continue; interrupted root turns finish as run.cancelled below.
            if (event.type === "run.completed" && (!rootTurnCompleted || waitAfterTurn || turn?.status === "interrupted")) continue;
            sink.emitEvent(event);
            if (event.type === "text.delta") {
              streamedText += event.delta;
            } else if (event.type === "message.completed" && event.text) {
              turnMessageText = event.text;
            }
          }

          if (message.method === "thread/started" && !rootThreadId) {
            rootThreadId =
              ((message.params?.thread as Record<string, unknown> | undefined)
                ?.id as string | undefined) ?? rootThreadId;
          }

          if (message.method === "turn/started") {
            if (isRootThread(message.params)) {
              turnId = (turn?.id as string | undefined) ?? turnId;
              // A new turn's text supersedes the previous turn's.
              streamedText = "";
              turnMessageText = "";
              if (pendingWait) debugCodex("★ follow-up turn started; native goal wait over");
              endWait();
            }
          }

          if (rootTurnCompleted) {
            // An interrupted turn that produced nothing (the cancel marker
            // attachAbort starts) leaves the previous turn as the answer.
            const previousText = lastTurn?.text;
            lastTurn = { text: streamedText, messageText: turnMessageText };
            if (!waitAfterTurn) {
              resolve({
                text: streamedText || previousText,
                turnId,
                threadId: rootThreadId,
                interrupted: turn?.status === "interrupted",
              });
              return;
            }
            debugCodex("★ turn ended with an active goal; waiting for native continuation");
            endWait();
            pendingWait = finishWait.watch(new BackgroundWait(BACKGROUND_TASK_GRACE_MS, Math.max(0, timeoutMs - waitedMs)));
            pendingWait.setIdle(true);
            emitGoalWaiting(true);
          }

          if (message.method === "error" && !shouldIgnoreCodexError(message)) {
            // Normalized as run.error above: an app-server error fails the
            // run, waiting or not.
            reject(message);
            return;
          }
        }

        if (settleOnFailure(new Error("Codex transport closed."))) return;
        reject(new Error("Codex transport closed before run completed."));
      })().catch(reject);
    });

    try {
      if (!runtime.client) {
        await initializeCodexClient(client);
      }

      const cwd = request.options.cwd ?? process.cwd();
      type CodexThreadResponse = { thread: { id: string } };
      let threadResponse: CodexThreadResponse;
      let threadResultEventName: string;
      if (request.run.forkSessionId) {
        threadResponse = await client.request<CodexThreadResponse>(
          "thread/fork",
          buildForkParams(cwd, request.options, request),
        );
        threadResultEventName = "thread/fork:result";
      } else if (request.run.resumeSessionId) {
        threadResponse = await client.request<CodexThreadResponse>(
          "thread/resume",
          buildResumeParams(cwd, request.options, request),
        );
        threadResultEventName = "thread/resume:result";
      } else {
        threadResponse = await client.request<CodexThreadResponse>(
          "thread/start",
          buildThreadParams(cwd, request.options, request),
        );
        threadResultEventName = "thread/start:result";
      }
      rootThreadId = threadResponse.thread.id;
      if ("bindThread" in client && typeof client.bindThread === "function") {
        client.bindThread(threadResponse.thread.id);
      }
      sink.setSessionId(threadResponse.thread.id);
      rawPayloads.push(threadResponse);
      sink.emitRaw(
        toRawEvent(request.runId, threadResponse, threadResultEventName),
      );

      if (request.run.mode) {
        const modes = await client.request<{ data: Array<{ mode: string }> }>("collaborationMode/list", {});
        if (!modes.data.some((mode) => mode.mode === request.run.mode)) throw new Error("This Codex installation does not support the requested planning mode.");
      }
      // Skills are the only per-environment commands Codex exposes; the
      // inventory feeds the host's `/` menu and resolves skill invocations.
      // Requested alongside the turn so an app-server that never answers
      // (older builds, test fixtures) cannot hold the turn back; only a
      // skill invocation must wait for the names. The run waits for it once
      // more before it settles: a short turn (`/compact`, a one-liner) can
      // otherwise end first, and an emit into a closed sink reaches nobody,
      // leaving the host's palette on the built-ins forever.
      const emitHarnessCommands = (commands: HarnessCommandDescriptor[]) =>
        sink.emitEvent(
          createNormalizedEvent(
            "harness.commands",
            { provider: request.provider, runId: request.runId },
            { commands },
          ),
        );
      const inventory = listCodexHarnessCommands(client, cwd).then((commands) => {
        emitHarnessCommands(commands);
        return commands;
      });
      inventory.catch(() => undefined);
      if (request.run.goal) {
        await client.request("thread/goal/set", { threadId: threadResponse.thread.id, objective: request.run.goal, status: "active" });
      }
      const command = request.run.command;
      const skillNames = new Set(
        command && !CODEX_BUILTIN_COMMAND_NAMES.has(command.name)
          ? (await inventory).filter((entry) => entry.source !== "builtin").map((entry) => entry.name)
          : [],
      );
      const dispatch = resolveCodexCommandDispatch(command, runtime.inputItems, skillNames);
      // Compaction and review are app-server methods, not turns the model
      // reads; each still runs as a turn, so the completion path is shared.
      if (dispatch.kind === "compact") {
        await client.request("thread/compact/start", { threadId: threadResponse.thread.id });
      } else if (dispatch.kind === "review") {
        await client.request("review/start", { threadId: threadResponse.thread.id, target: dispatch.target, delivery: "inline" });
      } else {
        await client.request<{ turn?: { id?: string } }>(
          "turn/start",
          buildCodexTurnStartParams({
            threadId: threadResponse.thread.id,
            inputItems: dispatch.inputItems,
            request,
          }),
        );
      }

      let completionResult:
        | {
            text?: string;
            turnId?: string;
            threadId?: string;
            interrupted?: boolean;
          }
        | undefined;
      let completionError: unknown;
      try {
        completionResult = await completion;
      } catch (err) {
        completionError = err;
      }

      // The listing started before the turn did, so by now it has almost
      // always landed; this only covers the turn that ended sooner. It is a
      // grace, not the listing's own 5s budget: an app-server that never
      // answers `skills/list` must not hold every run open for it.
      await withTimeout(
        inventory.catch(() => undefined),
        HARNESS_COMMANDS_SETTLE_GRACE_MS,
      );

      // However the run ended, nothing is pending once it settles (a no-op
      // unless a native goal wait was reported).
      endWait();
      if (completionError !== undefined) {
        if (abortInvoked) {
          debugCodex(
            "★ run.cancelled (%dms since execute start)",
            Date.now() - executeStartedAt,
          );
          sink.cancel({
            text: streamedText || lastTurn?.text || undefined,
            costData: extractCodexCostData(rawPayloads),
          });
        } else {
          sink.fail(completionError);
        }
      } else {
        const { text, interrupted } = completionResult!;
        if (abortInvoked || interrupted) {
          debugCodex(
            "★ run.cancelled (%dms since execute start) interrupted=%s",
            Date.now() - executeStartedAt,
            interrupted,
          );
          sink.cancel({ text, costData: extractCodexCostData(rawPayloads) });
        } else {
          debugCodex(
            "★ run.completed (%dms since execute start) chars=%d",
            Date.now() - executeStartedAt,
            text?.length ?? 0,
          );
          sink.complete({ costData: extractCodexCostData(rawPayloads) });
        }
      }
    } finally {
      pendingWait?.clear();
      await runtime.cleanup().catch(() => undefined);
    }

    return async () => undefined;
  }

  /**
   * Stateless abort. Calls `turn/interrupt` against the in-sandbox
   * app-server using `(sessionId, turnId)` provided by the caller —
   * the SDK does not persist turn state itself; bookkeeping the
   * current turnId is the caller's responsibility (e.g. via Redis,
   * driven by the normalized `message.started` event whose
   * `messageId` IS the codex turnId).
   *
   * When that interrupt is rejected — the thread is between native goal
   * turns, or the turn id is stale or missing — a turn is started only to be
   * interrupted, so the originating run still observes an interrupted turn
   * and cancels; the model's leftover processes are then terminated.
   * Without `sessionId` the call is a no-op.
   */
  async attachAbort(request: AgentAttachRequest<"codex">): Promise<void> {
    const threadId = request.sessionId;
    if (!threadId) {
      debugCodex("attachAbort runId=%s skipped: no threadId", request.runId);
      return;
    }
    await withCodexAppServer(request, async (client) => {
      const bounded = <T>(what: string, promise: Promise<T>) =>
        Promise.race([
          promise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`codex ${what} timed out`)), 3_000),
          ),
        ]);
      const interrupt = (turnId: string) =>
        bounded("turn/interrupt", client.request("turn/interrupt", { threadId, turnId }));
      if (request.turnId) {
        try {
          await interrupt(request.turnId);
          return;
        } catch (error) {
          debugCodex("attachAbort runId=%s turn/interrupt failed: %o", request.runId, error);
        }
      }
      // A busy thread steers this input into its active turn and returns
      // that turn's id; an idle one starts a turn that the interrupt ends
      // before the model answers.
      try {
        const response = await bounded(
          "turn/start",
          client.request<{ turn?: { id?: string } }>("turn/start", {
            threadId,
            input: [{ type: "text", text: CODEX_CANCEL_TURN_TEXT, text_elements: [] }],
            approvalPolicy: "never",
            model: null,
            effort: null,
            outputSchema: null,
          }),
        );
        if (typeof response?.turn?.id === "string") await interrupt(response.turn.id);
      } catch (error) {
        debugCodex("attachAbort runId=%s cancel turn failed: %o", request.runId, error);
      }
      // Otherwise the model's leftover processes outlive the cancel until
      // the thread unloads.
      await terminateBackgroundTerminals(client, threadId);
    });
  }

  /**
   * Stateless message injection. Uses `request.sessionId` as the codex
   * threadId and starts a fresh turn against it via `turn/start`.
   */
  async attachSendMessage(
    request: AgentAttachRequest<"codex">,
    content: UserContent,
  ): Promise<void> {
    const threadId = request.sessionId;
    if (!threadId) {
      throw new Error(
        `Cannot attachSendMessage to codex run ${request.runId}: sessionId (threadId) is required.`,
      );
    }
    const parts = normalizeUserInput(content);
    const text = joinTextParts(
      parts.filter(
        (part): part is Extract<typeof part, { type: "text" }> =>
          part.type === "text",
      ),
    );
    const inputItems: Array<Record<string, unknown>> = [];
    if (text.trim().length > 0) {
      inputItems.push({ type: "text", text, text_elements: [] });
    }

    await withCodexAppServer(request, async (client) => {
      await client.request("turn/start", {
        threadId,
        input: inputItems,
        approvalPolicy: "never",
        model: null,
        effort: null,
        outputSchema: null,
      });
    });
  }
}
