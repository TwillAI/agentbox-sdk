import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  Options as SdkQueryOptions,
  PermissionMode,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { createNormalizedEvent, type RawAgentEvent } from "../../events";
import { sleep } from "../../shared/network";
import { shellQuote } from "../../shared/shell";
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
import { shouldAutoApproveClaudeTools } from "../approval";
import { mapToClaudeUserContent, validateProviderUserInput } from "../input";
import {
  assertCommandsSupported,
  buildClaudeCommandArtifacts,
} from "../config/commands";
import { buildClaudeHookSettings, assertHooksSupported } from "../config/hooks";
import { buildClaudeMcpConfig } from "../config/mcp";
import { agentboxRoot, createSetupTarget } from "../config/setup";
import { applyDifferentialSetup } from "../config/setup-manifest";
import { prepareSkillArtifacts } from "../config/skills";
import { buildClaudeSubagentArtifacts } from "../config/subagents";
import { extractClaudeCostData } from "../cost";
import { debugClaude, debugRelay, time } from "../../shared/debug";
import type { Sandbox } from "../../sandboxes";

/**
 * Daemon protocol version. Bumped whenever the daemon script's HTTP
 * surface changes; the host probes `GET /__version` and respawns the
 * daemon on mismatch so warm sandboxes pick up the new code.
 */
const DAEMON_PROTOCOL_VERSION = "1";
const DAEMON_PORT = 43180;
const DAEMON_PATH = "/tmp/agentbox/claude-code/daemon.mjs";
const DAEMON_LOG_PATH = "/tmp/agentbox/claude-code/daemon.log";
const DAEMON_PID_PATH = "/tmp/agentbox/claude-code/daemon.pid";

/**
 * Path to the on-disk `.claude` config directory agentbox uses for a
 * given run. Resolves to `/tmp/agentbox/claude-code/.claude` in a
 * sandbox, or `<os.tmpdir()>/agentbox-claude-code/.claude` on the host.
 */
function claudeConfigDir(options: AgentOptions<"claude-code">): string {
  return path.join(
    agentboxRoot(AgentProvider.ClaudeCode, Boolean(options.sandbox)),
    ".claude",
  );
}

/**
 * Build the SDK `query()` options that the daemon receives over HTTP.
 *
 * Function-typed options (`canUseTool`, `abortController`,
 * `spawnClaudeCodeProcess`) are NOT included — the daemon synthesizes
 * those locally based on the `autoApproveTools` flag plus its own
 * AbortController. Everything else is JSON-serializable so we just
 * stringify it into the `POST /runs/<id>/start` body.
 */
