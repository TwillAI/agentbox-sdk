import path from "node:path";

import {
  createNormalizedEvent,
  type NormalizedAgentEvent,
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
import { agentboxRoot, createSetupTarget } from "../config/setup";
import { applyDifferentialSetup } from "../config/setup-manifest";
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
    agentboxRoot(AgentProvider.Codex, Boolean(options.sandbox)),
    ".codex",
  );
}

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
  // The system prompt is per-RUN (in `AgentRunConfig`), so it can vary
  // between runs even on a shared app-server. Pushing it through a
  // per-turn collaboration override avoids re-spawning the app-server
  // and keeps `execute()` independent of any setup-time config files.
  const systemPrompt = request.run.systemPrompt;
  if (!systemPrompt) {
    return undefined;
  }

  return {
    mode: "custom",
    settings: {
      developer_instructions: systemPrompt,
    },
  };
}

export function buildCodexTurnStartParams(params: {
  threadId: string;
  inputItems: Array<Record<string, unknown>>;
  request: AgentExecutionRequest<"codex">;
  turnStartOverrides?: Record<string, unknown>;
}): Record<string, unknown> {
  const { threadId, inputItems, request, turnStartOverrides } = params;
  const sandboxPolicy = buildTurnSandboxPolicy(request.options);
  return {
    threadId,
    input: inputItems,
    approvalPolicy: isInteractiveApproval(request.options)
      ? "untrusted"
      : "never",
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
    ...(turnStartOverrides ?? {}),
    model: request.run.model ?? null,
    effort: request.run.reasoning ?? null,
    outputSchema: null,
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
  return ["-u", "XDG_CONFIG_HOME", binary, ...overrideArgs, ...args];
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
      // Codex streams agentMessage text via `item/agentMessage/delta`
      // which we already turn into `text.delta` events above. Re-emitting
      // the full text here as another `text.delta` would double the
      // accumulated stream (the host sums every `text.delta` into the
      // final `result.text`) — so the completion only carries
      // `message.completed`, mirroring the claude-code adapter's
      // post-streaming behavior.
      return [
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

  // Per-turn image attachments live alongside the codex layout root,
  // not inside `<codexDir>` itself, so codex doesn't try to load them
  // as discoverable config artifacts.
  const root = agentboxRoot(AgentProvider.Codex, Boolean(options.sandbox));
  const imagePath = path.join(
    root,
    "inputs",
    `codex-image-${index}${codexImageExtension(part.mediaType)}`,
  );

  if (options.sandbox) {
    const encodedPath = `${imagePath}.b64`;
    await options.sandbox.uploadAndRun(
      [{ path: encodedPath, content: part.source.data }],
      [
        `mkdir -p ${shellQuote(path.posix.dirname(imagePath))}`,
        `(base64 --decode < ${shellQuote(encodedPath)} > ${shellQuote(imagePath)} || base64 -D < ${shellQuote(encodedPath)} > ${shellQuote(imagePath)})`,
        `rm -f ${shellQuote(encodedPath)}`,
      ].join(" && "),
      { cwd: options.cwd, env: options.env },
    );
    return imagePath;
  }

  const fs = await import("node:fs/promises");
  await fs.mkdir(path.dirname(imagePath), { recursive: true });
  await fs.writeFile(imagePath, Buffer.from(part.source.data, "base64"));
  return imagePath;
}

function resolveCodexOpenAiBaseUrlFromOptions(
  options: AgentOptions<"codex">,
): string | undefined {
  return options.env?.OPENAI_BASE_URL ?? options.provider?.env?.OPENAI_BASE_URL;
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
      "printenv OPENAI_API_KEY | env -u XDG_CONFIG_HOME codex login --with-api-key",
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
  const transport = await connectJsonRpcWebSocket(
    toRemoteCodexWebSocketUrl(previewUrl),
    { headers: sandbox.previewHeaders },
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
 * (`AgentRunConfig`) and threaded through the per-turn collaboration
 * mode override in `execute()` instead.
 */
async function setupCodex(request: AgentSetupRequest<"codex">): Promise<void> {
  const options = request.options;
  const provider = request.provider;
  const hooks = assertHooksSupported(provider, options);
  assertCommandsSupported(provider, options.commands);

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
    const { artifacts: subAgentArtifacts, agentSections } =
      buildCodexSubagentArtifacts(options.subAgents, layoutTarget.layout);
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

    await time(debugCodex, "ensureCodexLogin", () =>
      ensureCodexLoginViaConfig(request, sharedTarget),
    );

    const { artifacts: serverArtifacts } = buildArtifactsFor(sharedTarget);
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
      "launch app-server (probe + spawn-if-cold)",
      () =>
        sandbox.run(
          [
            `mkdir -p ${shellQuote(sharedTarget.layout.rootDir)}`,
            `if curl -fsS http://127.0.0.1:${REMOTE_CODEX_APP_SERVER_PORT}/readyz >/dev/null 2>&1; then exit 0; fi`,
            `if [ -f ${shellQuote(pidFilePath)} ]; then kill "$(cat ${shellQuote(pidFilePath)})" >/dev/null 2>&1 || true; rm -f ${shellQuote(pidFilePath)}; fi`,
            `(${[
              `nohup ${[
                "env",
                ...buildCodexCommandArgs(
                  binary,
                  [
                    "app-server",
                    "--listen",
                    `ws://0.0.0.0:${REMOTE_CODEX_APP_SERVER_PORT}`,
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
      const { artifacts: skillArtifacts, installCommands } =
        await prepareSkillArtifacts(provider, options.skills, target.layout);
      await applyDifferentialSetup(target, skillArtifacts, installCommands);
    } catch (error) {
      await target.cleanup().catch(() => undefined);
      throw error;
    }

    return;
  }

  // Local mode: everything goes on the same target.
  const target = await createSetupTarget(provider, "shared-setup", options);
  try {
    await ensureCodexLoginViaConfig(request, target);
  } catch (error) {
    await target.cleanup().catch(() => undefined);
    throw error;
  }

  const { artifacts: skillArtifacts, installCommands } =
    await prepareSkillArtifacts(provider, options.skills, target.layout);
  const { artifacts: configArtifacts } = buildArtifactsFor(target);

  await applyDifferentialSetup(
    target,
    [...skillArtifacts, ...configArtifacts],
    installCommands,
  );
}

async function createRuntime(
  request: AgentExecutionRequest<"codex">,
  inputParts: Awaited<ReturnType<typeof validateProviderUserInput>>,
): Promise<CodexRuntime> {
  const options = request.options;
  // Spawn context — constants only. `setup()` already wrote
  // config.toml, hooks.json, agents/, skills/ under `codexDir`; the
  // codex CLI auto-discovers them via `CODEX_HOME`.
  const codexDir = codexConfigDir(options);
  const env = compactEnv({
    ...(options.env ?? {}),
    CODEX_HOME: codexDir,
    ...(options.provider?.env ?? {}),
  });
  // The codex daemon launches with cwd=<root>. The thread it runs
  // operates on whatever cwd the per-thread `thread/start` params
  // specify, which is `options.cwd` set by the caller.
  const runtimeCwd = path.dirname(codexDir);
  const inputItems = await buildCodexInputItems(options, inputParts);

  const usesRemoteWebSocket =
    options.sandbox && options.sandbox.provider !== SandboxProvider.LocalDocker;

  if (usesRemoteWebSocket && options.sandbox) {
    const sandbox = options.sandbox;
    const previewUrl = await time(debugCodex, "getPreviewLink app-server", () =>
      sandbox.getPreviewLink(REMOTE_CODEX_APP_SERVER_PORT),
    );

    const transport = await connectRemoteCodexAppServer(
      toRemoteCodexWebSocketUrl(previewUrl),
      sandbox.previewHeaders,
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
      turnStartOverrides: buildTurnCollaborationMode(request),
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
      turnStartOverrides: buildTurnCollaborationMode(request),
    };
  }

  const processHandle = spawnCommand({
    command: "env",
    args: codexArgs,
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
    },
    raw: { processHandle, codexDir },
    inputItems,
    turnStartOverrides: buildTurnCollaborationMode(request),
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
  const textPrompt = joinTextParts(
    inputParts.filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text",
    ),
  );
  const inputItems: Array<Record<string, unknown>> = [];

  if (textPrompt.trim().length > 0) {
    inputItems.push({
      type: "text",
      text: textPrompt,
      text_elements: [],
    });
  }

  inputItems.push(
    ...(await mapToCodexPromptParts(inputParts, async (part, index) =>
      materializeCodexImage(options, part, index),
    )),
  );

  return inputItems;
}

export class CodexAgentAdapter implements AgentProviderAdapter<"codex"> {
  async setup(request: AgentSetupRequest<"codex">): Promise<void> {
    await setupCodex(request);
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
    // The system prompt is per-RUN and is delivered via the per-turn
    // `buildTurnCollaborationMode` override; agent-config is on disk
    // and discovered via `CODEX_HOME`. `createRuntime` does the wire
    // dial / binary spawn from `request.options` directly.
    const runtime = await time(debugCodex, "createRuntime", () =>
      createRuntime(request, inputParts),
    );
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
      // pair for the queued message. So we must NOT bump
      // `pendingTurns` here: the run resolves on the next (single)
      // `turn/completed`, which carries the merged response.
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
    const completion = new Promise<{
      text?: string;
      turnId?: string;
      threadId?: string;
    }>((resolve, reject) => {
      let finalText = "";

      void (async () => {
        let firstClientMessageLogged = false;
        for await (const message of client.messages()) {
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
      rawPayloads.push(threadResponse);
      sink.emitRaw(
        toRawEvent(
          request.runId,
          threadResponse,
          request.run.resumeSessionId
            ? "thread/resume:result"
            : "thread/start:result",
        ),
      );

      await client.request<{ turn?: { id?: string } }>(
        "turn/start",
        buildCodexTurnStartParams({
          threadId: threadResponse.thread.id,
          inputItems: runtime.inputItems,
          request,
          turnStartOverrides: runtime.turnStartOverrides,
        }),
      );

      const { text } = await completion;
      debugCodex(
        "★ run.completed (%dms since execute start) chars=%d",
        Date.now() - executeStartedAt,
        text?.length ?? 0,
      );
      sink.complete({ text, costData: extractCodexCostData(rawPayloads) });
    } finally {
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
   * If `sessionId` or `turnId` is missing the call is a no-op.
   */
  async attachAbort(request: AgentAttachRequest<"codex">): Promise<void> {
    const threadId = request.sessionId;
    const turnId = request.turnId;
    if (!threadId || !turnId) {
      debugCodex(
        "attachAbort runId=%s skipped: threadId=%s turnId=%s",
        request.runId,
        threadId,
        turnId,
      );
      return;
    }
    await withCodexAppServer(request, async (client) => {
      await Promise.race([
        client.request("turn/interrupt", { threadId, turnId }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("codex turn/interrupt timed out")),
            3_000,
          ),
        ),
      ]).catch((error) => {
        debugCodex(
          "attachAbort runId=%s turn/interrupt failed: %o",
          request.runId,
          error,
        );
      });
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