export function buildClaudeQueryOptions(params: {
  request: AgentExecutionRequest<"claude-code">;
  settingsPath: string;
  mcpConfigPath: string;
  cwd?: string;
  env: Record<string, string>;
}): SdkQueryOptions & { autoApproveTools?: boolean } {
  const provider = params.request.options.provider;
  const run = params.request.run;

  const extraArgs: Record<string, string | null> = {
    "mcp-config": params.mcpConfigPath,
  };
  for (const arg of provider?.args ?? []) {
    if (typeof arg !== "string") continue;
    if (arg.startsWith("--")) {
      extraArgs[arg.slice(2)] = null;
    }
  }
  if (run.systemPrompt) {
    extraArgs["append-system-prompt"] = run.systemPrompt;
  }

  return {
    cwd: params.cwd ?? params.request.options.cwd,
    env: params.env,
    pathToClaudeCodeExecutable: provider?.binary ?? "claude",
    settings: params.settingsPath,
    extraArgs,
    includePartialMessages: true,
    thinking: { type: "adaptive", display: "summarized" },
    ...(run.model ? { model: run.model } : {}),
    ...(run.reasoning ? { effort: run.reasoning } : {}),
    ...(provider?.permissionMode
      ? { permissionMode: provider.permissionMode as PermissionMode }
      : {}),
    ...(provider?.permissionMode === "bypassPermissions"
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(provider?.allowedTools?.length
      ? { allowedTools: provider.allowedTools }
      : {}),
    ...(run.resumeSessionId ? { resume: run.resumeSessionId } : {}),
    // Fork-at-message: claude-agent-sdk natively supports slicing a
    // resumed transcript at a message UUID and writing the continuation
    // under a new session id when `forkSession: true` is set. The
    // captured message UUID comes from `SDKAssistantMessage.uuid`,
    // surfaced on normalized `message.started` events.
    ...(run.forkSessionId
      ? {
          resume: run.forkSessionId,
          resumeSessionAt: run.forkAtMessageId,
          forkSession: true,
        }
      : {}),
  };
}

function toRawEvent(
  runId: string,
  payload: unknown,
  type: string,
): RawAgentEvent {
  return {
    provider: AgentProvider.ClaudeCode,
    runId,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function extractAssistantText(message: SDKAssistantMessage): string {
  const content = message.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text")
    .map((block) => String((block as { text?: string }).text ?? ""))
    .join("");
}

function extractAssistantThinking(message: SDKAssistantMessage): string {
  const content = message.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block) => block.type === "thinking" || block.type === "redacted_thinking",
    )
    .map((block) => String((block as { thinking?: string }).thinking ?? ""))
    .filter(Boolean)
    .join("");
}

type StreamDeltas = { text: string; thinking: string };

function extractStreamDeltas(
  message: SDKPartialAssistantMessage,
): StreamDeltas {
  const event = message.event as unknown as Record<string, unknown> | undefined;
  if (!event || event.type !== "content_block_delta") {
    return { text: "", thinking: "" };
  }
  const delta = event.delta as Record<string, unknown> | undefined;
  if (!delta) return { text: "", thinking: "" };
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    return { text: delta.text, thinking: "" };
  }
  if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
    return { text: "", thinking: delta.thinking };
  }
  return { text: "", thinking: "" };
}

/**
 * Daemon script shipped to the sandbox. Runs as `node daemon.mjs <port>`
 * and exposes an HTTP API for orchestrating concurrent SDK queries:
 *
 *   GET  /__version
 *   POST /runs/<id>/start         body: { prompt, options } → NDJSON of SDKMessage
 *   POST /runs/<id>/sendMessage   body: { content }         → 204
 *   POST /runs/<id>/abort                                   → 204
 *   DELETE /runs/<id>                                       → 204
 *
 * The daemon imports `@anthropic-ai/claude-agent-sdk` from the image's
 * global `npm install -g`, holds a Map<runId, {query, prompt}>, and
 * forwards each SDKMessage to the open `start` response as one JSON
 * line. Multiple concurrent runs are isolated by runId — each spawns
 * its own `claude` subprocess via the SDK's default spawn.
 */
function createClaudeCodeDaemonScript(): string {
  const version = JSON.stringify(DAEMON_PROTOCOL_VERSION);
  return `import http from "node:http";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";

const VERSION = ${version};
const port = Number(process.argv[2] ?? "${DAEMON_PORT}");
const liveRuns = new Map();

// The SDK's default spawn does \`existsSync(pathToClaudeCodeExecutable)\`
// before invoking child_process.spawn — that check fails on bare names
// like "claude" because existsSync doesn't do PATH lookup. Resolve to an
// absolute path once at daemon startup so the SDK is happy regardless of
// what the host passes.
function resolveClaudeBinary(hint) {
  if (hint && (hint.includes("/") || hint.includes(String.fromCharCode(92)))) {
    return hint;
  }
  const name = hint || "claude";
  try {
    const out = execSync("command -v " + name + " || which " + name, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out && existsSync(out)) return out;
  } catch {}
  return name;
}

function createPromptStream() {
  const queue = [];
  let resolver = null;
  let ended = false;
  return {
    [Symbol.asyncIterator]: async function* () {
      while (true) {
        if (queue.length > 0) { yield queue.shift(); continue; }
        if (ended) return;
        await new Promise((r) => { resolver = r; });
      }
    },
    push(message) {
      queue.push(message);
      const r = resolver; resolver = null; r?.();
    },
    end() {
      ended = true;
      const r = resolver; resolver = null; r?.();
    },
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > 8 * 1024 * 1024) {
        req.destroy(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function autoApproveCanUseTool(_toolName, input) {
  return { behavior: "allow", updatedInput: input };
}

async function handleStart(req, res, runId) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    return;
  }
  const { prompt, options } = body || {};
  if (!prompt) {
    res.writeHead(400);
    res.end("missing prompt");
    return;
  }

  const promptStream = createPromptStream();
  promptStream.push(prompt);

  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "transfer-encoding": "chunked",
    "x-daemon-version": VERSION,
  });

  const opts = { ...(options || {}) };
  const autoApprove = !!opts.autoApproveTools;
  delete opts.autoApproveTools;
  opts.pathToClaudeCodeExecutable = resolveClaudeBinary(
    opts.pathToClaudeCodeExecutable,
  );

  let queryHandle;
  try {
    queryHandle = query({
      prompt: promptStream,
      options: {
        ...opts,
        ...(autoApprove ? { canUseTool: autoApproveCanUseTool } : {}),
      },
    });
  } catch (e) {
    res.write(JSON.stringify({ _error: String(e?.message ?? e) }) + "\\n");
    res.end();
    return;
  }

  liveRuns.set(runId, { query: queryHandle, prompt: promptStream });

  // Client disconnected (e.g. host process killed) → tear down.
  req.on("close", () => {
    if (!liveRuns.has(runId)) return;
    liveRuns.delete(runId);
    promptStream.end();
    queryHandle.interrupt().catch(() => {});
  });

  try {
    for await (const message of queryHandle) {
      res.write(JSON.stringify(message) + "\\n");
      if (message.type === "result") break;
    }
  } catch (e) {
    res.write(JSON.stringify({ _error: String(e?.message ?? e) }) + "\\n");
  } finally {
    liveRuns.delete(runId);
    promptStream.end();
    res.end();
  }
}

async function handleSendMessage(req, res, runId) {
  const run = liveRuns.get(runId);
  if (!run) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such run" }));
    return;
  }
  let body;
  try { body = await readJsonBody(req); }
  catch (e) {
    res.writeHead(400);
    res.end(String(e?.message ?? e));
    return;
  }
  run.prompt.push({
    type: "user",
    message: { role: "user", content: body.content },
    parent_tool_use_id: null,
  });
  res.writeHead(204);
  res.end();
}

async function handleAbort(_req, res, runId) {
  const run = liveRuns.get(runId);
  if (!run) {
    res.writeHead(404);
    res.end();
    return;
  }
  await run.query.interrupt().catch(() => {});
  res.writeHead(204);
  res.end();
}

async function handleDelete(_req, res, runId) {
  const run = liveRuns.get(runId);
  if (run) {
    liveRuns.delete(runId);
    run.prompt.end();
    await run.query.interrupt().catch(() => {});
  }
  res.writeHead(204);
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/__version") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(VERSION);
    return;
  }
  const url = req.url ?? "";
  let m;
  if (req.method === "POST" && (m = url.match(/^\\/runs\\/([^/]+)\\/start$/))) {
    handleStart(req, res, decodeURIComponent(m[1]));
    return;
  }
  if (req.method === "POST" && (m = url.match(/^\\/runs\\/([^/]+)\\/sendMessage$/))) {
    handleSendMessage(req, res, decodeURIComponent(m[1]));
    return;
  }
  if (req.method === "POST" && (m = url.match(/^\\/runs\\/([^/]+)\\/abort$/))) {
    handleAbort(req, res, decodeURIComponent(m[1]));
    return;
  }
  if (req.method === "DELETE" && (m = url.match(/^\\/runs\\/([^/]+)$/))) {
    handleDelete(req, res, decodeURIComponent(m[1]));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(port, "0.0.0.0", () => {
  console.error("[claude-code-daemon] listening on :" + port + " v" + VERSION);
});

const shutdown = () => {
  for (const r of liveRuns.values()) {
    r.prompt.end();
    r.query.interrupt().catch(() => {});
  }
  server.close();
  setTimeout(() => process.exit(0), 100).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`;
}

/**
 * Idempotently boot the daemon inside the sandbox. Probes
 * `/__version`; if the running daemon's version doesn't match,
 * `fuser -k` the port and respawn from a fresh upload. Concurrent
 * `setup()` calls dedupe on the same in-flight promise so they don't
 * race the kill+respawn.
 */
const daemonInflight = new WeakMap<object, Promise<void>>();

async function ensureClaudeCodeDaemon(
  options: AgentOptions<"claude-code">,
  env: Record<string, string>,
): Promise<void> {
  const sandbox = options.sandbox;
  if (!sandbox) return;
  const key = sandbox as unknown as object;
  const existing = daemonInflight.get(key);
  if (existing) return existing;
  const promise = ensureClaudeCodeDaemonUncached(options, env);
  daemonInflight.set(key, promise);
  promise.finally(() => {
    if (daemonInflight.get(key) === promise) daemonInflight.delete(key);
  });
  return promise;
}

async function ensureClaudeCodeDaemonUncached(
  options: AgentOptions<"claude-code">,
  env: Record<string, string>,
): Promise<void> {
  return time(debugRelay, "ensureClaudeCodeDaemon", async () => {
    const sandbox = options.sandbox!;

    const probe = await time(debugRelay, "probe daemon version", () =>
      sandbox.run(
        `curl -fsS --max-time 1 http://127.0.0.1:${DAEMON_PORT}/__version 2>/dev/null`,
        { cwd: options.cwd, timeoutMs: 10_000 },
      ),
    );
    if (
      probe.exitCode === 0 &&
      probe.combinedOutput.trim() === DAEMON_PROTOCOL_VERSION
    ) {
      debugRelay(
        "daemon v%s already running — reusing",
        DAEMON_PROTOCOL_VERSION,
      );
      return;
    }

    // The daemon is spawned from /tmp/... but imports
    // `@anthropic-ai/claude-agent-sdk` which lives in the image's global
    // npm prefix. Node's ESM resolver does NOT honor `NODE_PATH`, so we
    // create a sibling `node_modules` that symlinks the SDK package out
    // of the resolved global path. The daemon then resolves bare
    // specifiers via standard node_modules walk-up.
    //
    // We resolve `npm root -g` and validate inline in the launch shell
    // (rather than via a separate `sandbox.run`) to save a round-trip
    // on remote sandboxes. If the SDK isn't installed, the launch
    // fails with a clear error which `uploadAndRun` surfaces.
    const daemonDir = path.posix.dirname(DAEMON_PATH);
    const daemonNodeModules = `${daemonDir}/node_modules/@anthropic-ai`;
    const launchCommand = [
      `NPM_ROOT="$(npm root -g 2>/dev/null)"`,
      `if [ -z "$NPM_ROOT" ] || [ ! -d "$NPM_ROOT/@anthropic-ai/claude-agent-sdk" ]; then echo "claude-code daemon launch: @anthropic-ai/claude-agent-sdk not found under $NPM_ROOT" >&2; exit 1; fi`,
      `mkdir -p ${shellQuote(daemonNodeModules)}`,
      `ln -sfn "$NPM_ROOT/@anthropic-ai/claude-agent-sdk" ${shellQuote(daemonNodeModules + "/claude-agent-sdk")}`,
      `if [ -f ${shellQuote(DAEMON_PID_PATH)} ]; then kill -TERM "$(cat ${shellQuote(DAEMON_PID_PATH)})" 2>/dev/null || true; fi`,
      `(fuser -k -n tcp ${DAEMON_PORT} 2>/dev/null || true)`,
      // Brief grace so the kernel releases the port before the new
      // daemon's listen() — only matters on warm-sandbox respawns;
      // adds 200ms otherwise.
      `sleep 0.2`,
      `(nohup node ${shellQuote(DAEMON_PATH)} ${DAEMON_PORT} > ${shellQuote(DAEMON_LOG_PATH)} 2>&1 & echo $! > ${shellQuote(DAEMON_PID_PATH)})`,
    ].join(" && ");

    const launch = await time(
      debugRelay,
      "uploadAndRun daemon (write + spawn)",
      () =>
        sandbox.uploadAndRun(
          [
            {
              path: DAEMON_PATH,
              content: createClaudeCodeDaemonScript(),
              mode: 0o644,
            },
          ],
          launchCommand,
          { cwd: options.cwd, env: { ...env, IS_SANDBOX: "1" } },
        ),
    );
    if (launch.exitCode !== 0) {
      throw new Error(
        `Could not start claude-code daemon: ${
          launch.stderr || launch.combinedOutput || "(no output)"
        }`,
      );
    }
    // No readiness polling here. uploadAndRun returns after the
    // launch shell exits, but the detached `node daemon.mjs` may still
    // be a few hundred ms away from `listen()`. We rely on the host
    // retrying the first HTTP request on ECONNREFUSED instead, which
    // costs nothing on the warm path and absorbs the cold-start race
    // without burning a sandbox round-trip per check.
  });
}

const DAEMON_FIRST_REQUEST_RETRY_BUDGET_MS = 30_000;
const DAEMON_FIRST_REQUEST_RETRY_INTERVAL_MS = 250;

/**
 * Retry helper for the first HTTP request hitting a freshly-spawned
 * daemon. Re-issues the request if `fetch` throws (most often
 * ECONNREFUSED while node is still booting). Treats anything else —
 * including 4xx/5xx — as a real response and returns immediately.
 */
async function fetchWithDaemonRetry(
  input: string,
  init: RequestInit,
): Promise<Response> {
  const deadline = Date.now() + DAEMON_FIRST_REQUEST_RETRY_BUDGET_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;
      // Abort signals must NOT be retried.
      const aborted =
        (error as { name?: string } | undefined)?.name === "AbortError";
      if (aborted) {
        throw error;
      }
      await sleep(DAEMON_FIRST_REQUEST_RETRY_INTERVAL_MS);
    }
  }
  throw lastError ?? new Error("claude-code daemon request timed out");
}

async function* parseNdjsonStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        try {
          yield JSON.parse(line);
        } catch {
          // Skip malformed lines; daemon should only emit clean JSON.
        }
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer);
    } catch {
      // ignore tail garbage
    }
  }
}

async function daemonBaseUrl(sandbox: Sandbox): Promise<string> {
  const url = await sandbox.getPreviewLink(DAEMON_PORT);
  return url.replace(/\/$/, "");
}

export class ClaudeCodeAgentAdapter
  implements AgentProviderAdapter<"claude-code">
{
  /**
   * Sandbox-side preparation. Uploads `.claude/` artifacts and ensures
   * the daemon is running. `execute()` then dials the daemon directly.
   */
  async setup(request: AgentSetupRequest<"claude-code">): Promise<void> {
    await time(debugClaude, "claude-code setup()", async () => {
      const options = request.options;
      const provider = request.provider;
      const sandbox = options.sandbox;
      if (!sandbox) {
        throw new Error(
          "claude-code requires a sandbox (the SDK transport runs as a daemon inside the sandbox).",
        );
      }

      const target = await createSetupTarget(provider, "shared-setup", options);
      const settingsPath = path.join(target.layout.claudeDir, "settings.json");
      const mcpConfigPath = path.join(
        target.layout.claudeDir,
        "agentbox-mcp.json",
      );

      const hooks = assertHooksSupported(provider, options);
      assertCommandsSupported(provider, options.commands);

      const { artifacts: skillArtifacts, installCommands } = await time(
        debugClaude,
        "prepareSkillArtifacts",
        () => prepareSkillArtifacts(provider, options.skills, target.layout),
      );

      const hookSettings = buildClaudeHookSettings(hooks) ?? {};
      const mcpConfigJson =
        buildClaudeMcpConfig(options.mcps) ??
        JSON.stringify({ mcpServers: {} }, null, 2);

      const artifacts = [
        ...skillArtifacts,
        ...buildClaudeCommandArtifacts(options.commands, target.layout),
        ...buildClaudeSubagentArtifacts(options.subAgents, target.layout),
        { path: settingsPath, content: JSON.stringify(hookSettings, null, 2) },
        { path: mcpConfigPath, content: mcpConfigJson },
      ];

      const env = { ...(options.env ?? {}), ...target.env };
      await Promise.all([
        time(debugClaude, "applyDifferentialSetup", () =>
          applyDifferentialSetup(target, artifacts, installCommands),
        ),
        ensureClaudeCodeDaemon(options, env),
      ]);
    });
  }

  async execute(
    request: AgentExecutionRequest<"claude-code">,
    sink: AgentRunSink,
  ): Promise<() => Promise<void>> {
    const executeStartedAt = Date.now();
    debugClaude("execute() start runId=%s", request.runId);

    const sandbox = request.options.sandbox;
    if (!sandbox) {
      throw new Error(
        "claude-code requires a sandbox (the SDK transport runs as a daemon inside the sandbox).",
      );
    }

    const claudeDir = claudeConfigDir(request.options);
    const settingsPath = path.join(claudeDir, "settings.json");
    const mcpConfigPath = path.join(claudeDir, "agentbox-mcp.json");
    const env: Record<string, string> = {
      ...(request.options.env ?? {}),
      CLAUDE_CONFIG_DIR: claudeDir,
      // `IS_SANDBOX=1` lets the in-sandbox claude binary accept
      // `--dangerously-skip-permissions` (i.e. permissionMode
      // bypassPermissions) when running as root, which is the default
      // user inside our images.
      IS_SANDBOX: "1",
    };

    const inputParts = await time(
      debugClaude,
      "validateProviderUserInput",
      () => validateProviderUserInput(request.provider, request.run.input),
    );
    const userContent = mapToClaudeUserContent(inputParts);
    const initialUuid = randomUUID();

    // Pre-mint the session id so callers waiting on `sessionIdReady`
    // unblock immediately and so the value we surface IS the session id
    // claude actually uses (we pass it in via the SDK's `sessionId`
    // option). When resuming, honor the existing id instead.
    const presetSessionId = request.run.resumeSessionId ?? randomUUID();
    sink.setSessionId(presetSessionId);

    const baseUrl = await time(debugClaude, "getPreviewLink daemon", () =>
      daemonBaseUrl(sandbox),
    );
    const startUrl = `${baseUrl}/runs/${encodeURIComponent(request.runId)}/start`;

    const sdkOptions = buildClaudeQueryOptions({
      request,
      settingsPath,
      mcpConfigPath,
      env,
    });
    const autoApproveTools = shouldAutoApproveClaudeTools(request.options);

    const requestBody = {
      prompt: {
        type: "user" as const,
        message: {
          role: "user" as const,
          content: userContent as SDKUserMessage["message"]["content"],
        },
        parent_tool_use_id: null,
      } satisfies SDKUserMessage,
      options: {
        ...sdkOptions,
        // `sessionId` and `resume` are mutually exclusive — buildClaudeQueryOptions
        // already set `resume` for the resume path, so only stamp `sessionId` for
        // fresh runs.
        ...(request.run.resumeSessionId
          ? {}
          : { sessionId: presetSessionId }),
        autoApproveTools,
      },
    };

    const fetchAbort = new AbortController();
    const cleanup = async () => {
      // Tell the daemon to interrupt FIRST; the closing request will
      // also trigger its `req.on('close')` handler as a backstop.
      try {
        await fetch(
          `${baseUrl}/runs/${encodeURIComponent(request.runId)}/abort`,
          { method: "POST", headers: sandbox.previewHeaders },
        );
      } catch {
        // ignore — abort is best-effort
      }
      fetchAbort.abort();
    };
    sink.setAbort(cleanup);

    sink.onMessage(async (content: UserContent) => {
      const parts = await validateProviderUserInput(request.provider, content);
      const mapped = mapToClaudeUserContent(parts);
      const messageUuid = randomUUID();
      await fetch(
        `${baseUrl}/runs/${encodeURIComponent(request.runId)}/sendMessage`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...sandbox.previewHeaders,
          },
          body: JSON.stringify({ content: mapped }),
        },
      );
      return { messageId: messageUuid };
    });

    const response = await time(debugClaude, "POST /runs/<id>/start", () =>
      fetchWithDaemonRetry(startUrl, {
        method: "POST",
        signal: fetchAbort.signal,
        headers: {
          "content-type": "application/json",
          ...sandbox.previewHeaders,
        },
        body: JSON.stringify(requestBody),
      }),
    );

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `claude-code daemon /start failed: ${response.status} ${text}`,
      );
    }

    sink.setRaw({ baseUrl, runId: request.runId, claudeDir });

    sink.emitEvent(
      createNormalizedEvent("run.started", {
        provider: request.provider,
        runId: request.runId,
      }),
    );
    sink.emitEvent(
      createNormalizedEvent(
        "message.started",
        { provider: request.provider, runId: request.runId },
        { messageId: initialUuid },
      ),
    );

    let accumulatedText = "";
    let pendingMessages = 1;
    let firstStreamEventLogged = false;
    let firstTextDeltaLogged = false;
    let lastTerminalReason: string | undefined;
    let lastIsError = false;
    const rawPayloads: Array<Record<string, unknown>> = [];

    try {
      for await (const item of parseNdjsonStream(response.body)) {
        if (
          item &&
          typeof item === "object" &&
          "_error" in (item as Record<string, unknown>)
        ) {
          throw new Error(
            String((item as { _error: unknown })._error ?? "daemon error"),
          );
        }
        const message = item as SDKMessage;
        rawPayloads.push(message as unknown as Record<string, unknown>);
        sink.emitRaw(toRawEvent(request.runId, message, message.type));

        if (message.type === "system") {
          const sys = message as SDKSystemMessage;
          // Session id is already set on the sink (pre-minted before
          // POSTing /start). The init message arrives confirming what
          // claude assigned — should match `presetSessionId`.
          if (sys.subtype === "init" && sys.session_id) {
            debugClaude(
              "★ session.init session_id=%s (%dms)",
              sys.session_id.slice(0, 8),
              Date.now() - executeStartedAt,
            );
          }
          continue;
        }

        if (message.type === "stream_event") {
          if (!firstStreamEventLogged) {
            firstStreamEventLogged = true;
            debugClaude(
              "★ first stream_event (%dms since execute start)",
              Date.now() - executeStartedAt,
            );
          }
          const partial = message as SDKPartialAssistantMessage;
          const { text, thinking } = extractStreamDeltas(partial);
          if (thinking) {
            sink.emitEvent(
              createNormalizedEvent(
                "reasoning.delta",
                { provider: request.provider, runId: request.runId },
                { delta: thinking },
              ),
            );
          }
          if (text) {
            if (!firstTextDeltaLogged) {
              firstTextDeltaLogged = true;
              debugClaude(
                "★ first text delta (%dms since execute start)",
                Date.now() - executeStartedAt,
              );
            }
            accumulatedText += text;
            sink.emitEvent(
              createNormalizedEvent(
                "text.delta",
                { provider: request.provider, runId: request.runId },
                { delta: text },
              ),
            );
          }
          continue;
        }

        if (message.type === "assistant") {
          const asst = message as SDKAssistantMessage;
          const thinking = extractAssistantThinking(asst);
          if (thinking) {
            sink.emitEvent(
              createNormalizedEvent(
                "reasoning.delta",
                { provider: request.provider, runId: request.runId },
                { delta: thinking },
              ),
            );
          }
          const text = extractAssistantText(asst);
          sink.emitEvent(
            createNormalizedEvent(
              "message.completed",
              { provider: request.provider, runId: request.runId },
              {
                text,
                ...(asst.uuid ? { messageId: String(asst.uuid) } : {}),
              },
            ),
          );
          continue;
        }

        if (message.type === "result") {
          const result = message as SDKResultMessage;
          lastTerminalReason = result.terminal_reason;
          lastIsError = result.is_error;
          const resultText =
            result.subtype === "success" ? result.result : accumulatedText;
          if (resultText && resultText !== accumulatedText) {
            accumulatedText = resultText;
          }
          pendingMessages--;
          if (pendingMessages <= 0) break;
          continue;
        }
      }

      const finalText = accumulatedText;
      const isCancelled =
        lastTerminalReason === "aborted_streaming" ||
        lastTerminalReason === "aborted_tools";
      // is_error is the authoritative error signal — it covers both
      // explicit error subtypes and cases where subtype=success but
      // the run failed (e.g. auth errors after retries exhausted).
      // Cancel is checked first since aborted runs also have is_error=true.
      const isError = !isCancelled && lastIsError;

      if (isCancelled) {
        debugClaude(
          "★ run.cancelled (%dms since execute start) reason=%s",
          Date.now() - executeStartedAt,
          lastTerminalReason,
        );
        sink.cancel({
          text: finalText,
          costData: extractClaudeCostData(rawPayloads),
        });
      } else if (isError) {
        debugClaude(
          "★ run.error (%dms since execute start) reason=%s",
          Date.now() - executeStartedAt,
          lastTerminalReason,
        );
        sink.fail(new Error(finalText || `claude-code run failed (terminal_reason: ${lastTerminalReason})`));
      } else {
        debugClaude(
          "★ run.completed (%dms since execute start) chars=%d",
          Date.now() - executeStartedAt,
          finalText.length,
        );
        sink.emitEvent(
          createNormalizedEvent(
            "run.completed",
            { provider: request.provider, runId: request.runId },
            { text: finalText },
          ),
        );
        sink.complete({
          text: finalText,
          costData: extractClaudeCostData(rawPayloads),
        });
      }
    } finally {
      // Daemon's `req.on('close')` handler will tear down its
      // run-side state when this connection closes.
      fetchAbort.abort();
    }

    return async () => undefined;
  }

  /**
   * Stateless abort. POSTs to the in-sandbox daemon's
   * `/runs/<id>/abort`. The daemon calls `query.interrupt()` on the
   * matching live run; the originating instance's NDJSON read loop
   * sees the run unwind via a non-success `result` (or stream close).
   */
  async attachAbort(request: AgentAttachRequest<"claude-code">): Promise<void> {
    const baseUrl = await daemonBaseUrl(request.sandbox);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      await fetch(
        `${baseUrl}/runs/${encodeURIComponent(request.runId)}/abort`,
        {
          method: "POST",
          signal: controller.signal,
          headers: request.sandbox.previewHeaders,
        },
      ).catch((error) => {
        debugClaude("attachAbort POST failed: %o", error);
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Stateless message injection. POSTs `{ content }` to the daemon's
   * `/runs/<id>/sendMessage`. The daemon pushes the message into the
   * matching run's prompt iterable, which the SDK forwards to claude
   * as a fresh user turn.
   */
  async attachSendMessage(
    request: AgentAttachRequest<"claude-code">,
    content: UserContent,
  ): Promise<void> {
    const baseUrl = await daemonBaseUrl(request.sandbox);
    const inputParts = await validateProviderUserInput(
      AgentProvider.ClaudeCode,
      content,
    );
    const mapped = mapToClaudeUserContent(inputParts);
    const response = await fetch(
      `${baseUrl}/runs/${encodeURIComponent(request.runId)}/sendMessage`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...request.sandbox.previewHeaders,
        },
        body: JSON.stringify({ content: mapped }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `claude-code attachSendMessage failed: ${response.status} ${await response.text().catch(() => "")}`,
      );
    }
  }
}
