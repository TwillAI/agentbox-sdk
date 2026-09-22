import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  createNormalizedEvent,
  normalizeRawAgentEvent,
  type BackgroundTask,
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
import { isInteractiveApproval, hasInteractiveQuestions } from "../approval";
import {
  builtinHarnessCommands,
  openCodeHarnessCommands,
  skillDirective,
  type HarnessCommandDescriptor,
  type HarnessCommandInvocation,
  type OpenCodeCommandEntry,
  type OpenCodeSkillEntry,
} from "../harness-commands";
import {
  BACKGROUND_TASK_GRACE_MS,
  BackgroundWait,
  BackgroundWaitFinish,
  type BackgroundWaitExpiry,
  resolveBackgroundTaskTimeoutMs,
  withTimeout,
} from "../background-tasks";
import { normalizeUserQuestions, questionReply } from "../questions";
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
import { agentboxRoot, createSetupTarget } from "../config/setup";
import { resolveCapabilityToken } from "../config/capability-token";
import { activateRtk } from "../config/rtk";
import { prepareSkillArtifacts } from "../config/skills";
import {
  applyDifferentialSetup,
  computeSetupId,
  markSetupComplete,
  preflightSetup,
} from "../config/setup-manifest";
import { buildOpenCodeSubagentConfig } from "../config/subagents";
import { fetchJson, streamSseResilient } from "../transports/app-server";
import { spawnCommand, type SpawnedProcess } from "../transports/spawn";
import { sleep, waitFor, getAvailablePort } from "../../shared/network";
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
const SANDBOX_OPENCODE_READY_TIMEOUT_MS = 90_000;
const LOCAL_OPENCODE_READY_TIMEOUT_MS = 20_000;
const SHARED_OPENCODE_TARGET_ID = "shared-opencode-server";

// Daytona sandboxes stay `public: true` (the user-facing app preview must be
// publicly reachable), so the opencode server port is publicly reachable too.
// We close that hole with opencode's native HTTP basic auth: a per-sandbox
// capability token is set as OPENCODE_SERVER_PASSWORD at launch and presented
// by the host on every request. Username defaults to `opencode`.
const OPENCODE_AUTH_USERNAME = "opencode";

/**
 * Stable path (under the opencode agentbox root) of the capability token file.
 * setup() writes it, the host reads it to build the basic-auth header, and the
 * in-sandbox health probes read it to authenticate — all must resolve the same
 * path. Matches the target's `layout.rootDir` (see `agentboxRoot`).
 */
function opencodeServerTokenPath(): string {
  return path.posix.join(
    agentboxRoot(AgentProvider.OpenCode, true),
    "opencode-auth-token",
  );
}

/**
 * Raw, already-quoted curl auth fragment: opencode's HTTP basic-auth password
 * is the capability token, read from the 0600 file inside the sandbox at probe
 * time. Reused by the loopback health probe and the warm-path preflight probe.
 */
function opencodeCurlAuthArg(): string {
  return `-u "opencode:$(cat ${shellQuote(opencodeServerTokenPath())} 2>/dev/null)"`;
}

/**
 * Authenticated loopback health probe. Once OPENCODE_SERVER_PASSWORD is set,
 * opencode gates `/global/health` behind basic auth, so the probe presents the
 * token as the password; otherwise a healthy server answers 401 and `curl -f`
 * would report it as down.
 */
function opencodeHealthCurl(port: number): string {
  return `curl -fsS --max-time 2 ${opencodeCurlAuthArg()} http://127.0.0.1:${port}/global/health >/dev/null 2>&1`;
}

/**
 * Does the in-sandbox opencode server actually ENFORCE the capability token?
 * An unauthenticated probe must be rejected with 401; a 200 means the running
 * binary ignored OPENCODE_SERVER_PASSWORD (too old) and the public port is
 * wide open. Used to gate warm reuse and as a fail-closed launch assertion.
 */
async function isSandboxOpenCodeServerAuthEnforced(
  sandbox: NonNullable<AgentOptions<"open-code">["sandbox"]>,
  cwd: string | undefined,
  port: number,
): Promise<boolean> {
  const probe = await sandbox
    .run(
      `test "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:${port}/global/health)" = "401"`,
      { cwd, timeoutMs: 5_000 },
    )
    .catch(() => undefined);
  return probe?.exitCode === 0;
}

/**
 * Host -> server headers: the sandbox preview headers (Daytona private-sandbox
 * token, when set) plus opencode's basic-auth credential built from the
 * per-sandbox capability token. `create: false` — setup() must have minted and
 * written the token first.
 */
async function opencodeAuthHeaders(
  sandbox: NonNullable<AgentOptions<"open-code">["sandbox"]>,
): Promise<Record<string, string>> {
  const token = await resolveCapabilityToken(
    sandbox,
    opencodeServerTokenPath(),
    false,
  );
  const basic = Buffer.from(`${OPENCODE_AUTH_USERNAME}:${token}`).toString(
    "base64",
  );
  return { ...sandbox.previewHeaders, Authorization: `Basic ${basic}` };
}

/**
 * LLM provider API keys opencode reads from its process env. These are
 * the only env vars whose change must restart the server — see
 * {@link hashLlmApiKeys}.
 */
const LLM_API_KEY_ENV_VARS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
] as const;

/**
 * Stable fingerprint of the LLM provider API keys in the caller-provided
 * environment. The opencode server reads these credentials from its
 * process env at spawn time only — there is no per-request credential
 * override over the HTTP API, and keys are never written into the config
 * file. So a key change between runs is invisible to an already-running
 * server. Folding this fingerprint into the setupId makes such a change
 * flip the setup marker, miss the preflight, and trigger a kill-and-respawn
 * so the new credentials actually take effect. We hash only the known LLM
 * key names (not the whole env) so unrelated env churn doesn't needlessly
 * restart the shared server.
 */
function hashLlmApiKeys(env: Record<string, string> | undefined): string {
  const hasher = createHash("sha256");
  for (const key of LLM_API_KEY_ENV_VARS) {
    if (env?.[key] !== undefined) {
      hasher.update(`${key}=${env[key]}\n`);
    }
  }
  return hasher.digest("hex");
}


interface LocalOpenCodeServer {
  baseUrl: string;
  headers: Record<string, string>;
  process: SpawnedProcess;
}

// A local server belongs to this Agent instance. Never discover or kill a
// developer's server by a public port number, or reuse a different Agent's
// configuration/credentials just because its health endpoint responds.
const localOpenCodeServers = new WeakMap<AgentOptions<"open-code">, Promise<LocalOpenCodeServer>>();

async function killLocalOpenCodeServer(options: AgentOptions<"open-code">): Promise<void> {
  const pending = localOpenCodeServers.get(options);
  if (!pending) return;
  const server = await pending;
  await server.process.kill();
  localOpenCodeServers.delete(options);
}

/**
 * Stop the sandbox `opencode serve` recorded in `pidFilePath` and wait
 * until its health endpoint stops responding. The daemon is launched
 * under `setsid` so its process-group id equals its pid — killing the
 * group (`kill -- -PID`) reaps any children too, with a plain `kill PID`
 * fallback.
 */
async function killSandboxOpenCodeServer(
  sandbox: NonNullable<AgentOptions<"open-code">["sandbox"]>,
  pidFilePath: string,
  cwd: string | undefined,
  port: number,
): Promise<void> {
  await time(debugOpencode, "kill sandbox opencode server", async () => {
    await sandbox
      .run(
        `kill -- -"$(cat ${shellQuote(pidFilePath)})" 2>/dev/null || kill "$(cat ${shellQuote(pidFilePath)})" 2>/dev/null || true`,
        { cwd, timeoutMs: 5_000 },
      )
      .catch(() => undefined);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const probe = await sandbox.run(opencodeHealthCurl(port), {
        cwd,
        timeoutMs: 5_000,
      });
      if (probe.exitCode !== 0) {
        return;
      }
      await sleep(200);
    }
  });
}

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

/**
 * Child session named by the `<task id=… state=completed|error>` result that
 * opencode injects into the parent (TaskTool.renderOutput) once a background
 * subagent ends: that child is done, whatever frames of its own were lost.
 */
function injectedTaskResultChild(text: string): string | undefined {
  return /<task id="?([^"\s>]+)"? state="?(?:completed|error)"?>/.exec(text)?.[1];
}

export type OpenCodeCommandDispatch =
  | { kind: "summarize" }
  | { kind: "command"; command: string; arguments: string }
  /** A normal prompt; `text` replaces the first text part when set. */
  | { kind: "prompt"; text?: string };

/**
 * OpenCode never parses slash commands on a prompt, so a leading `/name`
 * maps here: `/compact` becomes `POST /session/:id/summarize`, a configured
 * command (built-in `init`/`review`, `.opencode/command/*.md`, MCP prompts)
 * becomes `POST /session/:id/command`, a skill becomes a directive the model
 * follows through its `skill` tool, and anything else stays plain text.
 */
export function resolveOpenCodeCommandDispatch(
  command: HarnessCommandInvocation | undefined,
  harnessCommands: readonly HarnessCommandDescriptor[],
): OpenCodeCommandDispatch {
  if (!command) return { kind: "prompt" };
  if (command.name === "compact") return { kind: "summarize" };
  const known = harnessCommands.find((entry) => entry.name === command.name);
  if (!known) return { kind: "prompt" };
  if (known.source === "skill")
    return { kind: "prompt", text: skillDirective(command.name, command.args) };
  return { kind: "command", command: command.name, arguments: command.args };
}

function replaceOpenCodePromptText(
  parts: OpenCodePromptPart[],
  text: string,
): OpenCodePromptPart[] {
  let replaced = false;
  const next = parts.map((part) => {
    if (part.type !== "text" || replaced) return part;
    replaced = true;
    return { ...part, text };
  });
  return replaced ? next : [{ type: "text", text }, ...next];
}

/**
 * `GET /command` fans out to every connected MCP server, so discovery is
 * only as fast as the slowest one. It runs before the turn is dispatched
 * and before the silence watchdog arms, so it is bounded twice over — an
 * abort signal on the requests and a race on the whole listing — and a
 * wedged server costs the run five seconds, not the run itself.
 */
const OPENCODE_COMMAND_DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Commands and skills the server exposes. `GET /skill` is newer than
 * `GET /command`; either failing or timing out degrades to the built-in
 * list so a run never fails on discovery alone.
 */
async function listOpenCodeHarnessCommands(
  runtime: Pick<OpenCodeRuntime, "baseUrl" | "previewHeaders">,
): Promise<HarnessCommandDescriptor[]> {
  const init = {
    headers: runtime.previewHeaders,
    signal: AbortSignal.timeout(OPENCODE_COMMAND_DISCOVERY_TIMEOUT_MS),
  };
  try {
    const listed = await withTimeout(
      Promise.all([
        fetchJson<OpenCodeCommandEntry[]>(`${runtime.baseUrl}/command`, init),
        fetchJson<OpenCodeSkillEntry[]>(`${runtime.baseUrl}/skill`, init).catch(
          () => [] as OpenCodeSkillEntry[],
        ),
      ]),
      OPENCODE_COMMAND_DISCOVERY_TIMEOUT_MS,
    );
    if (!listed) {
      debugOpencode(
        "GET /command did not answer within %dms; reporting built-in commands only",
        OPENCODE_COMMAND_DISCOVERY_TIMEOUT_MS,
      );
      return builtinHarnessCommands("open-code");
    }
    const [commands, skills] = listed;
    return openCodeHarnessCommands(
      Array.isArray(commands) ? commands : [],
      Array.isArray(skills) ? skills : [],
    );
  } catch (error) {
    debugOpencode(
      "GET /command unavailable; reporting built-in commands only: %o",
      error,
    );
    return builtinHarnessCommands("open-code");
  }
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
      toolName: permission,
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

const FALLBACK_OPEN_CODE_AGENT_PROMPT =
  "You are an AI coding assistant. Follow the user's instructions.";

export function buildOpenCodeConfig(
  options: AgentOptions<"open-code">,
  interactiveApproval: boolean,
) {
  const mcpConfig = buildOpenCodeMcpConfig(options.mcps);
  const commandsConfig = buildOpenCodeCommandsConfig(options.commands);
  // The agent's `prompt` field is the FIRST and most prominent system
  // message the model sees — opencode's session/llm.ts composes the
  // system stack like:
  //
  //   ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
  //   ...input.system,                       // env + AGENTS.md + skills
  //   ...(input.user.system ? [input.user.system] : []),  // per-message system override
  //
  // ...all joined with `\n` into a single string. When `agent.prompt`
  // is set, opencode skips the built-in provider prompt
  // (`anthropic.txt` / `gpt.txt` / `gemini.txt` / etc.) entirely.
  //
  // We always set `agent.prompt` to suppress opencode's default
  // provider prompt (e.g. PROMPT_ANTHROPIC's "You are OpenCode..."),
  // which would otherwise bury anything the caller passes in. When
  // {@link OpenCodeAgentOptions.systemPrompt} is provided, we use that
  // verbatim as the agent prompt — that's the only reliable way to
  // make the system prompt actually steer Anthropic models, since
  // Sonnet/Opus are highly prompt-adherent and ignore content
  // appended *after* the leading agent prompt (which is exactly where
  // the per-message `system` field passed via `dispatchPrompt` lands).
  // When `options.systemPrompt` is unset, we fall back to a short
  // generic prompt so the per-message `system` field at least
  // dominates the runtime appendix that follows.
  //
  // Setup-time field: changing `options.systemPrompt` between runs
  // changes `agentbox.json`'s content hash, which flips the setupId and
  // misses the preflight on the next `setup()` call. The opencode server
  // reads agent definitions at startup, so the drift path restarts the
  // server (kill + cold spawn) so the new prompt actually takes effect.
  const baseAgent = {
    mode: "primary",
    prompt: options.systemPrompt || FALLBACK_OPEN_CODE_AGENT_PROMPT,
    permission: buildOpenCodePermissionConfig(interactiveApproval),
    tools: {
      question: hasInteractiveQuestions(options),
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
  const googleBaseUrl = options.env?.GOOGLE_BASE_URL;
  const openRouterBaseUrl = options.env?.OPENROUTER_BASE_URL;
  const openRouterPlugins =
    options.openRouterPlugins && options.openRouterPlugins.length > 0
      ? options.openRouterPlugins
      : undefined;
  // OpenRouter request-body params must travel via `extraBody` — that's the
  // only channel `@openrouter/ai-sdk-provider`'s `createOpenRouter()` merges
  // into every request. A top-level `plugins` option is silently dropped by
  // the constructor, so the directive never reaches OpenRouter and the model's
  // hard context limit is enforced instead. `transforms: ["middle-out"]` is
  // OpenRouter's built-in, always-available compaction (drops/compresses the
  // middle of the history to fit the window); it doesn't depend on a plugin id
  // being recognized, so it's an unconditional safety net against overflow.
  const openRouterExtraBody = {
    transforms: ["middle-out"],
    ...(openRouterPlugins ? { plugins: openRouterPlugins } : {}),
  };

  // Custom request headers go on each provider's `options.headers`. opencode's
  // config-level header support is subject to upstream behavior, so treat this
  // as best-effort. Includes an `anthropic` entry so the Anthropic provider
  // (no entry otherwise) can carry the headers too.
  const customHeaders =
    options.customHeaders && Object.keys(options.customHeaders).length > 0
      ? options.customHeaders
      : undefined;
  const headerOpts = customHeaders ? { headers: customHeaders } : {};

  return {
    $schema: "https://opencode.ai/config.json",
    ...(mcpConfig ? { mcp: mcpConfig } : {}),
    ...(commandsConfig ? { command: commandsConfig } : {}),
    provider: {
      openrouter: {
        options: {
          baseURL: openRouterBaseUrl || "https://openrouter.ai/api/v1",
          extraBody: openRouterExtraBody,
          ...headerOpts,
        },
      },
      ...(googleBaseUrl
        ? { google: { options: { baseURL: googleBaseUrl, ...headerOpts } } }
        : {}),
      ...(customHeaders ? { anthropic: { options: { ...headerOpts } } } : {}),
    },
    agent: {
      agentbox: baseAgent,
      ...reasoningVariants,
      ...buildOpenCodeSubagentConfig(
        options.subAgents,
        buildOpenCodePermissionConfig(interactiveApproval),
      ),
    },
  };
}

/**
 * Sandbox-side preparation for opencode (remote case). Idempotent:
 *
 *   1. Compute setupId for the artifact set + daemon expectation + an
 *      LLM API-key fingerprint, then run `preflightSetup`: one no-upload
 *      sandbox.run that checks the `setup.id` marker AND probes loopback
 *      `/global/health`. If both match, return immediately — no tarball
 *      stream, no spawn.
 *   2. Cold/drifted path: upload artifacts (config, plugins, skills,
 *      sub-agent definitions) via the differential-setup manifest, stop
 *      any stale server still on the port (its env/config changed), spawn
 *      a fresh `opencode serve` on the static port, poll until ready, then
 *      mark setup complete.
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

    const plugins = assertHooksSupported(request.provider, options);
    assertCommandsSupported(request.provider, options.commands);
    const interactiveApproval = !options.fullAccess && isInteractiveApproval(options);

    const target = await createSetupTarget(
      request.provider,
      SHARED_OPENCODE_TARGET_ID,
      options,
    );

    // Mint (or reuse) the capability token before building artifacts. Written
    // 0600 below and set as OPENCODE_SERVER_PASSWORD at launch; the host reads
    // the same file to authenticate every request.
    const serverTokenPath = opencodeServerTokenPath();
    const serverToken = await resolveCapabilityToken(
      sandbox,
      serverTokenPath,
      true,
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
    const openCodeConfig = buildOpenCodeConfig(options, interactiveApproval);
    const allArtifacts = [
      ...skillArtifacts,
      ...pluginArtifacts,
      {
        path: configPath,
        content: JSON.stringify(openCodeConfig, null, 2),
      },
      {
        path: serverTokenPath,
        content: serverToken,
      },
    ];

    const enableRtk = options.enableRtk === true;
    // curlAuthArg lets the warm-path preflight probe authenticate against the
    // now password-gated /global/health; without it the probe always 401s and
    // the cheap short-circuit never fires. It is intentionally excluded from
    // computeSetupId (see PreflightDaemon) so it can't invalidate markers.
    const daemonInfo = {
      port,
      healthPath: "/global/health",
      curlAuthArg: opencodeCurlAuthArg(),
    };
    const setupId = computeSetupId({
      artifacts: allArtifacts,
      installCommands,
      daemon: daemonInfo,
      extras: [
        `enableRtk:${enableRtk}`,
        `apiKeys:${hashLlmApiKeys(options.env)}`,
      ],
    });
    if (await preflightSetup(target, setupId, daemonInfo)) {
      debugOpencode("opencode setup() preflight hit — skipping");
      return;
    }

    // Preflight missed: either no server is up, or one IS up but the
    // desired config/credentials drifted from what it booted with. We must
    // NEVER auto-kill a running server to apply that drift — it is shared
    // across runs (single static port), so restarting it would reset any
    // concurrent run. Restarts are the developer's explicit call via
    // `agent.killServer()`. So if a healthy server is already listening,
    // reuse it untouched; the new config is staged on disk and takes effect
    // only on the next cold start (after `killServer()`).
    if (await isSandboxOpenCodeServerHealthy(sandbox, options.cwd, port)) {
      if (
        await isSandboxOpenCodeServerAuthEnforced(sandbox, options.cwd, port)
      ) {
        debugOpencode(
          "opencode server already running but setup drifted — reusing it " +
            "without restart; call agent.killServer() to apply the new config",
        );
        return;
      }
      // Healthy but NOT enforcing the capability token — a server from before
      // auth was introduced (or a build that ignores OPENCODE_SERVER_PASSWORD).
      // This is the one case we DO auto-restart a running server: an
      // unauthenticated, publicly-reachable opencode port is exactly the
      // vulnerability we're closing, so security overrides the no-auto-kill
      // rule. Fall through to the cold path, which kills it and relaunches
      // with the password env.
      debugOpencode(
        "opencode server running without capability auth — restarting to enforce it",
      );
    }

    const commonEnv = {
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: target.layout.opencodeDir,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_ENABLE_QUESTION_TOOL: hasInteractiveQuestions(options) ? "true" : "false",
    };

    await applyDifferentialSetup(target, allArtifacts, installCommands);

    // Activate RTK before launching `opencode serve` so the plugin file is
    // present when the server scans its plugins dir at boot.
    if (enableRtk) {
      await time(debugOpencode, "activateRtk", () => activateRtk(target));
    }

    const binary = options.provider?.binary ?? "opencode";
    const pidFilePath = path.posix.join(
      target.layout.rootDir,
      "opencode-serve.pid",
    );
    const logFilePath = path.posix.join(
      target.layout.rootDir,
      "opencode-serve.log",
    );
    const serveEnv = {
      ...(options.env ?? {}),
      ...commonEnv,
      // Native opencode HTTP basic auth. The host presents this token on
      // every request (see opencodeAuthHeaders); the in-sandbox health probes
      // present it too (see opencodeHealthCurl).
      OPENCODE_SERVER_USERNAME: OPENCODE_AUTH_USERNAME,
      OPENCODE_SERVER_PASSWORD: serverToken,
    };
    // Detach the daemon fully from the spawning shell:
    //   - `setsid` puts opencode in its own session + process group so the
    //     sandbox doesn't kill it when our wrapper shell exits.
    //   - `< /dev/null` releases stdin.
    //   - `> log 2>&1` redirects stdout/stderr to the log file so the
    //     daemon doesn't keep the parent's pipes open.
    //   - `&` backgrounds, the trailing `disown` (where supported) removes
    //     the job from the shell's job table.
    // Without this, daytona's `runAsync` session keeps polling for the
    // command's exit and never sees one — the backgrounded opencode
    // daemon, despite being nohup'd, was enough to keep the session
    // marked as "running" for the entire ready timeout.
    const launchCommand = [
      `mkdir -p ${shellQuote(target.layout.rootDir)}`,
      `chmod 600 ${shellQuote(serverTokenPath)} 2>/dev/null || true`,
      `(${[
        `setsid nohup ${[
          binary,
          "serve",
          "--hostname",
          "0.0.0.0",
          "--port",
          String(port),
          ...(options.provider?.args ?? []),
        ]
          .map(shellQuote)
          .join(" ")} </dev/null > ${shellQuote(logFilePath)} 2>&1 &`,
        `echo $! > ${shellQuote(pidFilePath)}`,
        `disown 2>/dev/null || true`,
      ].join(" ")})`,
    ].join(" && ");

    // Reaching here means NO healthy server is up (the health check above
    // returned early when one was) — this is a genuine cold start. The kill
    // in the relaunch loop below therefore only ever reaps a dead/wedged
    // process or one we ourselves spawned this call that then crashed; it
    // never tears down a healthy server serving a concurrent run. Stopping a
    // stale/dying process first also keeps the readiness probe from getting a
    // false positive against it.
    // Launch `opencode serve` and wait for readiness, RELAUNCHING if the
    // server process dies before it starts listening.
    //
    // Why retries: a freshly-forked Daytona sandbox can briefly fail
    // filesystem operations while its copy-on-write disk settles. opencode
    // creates a SQLite store on first boot, and during that window the create
    // can fail with "unable to open database file", which crashes the server
    // before it ever listens. The previous single-shot launch then polled a
    // dead port for the whole 90s timeout and threw an opaque "did not become
    // ready" with no server log — the exact "stuck setting up opencode"
    // symptom. We instead notice the process exited (via `kill -0` on the
    // pid), relaunch, and on total failure include the opencode log so a
    // genuine (non-transient) startup error is finally visible.
    //
    // We can't poll the preview URL: some sandbox proxies (Vercel's in
    // particular) return a synthetic 200 with an empty body for ports whose
    // listener hasn't started accepting yet, so a fetch-based check would get
    // a false positive while opencode is still doing its first-run DB
    // migration. The loopback curl below is the only authoritative signal.
    const OPENCODE_MAX_LAUNCH_ATTEMPTS = 4;
    const OPENCODE_RELAUNCH_BACKOFF_MS = 1_000;
    const readyDeadline = Date.now() + SANDBOX_OPENCODE_READY_TIMEOUT_MS;
    const pidAlive = `kill -0 "$(cat ${shellQuote(pidFilePath)} 2>/dev/null)" 2>/dev/null`;
    let lastLog = "";

    const becameReady = await time(
      debugOpencode,
      "launch + poll opencode until ready",
      async () => {
        for (
          let attempt = 1;
          attempt <= OPENCODE_MAX_LAUNCH_ATTEMPTS && Date.now() < readyDeadline;
          attempt++
        ) {
          // Stop any stale/previous server first (no-op when nothing runs) so
          // a relaunch binds a fresh process and the readiness probe can't be
          // a false positive against a dying one.
          await killSandboxOpenCodeServer(
            sandbox,
            pidFilePath,
            options.cwd,
            port,
          );

          // Fire-and-forget detacher; it exits in milliseconds. Actual
          // readiness is verified by the probe loop, the only real signal.
          const launchResult = await sandbox.run(launchCommand, {
            cwd: options.cwd,
            env: serveEnv,
            timeoutMs: 40_000,
          });
          if (launchResult.exitCode !== 0) {
            await target.cleanup().catch(() => undefined);
            throw new Error(
              `Could not start OpenCode server: ${launchResult.combinedOutput || launchResult.stderr}`,
            );
          }

          while (Date.now() < readyDeadline) {
            const probe = await sandbox.run(opencodeHealthCurl(port), {
              cwd: options.cwd,
              timeoutMs: 5_000,
            });
            if (probe.exitCode === 0) {
              debugOpencode("ready on attempt %d", attempt);
              return true;
            }
            // If the server already exited, don't keep polling a dead port —
            // capture its log and break out to relaunch.
            const alive = await sandbox.run(pidAlive, {
              cwd: options.cwd,
              timeoutMs: 5_000,
            });
            if (alive.exitCode !== 0) {
              lastLog =
                (
                  await sandbox
                    .run(`tail -n 40 ${shellQuote(logFilePath)} 2>/dev/null`, {
                      cwd: options.cwd,
                    })
                    .catch(() => undefined)
                )?.combinedOutput?.trim() ?? lastLog;
              debugOpencode(
                "opencode died on attempt %d/%d; relaunching. log:\n%s",
                attempt,
                OPENCODE_MAX_LAUNCH_ATTEMPTS,
                lastLog,
              );
              break;
            }
            await sleep(500);
          }

          // The process is still alive but the deadline passed → a genuine
          // hang, not a crash a relaunch would fix. Stop retrying.
          if (Date.now() >= readyDeadline) break;
          await sleep(OPENCODE_RELAUNCH_BACKOFF_MS);
        }
        return false;
      },
    );

    if (!becameReady) {
      // Best-effort: grab the latest log if we don't already have one (e.g. a
      // hang where the process never died).
      if (!lastLog) {
        lastLog =
          (
            await sandbox
              .run(`tail -n 40 ${shellQuote(logFilePath)} 2>/dev/null`, {
                cwd: options.cwd,
              })
              .catch(() => undefined)
          )?.combinedOutput?.trim() ?? "";
      }
      await target.cleanup().catch(() => undefined);
      throw new Error(
        `OpenCode server did not become ready within ${SANDBOX_OPENCODE_READY_TIMEOUT_MS}ms.` +
          (lastLog ? `\nopencode log:\n${lastLog}` : ""),
      );
    }

    // Fail closed: the running binary must actually enforce the capability
    // token. An older opencode silently ignores OPENCODE_SERVER_PASSWORD,
    // leaving the (publicly reachable) port unauthenticated — refuse to
    // proceed rather than ship an open server.
    if (
      !(await isSandboxOpenCodeServerAuthEnforced(sandbox, options.cwd, port))
    ) {
      await killSandboxOpenCodeServer(
        sandbox,
        pidFilePath,
        options.cwd,
        port,
      ).catch(() => undefined);
      await target.cleanup().catch(() => undefined);
      throw new Error(
        "OpenCode server started but is not enforcing the capability token " +
          "(OPENCODE_SERVER_PASSWORD ignored). Upgrade opencode-ai to a " +
          "version that supports server authentication.",
      );
    }

    await markSetupComplete(target, setupId);
  });
}


/** A private config directory, ephemeral loopback port, and owned process. */
async function startLocalOpenCodeServer(request: AgentSetupRequest<"open-code">): Promise<LocalOpenCodeServer> {
  const originalOptions = request.options;
  const options = {
    ...originalOptions,
    stateDirectory: path.join(originalOptions.stateDirectory ?? path.join(os.tmpdir(), "agentbox-native"), "instances", randomUUID()),
  };
  let generatedEnv: Record<string, string> = {};
  if (options.configuration !== "native") {
    const plugins = assertHooksSupported(request.provider, options);
    assertCommandsSupported(request.provider, options.commands);
    const target = await createSetupTarget(request.provider, "shared-setup", options);
    const { artifacts: skillArtifacts, installCommands } = await prepareSkillArtifacts(request.provider, options.skills, target.layout);
    const configPath = path.join(target.layout.opencodeDir, "agentbox.json");
    const artifacts = [
      ...skillArtifacts,
      ...buildOpenCodePluginArtifacts(plugins, target.layout.opencodeDir),
      { path: configPath, content: JSON.stringify(buildOpenCodeConfig(options, isInteractiveApproval(options)), null, 2) },
    ];
    await applyDifferentialSetup(target, artifacts, installCommands);
    generatedEnv = {
      OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: target.layout.opencodeDir,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_ENABLE_QUESTION_TOOL: hasInteractiveQuestions(options) ? "true" : "false",
    };
  }
  const port = await getAvailablePort();
  const password = randomBytes(32).toString("base64url");
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
  const processHandle = spawnCommand({
    command: options.provider?.binary ?? "opencode",
    args: ["serve", ...(options.provider?.args ?? []), "--hostname", "127.0.0.1", "--port", String(port)],
    cwd: options.cwd,
    processGroup: options.processGroup !== "inherited",
    env: {
      ...process.env, ...options.env,
      ...generatedEnv,
      ...(options.fullAccess ? { OPENCODE_PERMISSION: JSON.stringify({ "*": "allow", question: "ask" }) } : {}),
      ...(options.interactiveQuestions === true ? { OPENCODE_ENABLE_QUESTION_TOOL: "true" } : {}),
      OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password,
    },
  });
  // OpenCode is a long-lived server. Drain both pipes so verbose output cannot
  // fill an OS pipe and freeze the agent; output can contain local secrets.
  processHandle.child.stdout.resume();
  processHandle.child.stderr.resume();
  try {
    let startupError: Error | undefined;
    void processHandle.wait().then(
      (code) => { startupError = new Error(`Local OpenCode server exited before startup (${code})`); },
      (error: unknown) => { startupError = error instanceof Error ? error : new Error(String(error)); },
    );
    await waitFor(async () => {
      if (startupError) throw startupError;
      try { return (await fetch(`${baseUrl}/global/health`, { headers, signal: AbortSignal.timeout(1000) })).ok; }
      catch { return false; }
    }, { timeoutMs: LOCAL_OPENCODE_READY_TIMEOUT_MS });
    const unauthenticated = await fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(3000) });
    if (unauthenticated.status !== 401) throw new Error("This OpenCode version does not enforce local server authentication. Upgrade OpenCode before running it through AgentBox.");
    return { baseUrl, headers, process: processHandle };
  } catch (error) {
    await processHandle.kill();
    throw error;
  }
}

async function ensureLocalOpenCodeServer(request: AgentSetupRequest<"open-code">): Promise<void> {
  let pending = localOpenCodeServers.get(request.options);
  if (!pending) {
    pending = startLocalOpenCodeServer(request);
    localOpenCodeServers.set(request.options, pending);
  }
  try { await pending; }
  catch (error) { localOpenCodeServers.delete(request.options); throw error; }
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
 * Is an opencode server already answering `/global/health` on `port`
 * inside the sandbox? Used by setup() to decide between reusing a live
 * server (the no-auto-kill path) and cold-starting one — never to decide
 * whether to kill a healthy server.
 */
async function isSandboxOpenCodeServerHealthy(
  sandbox: NonNullable<AgentOptions<"open-code">["sandbox"]>,
  cwd: string | undefined,
  port: number,
): Promise<boolean> {
  const probe = await sandbox
    .run(opencodeHealthCurl(port), { cwd, timeoutMs: 5_000 })
    .catch(() => undefined);
  return probe?.exitCode === 0;
}

/**
 * Explicit, developer-invoked teardown of the opencode server (see
 * {@link AgentProviderAdapter.killServer}). agentbox never calls this
 * automatically. After it returns, the next `setup()` cold-starts a fresh
 * server (the health probe in `preflightSetup` fails, so the warm-path
 * marker no longer short-circuits).
 */
async function killOpenCodeServer(
  request: AgentSetupRequest<"open-code">,
): Promise<void> {
  const { options } = request;
  if (options.sandbox) {
    const target = await createSetupTarget(
      request.provider,
      SHARED_OPENCODE_TARGET_ID,
      options,
    );
    const pidFilePath = path.posix.join(
      target.layout.rootDir,
      "opencode-serve.pid",
    );
    await killSandboxOpenCodeServer(
      options.sandbox,
      pidFilePath,
      options.cwd,
      SANDBOX_OPENCODE_PORT,
    );
    return;
  }
  await killLocalOpenCodeServer(options);
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
      previewHeaders: await opencodeAuthHeaders(sandbox),
      raw: { baseUrl, port: SANDBOX_OPENCODE_PORT },
    };
  }

  const pending = localOpenCodeServers.get(options);
  if (!pending) throw new Error("Local OpenCode server has not been set up by this Agent instance");
  const server = await pending;
  return { baseUrl: server.baseUrl, previewHeaders: server.headers, raw: { baseUrl: server.baseUrl } };
}

export class OpenCodeAgentAdapter implements AgentProviderAdapter<"open-code"> {
  async setup(request: AgentSetupRequest<"open-code">): Promise<void> {
    await setupOpenCode(request);
  }

  async killServer(request: AgentSetupRequest<"open-code">): Promise<void> {
    await killOpenCodeServer(request);
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

    // Tracks how much text was streamed via SSE `message.part.delta`
    // events in this run. Retained as a fallback for the cancel path
    // (a cancel may pre-empt the terminal `message.updated`); the
    // success path emits `message.completed` per assistant message
    // instead, so the host's REPLACE-on-`message.completed` logic
    // surfaces only the LAST message as `result.text`.
    let streamedTextFromSse = "";
    // Per-assistant-message text buffers, keyed by `properties.messageID`
    // from `message.part.delta`. Flushed as `message.completed` events
    // when the matching `message.updated` arrives with `info.time.completed`,
    // and again on `session.idle` for any unflushed assistant messages.
    const assistantTextByMessageId = new Map<string, string>();
    const announcedAssistantCompletions = new Set<string>();
    // partID -> part.type, populated from `message.part.updated` events.
    // Used to discriminate text vs. reasoning deltas: opencode streams
    // both via `message.part.delta { field: "text" }` (because both
    // TextPart and ReasoningPart store content in a `text` field on the
    // part schema), and only the part's `type` distinguishes them.
    // Without this lookup, reasoning deltas would be accumulated into
    // `assistantTextByMessageId` and surface as part of `result.text`.
    const partTypeById = new Map<string, string>();
    // Cost/tokens for the run. Captured on each `message.updated`
    // SSE event for our session's assistant messages (see SSE handler
    // below) and surfaced via `sink.complete` at run end. The
    // `extractOpenCodeCostData` fallback over `rawPayloads` covers the
    // step-finish part shape if it's the only carrier.
    let dispatchError: unknown;
    let firstSseEventLogged = false;

    // The session POST endpoint is only known once the remote OpenCode server
    // is up and we've created (or resumed) a session. We install `onMessage`
    // synchronously here so that callers can call `run.sendMessage(...)` as
    // soon as they have a handle on the run, even if startup takes a while.
    // Incoming messages are buffered and flushed once `sendToSession` is
    // wired up below.
    let sendToSession: ((parts: OpenCodePromptPart[]) => void) | undefined;
    const queuedParts: OpenCodePromptPart[][] = [];

    sink.onMessage(async (content: UserContent) => {
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
        if (!dispatchError) {
          dispatchError = error;
        }
        // Bail the wait loop so the run unwinds with the dispatch error.
        resolveSessionTerminal();
        throw error;
      }
    });

    // No setup → execute data channel: rebuild the runtime from
    // deterministic constants (preview link for sandbox, fixed
    // the owned loopback port for local). The opencode server
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
    // Populated once the opencode session exists (either freshly created
    // or resumed). The abort handler closes over this ref and reads the
    // current value at call time.
    let capturedSessionId: string | undefined;
    let sessionErrorFromSse: Error | undefined;
    let sessionAbortedFromSse = false;
    // Set when SSE delivers `session.idle` for our session — opencode's
    // authoritative signal that the turn finished cleanly. Resolves
    // `sessionTerminal` and drives `sink.complete()` directly.
    let sessionIdleFromSse = false;
    let resolveSessionTerminal!: () => void;
    const sessionTerminal = new Promise<void>((resolve) => {
      resolveSessionTerminal = resolve;
    });
    // Updated on every SSE event we receive (any session, including
    // server-wide heartbeats). Used by the wait loop to detect whether
    // SSE is still alive — if events keep arriving we keep waiting for
    // a terminal signal regardless of wall-clock; if the channel goes
    // silent we eventually give up and fail the run.
    let lastSseActivityAt = Date.now();

    // Abort handler: prefer opencode's `POST /session/:id/abort` so the
    // server terminates the turn cleanly and stops billing tokens. We
    // deliberately avoid `runtime.cleanup()` here because the opencode
    // server is shared across runs (see `ensureSandboxOpenCodeServer`);
    // tearing it down would break subsequent chats. With prompt_async
    // there is no long-polling fetch to cancel — the abort propagates
    // server-side and we observe it via `session.error{MessageAborted}`
    // on the SSE stream.
    // Bounded, best-effort `POST /session/:id/abort`. Also used when the
    // background wait ceiling expires: opencode's abort cancels the session's
    // background jobs even while the session itself is idle.
    const postAbort = async (id: string): Promise<void> => {
      try {
        await Promise.race([
          fetchJson<boolean>(`${runtime.baseUrl}/session/${id}/abort`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...runtime.previewHeaders,
            },
          }),
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(new Error("opencode POST /session/abort timed out")),
              3_000,
            ),
          ),
        ]);
      } catch {
        // Best-effort.
      }
    };
    let userAbortRequested = false;
    sink.setAbort(async () => {
      userAbortRequested = true;
      const sessionIdAtAbort = capturedSessionId;
      if (sessionIdAtAbort) await postAbort(sessionIdAtAbort);
      // Bail the wait loop in case the SSE-side cancel signal is slow.
      resolveSessionTerminal();
    });

    // Background subagents: when the server runs with
    // OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS, the parent session goes idle
    // while a `task {background: true}` child runs, and opencode itself
    // re-prompts the parent with the child's result
    // (TaskTool.injectBackgroundResult), so the parent's first idle is not the
    // end of the run. The parent's `task` tool part says whether the server
    // accepted a background child (metadata.background); nothing depends on
    // the caller's env, since the shared server keeps the flags it booted with.
    const backgroundTimeoutMs = resolveBackgroundTaskTimeoutMs(
      request.options.backgroundTaskTimeoutMs,
    );
    const trackChildren = backgroundTimeoutMs !== 0;
    // Direct children of the run's session. A child counts as live from
    // registration until its status idles; foreground `task` children idle
    // before the parent does, so they never hold the run open.
    const children = new Map<
      string,
      { id: string; title: string; live: boolean; background: boolean }
    >();
    const liveChildren = (): BackgroundTask[] =>
      [...children.values()]
        .filter((child) => child.live)
        .map((child) => ({
          id: child.id,
          type: "subagent",
          description: child.title,
        }));
    // Waiting only pays once the server has accepted a background child: it
    // will re-prompt the parent with the result. A foreground child still
    // live at a parent idle is a lost frame, which reconcileChildren() clears.
    const shouldWait = () =>
      [...children.values()].some((child) => child.background) &&
      liveChildren().length > 0;
    // Set while the run stays open only for background children; dropped as
    // soon as the parent goes busy again.
    let pendingWait: BackgroundWait | undefined;
    // Time already spent waiting: the ceiling bounds the run, not each wait.
    let waitedMs = 0;
    let expiry: BackgroundWaitExpiry | "transport" | undefined;
    // The host moved on (finishBackgroundWait): latched, so a request made
    // while the parent is busy ends the wait its next idle would start.
    const finishWait = new BackgroundWaitFinish();
    sink.setFinishBackgroundWait?.(() => finishWait.request());
    let sawParentIdle = false;
    let lastTasksKey = JSON.stringify({ tasks: [], waiting: false });
    const emitTasks = (tasks: BackgroundTask[], waiting: boolean) => {
      const key = JSON.stringify({ tasks, waiting });
      if (key === lastTasksKey) return;
      lastTasksKey = key;
      sink.emitEvent(
        createNormalizedEvent(
          "background.tasks",
          { provider: request.provider, runId: request.runId },
          { tasks, waiting },
        ),
      );
    };
    const endWait = () => {
      if (!pendingWait) return;
      waitedMs += pendingWait.elapsedMs();
      pendingWait.clear();
      pendingWait = finishWait.watch(undefined);
    };
    const onChildrenChanged = () => {
      if (!pendingWait) return;
      const live = liveChildren();
      emitTasks(live, true);
      // Nothing live: opencode's injection is immediate, so the grace only
      // covers a child that ended without waking the parent.
      pendingWait.setIdle(live.length === 0);
    };
    const registerChild = (
      id: string,
      title: string | undefined,
      background = false,
    ) => {
      const known = children.get(id);
      if (known) {
        known.background ||= background;
        if (title && title !== known.title) {
          known.title = title;
          onChildrenChanged();
        }
        return;
      }
      children.set(id, { id, title: title ?? "", live: true, background });
      onChildrenChanged();
    };
    const setChildLive = (id: string, live: boolean) => {
      const child = children.get(id);
      if (!child || child.live === live) return;
      child.live = live;
      onChildrenChanged();
    };
    // Liveness is edge-triggered from SSE frames, and edges get lost: a
    // reconnect gap (opencode's frames carry no id to replay from) or a child
    // whose runner never started. The server's status map lists only non-idle
    // sessions, so an absent child is done. Bounded and best effort: on
    // failure the edges stand.
    const reconcileChildren = async () => {
      const live = [...children.values()].filter((child) => child.live);
      if (live.length === 0) return;
      const statuses = await withTimeout(
        fetchJson<Record<string, { type?: string } | undefined>>(
          `${runtime.baseUrl}/session/status`,
          { headers: runtime.previewHeaders },
        ).catch(() => undefined),
        3_000,
      );
      if (!statuses || typeof statuses !== "object") return;
      for (const child of live) {
        const status = statuses[child.id];
        if (!status || status.type === "idle") setChildLive(child.id, false);
      }
    };
    const onParentIdle = async () => {
      sawParentIdle = true;
      // `session.idle` and `session.status{idle}` both fire for one idle:
      // keep the wait already running rather than re-arming it.
      if (pendingWait || sessionIdleFromSse) return;
      const tracking = trackChildren && !userAbortRequested;
      if (tracking && shouldWait()) await reconcileChildren();
      if (!tracking || !shouldWait()) {
        sessionIdleFromSse = true;
        resolveSessionTerminal();
        return;
      }
      const live = liveChildren();
      debugOpencode(
        "★ parent idle with %d live subagent(s); waiting",
        live.length,
      );
      const wait = new BackgroundWait(
        BACKGROUND_TASK_GRACE_MS,
        Math.max(0, backgroundTimeoutMs - waitedMs),
      );
      pendingWait = wait;
      void wait.expired.then((reason) => {
        // A wait the parent has since resumed from must never settle the run.
        if (pendingWait !== wait) return;
        expiry = reason;
        resolveSessionTerminal();
      });
      finishWait.watch(wait);
      emitTasks(live, true);
    };
    // opencode re-ran the parent (the child's result was injected): the run
    // is a normal turn again until the next idle.
    const onParentBusy = () => {
      if (!pendingWait) return;
      debugOpencode(
        "★ parent resumed after %dms of background wait",
        pendingWait.elapsedMs(),
      );
      endWait();
      emitTasks(liveChildren(), false);
    };
    // The injected result is the child's end and the parent's wake-up in
    // one: opencode prompts the parent with it right away.
    const onInjectedResult = (childId: string) => {
      if (!children.has(childId)) return;
      setChildLive(childId, false);
      onParentBusy();
    };

    try {
      const interactiveApproval = !request.options.fullAccess && isInteractiveApproval(request.options);
      // Three branches around session resolution:
      // 1. resumeSessionId — reuse the session id directly, no HTTP call.
      // 2. forkSessionId   — POST /session/:id/fork { messageID } to slice
      //    the source session up to the chosen message and continue under
      //    a new session id.
      // 3. neither         — POST /session to create a fresh session.
      let forkedSession: { id?: string; sessionId?: string } | null = null;
      if (request.run.forkSessionId) {
        forkedSession = await fetchJson<{ id?: string; sessionId?: string }>(
          `${runtime.baseUrl}/session/${encodeURIComponent(request.run.forkSessionId)}/fork`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...runtime.previewHeaders,
            },
            body: JSON.stringify({
              messageID: request.run.forkAtMessageId,
            }),
          },
        );
      }
      const createdSession =
        request.run.resumeSessionId || forkedSession
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
        forkedSession?.id ??
        forkedSession?.sessionId ??
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
      // Sessions belonging to THIS run: the main session plus every child
      // session spawned under it (sub-agents via the `task` tool, nested
      // arbitrarily). Grown from `session.created` events whose parent is
      // already in the set. The `/event` stream is server-wide, so
      // permission asks from unrelated concurrent runs must never be
      // answered by this listener — only asks within this tree are.
      const runSessionIds = new Set<string>([sessionId]);
      // Fallback for asks from sessions whose `session.created` frame this
      // listener missed (e.g. across an SSE reconnect): resolve the asking
      // session's ancestry once via `GET /session` and cache the lineage.
      // Any failure means "not ours" — same as the pre-existing behavior of
      // ignoring unknown sessions.
      const resolveRunSession = async (candidate: string): Promise<boolean> => {
        if (runSessionIds.has(candidate)) return true;
        try {
          const sessions = await fetchJson<
            Array<{ id?: string; parentID?: string }>
          >(`${runtime.baseUrl}/session`, {
            headers: runtime.previewHeaders,
          });
          if (!Array.isArray(sessions)) return false;
          const parentById = new Map<string, string>();
          for (const session of sessions) {
            if (
              typeof session?.id === "string" &&
              typeof session?.parentID === "string"
            ) {
              parentById.set(session.id, session.parentID);
            }
          }
          const lineage: string[] = [];
          let cursor: string | undefined = candidate;
          while (cursor && !runSessionIds.has(cursor) && lineage.length < 16) {
            lineage.push(cursor);
            cursor = parentById.get(cursor);
          }
          if (!cursor || !runSessionIds.has(cursor)) return false;
          for (const id of lineage) runSessionIds.add(id);
          return true;
        } catch {
          return false;
        }
      };
      sseTask = (async () => {
        try {
          for await (const event of streamSseResilient(
            `${runtime.baseUrl}/event`,
            {
              headers: runtime.previewHeaders,
              signal: sseAbort.signal,
            },
          )) {
            lastSseActivityAt = Date.now();
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

            // Track child sessions spawned under this run (the `task` tool
            // creates one per sub-agent) so permission handling below can
            // tell this run's sessions apart from unrelated concurrent runs
            // sharing the server-wide event bus.
            if (
              eventType === "session.created" ||
              eventType === "session.updated"
            ) {
              const properties = (payload as Record<string, unknown>)
                .properties as Record<string, unknown> | undefined;
              const info = properties?.info as
                | Record<string, unknown>
                | undefined;
              if (
                info &&
                typeof info.id === "string" &&
                typeof info.parentID === "string" &&
                runSessionIds.has(info.parentID)
              ) {
                runSessionIds.add(info.id);
                if (trackChildren && info.parentID === sessionId) {
                  registerChild(
                    info.id,
                    typeof info.title === "string" ? info.title : undefined,
                  );
                }
              }
            }

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
                } else if (
                  info.role === "assistant" &&
                  !announcedAssistantCompletions.has(info.id)
                ) {
                  const time = info.time as Record<string, unknown> | undefined;
                  if (typeof time?.completed === "number") {
                    announcedAssistantCompletions.add(info.id);
                    sink.emitEvent(
                      createNormalizedEvent(
                        "message.completed",
                        {
                          provider: request.provider,
                          runId: request.runId,
                          raw,
                        },
                        { text: assistantTextByMessageId.get(info.id) ?? "" },
                      ),
                    );
                  }
                }
              }
            }
            if (eventType === "question.asked") {
              const properties = (payload as Record<string, unknown>).properties as Record<string, unknown> | undefined;
              if (properties && typeof properties.id === "string" && typeof properties.sessionID === "string" && await resolveRunSession(properties.sessionID)) {
                const questions = normalizeUserQuestions("open-code", properties);
                const response = hasInteractiveQuestions(request.options)
                  ? await sink.requestPermission(createNormalizedEvent("permission.requested", {
                      provider: request.provider, runId: request.runId, raw,
                    }, {
                      requestId: properties.id, kind: "question", toolName: "question",
                      title: "Your input is needed", input: properties, questions, canRemember: false,
                    }) as PermissionRequestedEvent)
                  : undefined;
                const allowed = response?.decision === "allow";
                await fetchJson<boolean>(`${runtime.baseUrl}/question/${encodeURIComponent(properties.id)}/${allowed ? "reply" : "reject"}`, {
                  method: "POST",
                  headers: { "content-type": "application/json", ...runtime.previewHeaders },
                  body: JSON.stringify(allowed ? { answers: questionReply("open-code", properties, response.answers ?? []) } : {}),
                });
              }
              continue;
            }

            if (eventType === "permission.asked") {
              const properties = (payload as Record<string, unknown>)
                .properties as Record<string, unknown> | undefined;
              // Answer asks from any session in THIS run's session tree, not
              // just the main one: sub-agents spawned via the `task` tool run
              // in child sessions and (since opencode 1.17.2) raise their own
              // permission events under the child sessionID. Dropping those
              // blocks the sub-agent's tool call forever — the run then hangs
              // emitting nothing but heartbeats. Sessions outside the tree
              // belong to other runs on the shared server-wide event bus and
              // are left to their own listeners. The reply must go to the
              // ASKING session's endpoint; opencode resolves permissions per
              // session.
              if (
                properties &&
                typeof properties.sessionID === "string" &&
                (await resolveRunSession(properties.sessionID))
              ) {
                const askingSessionId = properties.sessionID;
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
                  `${runtime.baseUrl}/session/${askingSessionId}/permissions/${permissionEvent.requestId}`,
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
            // OpenCode signals end-of-turn via `session.idle` (and the
            // modern `session.status{type:"idle"}`) on the SSE bus.
            // This is the authoritative completion signal — the SDK
            // dispatches via `POST /prompt_async` (fire-and-forget,
            // 204), so SSE is the only channel telling us a turn is
            // done.
            if (
              payloadRecord?.type === "session.idle" ||
              payloadRecord?.type === "session.error"
            ) {
              const properties = payloadRecord.properties as
                | Record<string, unknown>
                | undefined;
              const eventSessionId =
                typeof properties?.sessionID === "string"
                  ? properties.sessionID
                  : undefined;
              if (!eventSessionId || eventSessionId === sessionId) {
                if (payloadRecord.type === "session.error") {
                  const errData = properties?.error as
                    | Record<string, unknown>
                    | undefined;
                  if (errData?.name === "MessageAbortedError") {
                    // opencode reports user-initiated (or server-side)
                    // message abort as MessageAbortedError — treat as cancel.
                    sessionAbortedFromSse = true;
                  } else {
                    const errMsg =
                      typeof (errData?.data as Record<string, unknown>)
                        ?.message === "string"
                        ? ((errData!.data as Record<string, unknown>)
                            .message as string)
                        : typeof errData?.message === "string"
                          ? (errData.message as string)
                          : "OpenCode session error";
                    sessionErrorFromSse = new Error(errMsg);
                  }
                  resolveSessionTerminal();
                } else {
                  await onParentIdle();
                }
                debugOpencode(
                  "★ %s for session=%s",
                  payloadRecord.type,
                  sessionId,
                );
              } else if (trackChildren && payloadRecord.type === "session.idle") {
                setChildLive(eventSessionId, false);
              }
            }
            // Modern terminal signal: `session.status` with type idle.
            // Fires alongside the deprecated `session.idle`; we accept
            // either.
            if (payloadRecord?.type === "session.status") {
              const properties = payloadRecord.properties as
                | Record<string, unknown>
                | undefined;
              const status = properties?.status as
                | Record<string, unknown>
                | undefined;
              const eventSessionId =
                typeof properties?.sessionID === "string"
                  ? properties.sessionID
                  : undefined;
              if (!eventSessionId || eventSessionId === sessionId) {
                if (status?.type === "idle") {
                  debugOpencode(
                    "★ session.status{idle} for session=%s",
                    sessionId,
                  );
                  await onParentIdle();
                } else if (status?.type === "busy" || status?.type === "retry") {
                  onParentBusy();
                }
              } else if (trackChildren) {
                setChildLive(eventSessionId, status?.type !== "idle");
              }
            }

            if (payloadRecord?.type === "message.part.updated") {
              // Capture partID -> part.type so the delta branch can
              // discriminate text vs. reasoning. Opencode streams both
              // via `message.part.delta { field: "text" }` (because
              // TextPart and ReasoningPart both store content in a
              // `text` field on the part schema), and the part type is
              // the only discriminator. `message.part.updated` is
              // emitted alongside the first `message.part.delta` for a
              // given part (Session.updatePart writes the snapshot and
              // then publishes deltas), so the type is known by the
              // time deltas arrive.
              const properties = payloadRecord.properties as
                | Record<string, unknown>
                | undefined;
              const part = properties?.part as
                | Record<string, unknown>
                | undefined;
              if (
                part &&
                typeof part.id === "string" &&
                typeof part.type === "string"
              ) {
                partTypeById.set(part.id, part.type);
              }
              // The parent's `task {background: true}` call names the child
              // session in its tool metadata; register it in case the
              // child's own `session.created` frame was missed.
              if (
                trackChildren &&
                part?.type === "tool" &&
                part.tool === "task" &&
                part.sessionID === sessionId
              ) {
                const state = part.state as Record<string, unknown> | undefined;
                const metadata = state?.metadata as
                  | Record<string, unknown>
                  | undefined;
                const childId = metadata?.sessionId ?? metadata?.jobId;
                if (metadata?.background === true && typeof childId === "string") {
                  registerChild(
                    childId,
                    typeof state?.title === "string" ? state.title : undefined,
                    true,
                  );
                }
              }
              // A background child's result reaches the parent as a synthetic
              // user text part.
              if (
                trackChildren &&
                part?.type === "text" &&
                part.synthetic === true &&
                part.sessionID === sessionId &&
                typeof part.text === "string"
              ) {
                const childId = injectedTaskResultChild(part.text);
                if (childId) onInjectedResult(childId);
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
              const eventPartId =
                typeof properties?.partID === "string"
                  ? properties.partID
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
              // User parts never stream deltas, but a background subagent's
              // result reaches the parent as a synthetic user message: nothing
              // attributed to a user message may become the run text.
              if (
                eventMessageId !== undefined &&
                announcedUserMessageIds.has(eventMessageId)
              ) {
                continue;
              }
              const delta =
                typeof properties?.delta === "string" ? properties.delta : "";
              const field =
                typeof properties?.field === "string"
                  ? properties.field
                  : undefined;
              // Opencode emits `field: "text"` deltas for both TextPart
              // (the model's answer) and ReasoningPart (the model's
              // chain-of-thought). The part type — looked up by
              // `partID` — is what distinguishes them; treating all
              // `field: "text"` deltas as answer text concatenates
              // reasoning into `assistantTextByMessageId`, which then
              // surfaces as part of `result.text` / `finalAnswer`.
              const partType = eventPartId
                ? partTypeById.get(eventPartId)
                : undefined;
              const isTextDelta = field === "text" && partType !== "reasoning";
              const isReasoningDelta =
                (field === "text" && partType === "reasoning") ||
                field === "reasoning_content" ||
                field === "reasoning_details";
              if (delta && isTextDelta) {
                streamedTextFromSse += delta;
                if (eventMessageId) {
                  assistantTextByMessageId.set(
                    eventMessageId,
                    (assistantTextByMessageId.get(eventMessageId) ?? "") +
                      delta,
                  );
                }
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
              } else if (delta && isReasoningDelta) {
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

      // Fire-and-forget dispatch via opencode's async prompt endpoint.
      // The server enqueues the turn and returns 204 immediately —
      // results flow exclusively through the SSE event stream we're
      // already consuming. One retry on transport failure; if both
      // attempts fail we surface the error and the run unwinds.
      //
      // This replaces the old `POST /session/:id/message` long-polling
      // call, which held the HTTP connection open for the entire
      // turn. That design was the unique source of `fetch failed`
      // errors when sandbox networks dropped multi-minute connections;
      // prompt_async eliminates that whole class of failure.
      if (request.run.goal) throw new Error("Native goals are not supported by OpenCode.");
      if (request.run.mode) {
        const agents = await fetchJson<Array<{ name: string; mode?: string }>>(`${runtime.baseUrl}/agent`, { headers: runtime.previewHeaders });
        const name = request.run.mode === "plan" ? "plan" : "build";
        if (!agents.some((agent) => agent.name === name)) throw new Error(`This OpenCode installation does not expose the ${name} agent.`);
      }
      // The server never parses slash commands: its configured commands and
      // skills are listed here for the host's `/` menu and to route a
      // leading `/name` to the matching endpoint below.
      const harnessCommands = await listOpenCodeHarnessCommands(runtime);
      sink.emitEvent(
        createNormalizedEvent(
          "harness.commands",
          { provider: request.provider, runId: request.runId },
          { commands: harnessCommands },
        ),
      );
      const commandDispatch = resolveOpenCodeCommandDispatch(request.run.command, harnessCommands);
      // The native command endpoint does not accept a system override. Do
      // not silently execute a command without the caller's instructions.
      if (commandDispatch.kind === "command" && request.run.systemPrompt) {
        throw new Error(
          "OpenCode commands do not support a per-run systemPrompt. Use a normal prompt, or configure the systemPrompt on the Agent at setup time.",
        );
      }
      // Unlike `prompt_async`, the command and summarize endpoints answer
      // only once the turn ends. The request is not awaited: the turn is
      // observed through SSE like any other, and a failed request (an
      // unknown command answers 4xx at once) fails the run promptly.
      const dispatchBlocking = (endpoint: string, body: Record<string, unknown>): void => {
        void fetch(`${runtime.baseUrl}/session/${sessionId}/${endpoint}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...runtime.previewHeaders },
          body: JSON.stringify(body),
        })
          .then((response) => {
            if (!response.ok) throw new Error(`POST /session/${sessionId}/${endpoint} returned ${response.status}`);
          })
          .catch((error: unknown) => {
            if (!dispatchError) dispatchError = error;
            resolveSessionTerminal();
          });
      };
      const dispatchPrompt = async (
        parts: OpenCodePromptPart[],
      ): Promise<void> => {
        const body = JSON.stringify({
          ...(request.run.model
            ? { model: toOpenCodeModel(request.run.model) }
            : {}),
          // Per-message system prompt override. opencode appends this
          // *after* `agent.prompt` and the runtime appendix
          // (env/AGENTS.md/skills) when composing the final system
          // string — see `buildOpenCodeConfig` for the full ordering.
          // For Anthropic models specifically, this trailing-position
          // content tends to be ignored; callers that need the prompt
          // to actually steer Sonnet/Opus should pass it via
          // `OpenCodeAgentOptions.systemPrompt` so it's baked into
          // `agent.prompt` (the leading position) at setup time
          // instead. This per-message field stays as a per-run
          // override path that's effective for codex/GPT/Gemini.
          ...(request.run.systemPrompt
            ? { system: request.run.systemPrompt }
            : {}),
          ...(request.options.configuration === "native"
            ? (request.run.reasoning ? { variant: request.run.reasoning } : {})
            : { agent: agentSlug }),
          ...(request.run.mode ? { agent: request.run.mode === "plan" ? "plan" : "build" } : {}),
          parts,
        });
        const url = `${runtime.baseUrl}/session/${sessionId}/prompt_async`;

        const attempt = async (): Promise<Response> => {
          return fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...runtime.previewHeaders,
            },
            body,
          });
        };

        let lastError: unknown;
        for (let i = 0; i < 2; i++) {
          try {
            const response = await attempt();
            if (response.ok || response.status === 204) {
              return;
            }
            lastError = new Error(`POST ${url} returned ${response.status}`);
          } catch (error) {
            lastError = error;
          }
          if (i === 0) {
            debugOpencode(
              "prompt_async dispatch attempt %d failed (%s); retrying once",
              i + 1,
              (lastError as Error)?.message ?? String(lastError),
            );
            await sleep(500);
          }
        }
        throw lastError instanceof Error
          ? lastError
          : new Error(String(lastError));
      };

      // OpenCode queues concurrent prompts on the same session, so
      // mid-run injections via `run.sendMessage(...)` reuse the same
      // endpoint as the initial turn.
      sendToSession = (parts) => {
        void (async () => {
          try {
            await dispatchPrompt(parts);
          } catch (error) {
            if (!dispatchError) {
              dispatchError = error;
            }
            // Bail the wait loop so the run fails promptly.
            resolveSessionTerminal();
          }
        })();
      };

      // Flush any messages that arrived via `run.sendMessage(...)` before the
      // session was ready. They become additional queued turns alongside the
      // initial input.
      for (const queued of queuedParts.splice(0)) {
        sendToSession(queued);
      }

      // Initial dispatch. We await this one because if it fails we
      // want to surface the error before entering the wait loop.
      try {
        if (commandDispatch.kind === "summarize") {
          const model = toOpenCodeModel(request.run.model);
          if (!model?.providerID) throw new Error("OpenCode compaction needs a provider-qualified model id.");
          dispatchBlocking("summarize", { providerID: model.providerID, modelID: model.modelID });
        } else if (commandDispatch.kind === "command") {
          dispatchBlocking("command", {
            command: commandDispatch.command,
            arguments: commandDispatch.arguments,
            parts: mapToOpenCodeParts(inputParts).filter((part) => part.type === "file"),
            ...(request.run.model?.includes("/") ? { model: request.run.model } : {}),
            ...(request.run.mode ? { agent: request.run.mode === "plan" ? "plan" : "build" } : request.options.configuration === "native" ? {} : { agent: agentSlug }),
          });
        } else {
          const parts = mapToOpenCodeParts(inputParts);
          await dispatchPrompt(
            commandDispatch.text === undefined ? parts : replaceOpenCodePromptText(parts, commandDispatch.text),
          );
        }
      } catch (error) {
        if (!dispatchError) {
          dispatchError = error;
        }
        resolveSessionTerminal();
      }

      // Wait for the SSE-driven terminal signal. As long as SSE keeps
      // producing events (deltas, heartbeats, anything) we keep
      // waiting; if the channel goes silent for the threshold window
      // we give up and fail the run. The consumer (e.g. Twill) is
      // responsible for resuming via `resumeSessionId` if needed —
      // the SDK does not attempt to recover lost state on its own.
      const SSE_SILENCE_THRESHOLD_MS = 180_000; // 3 min of no events = dead
      const SSE_POLL_INTERVAL_MS = 5_000;
      lastSseActivityAt = Date.now();
      let sseSilent = false;
      while (
        !sessionIdleFromSse &&
        !sessionErrorFromSse &&
        !sessionAbortedFromSse &&
        !userAbortRequested &&
        !dispatchError &&
        !expiry
      ) {
        const silence = Date.now() - lastSseActivityAt;
        if (silence > SSE_SILENCE_THRESHOLD_MS) {
          // opencode heartbeats every 10s, so this is a dead server, not a
          // quiet subagent. While only background work keeps the run open,
          // settle on the answer the parent already gave instead of failing.
          if (pendingWait && sawParentIdle) {
            debugOpencode(
              "SSE went silent (%dms) during background wait; settling",
              silence,
            );
            expiry = "transport";
            break;
          }
          sseSilent = true;
          debugOpencode("SSE went silent (%dms) — giving up", silence);
          break;
        }
        // A child's end this listener never saw must not hold the run open
        // until the ceiling.
        if (pendingWait && liveChildren().length > 0) await reconcileChildren();
        await Promise.race([
          sessionTerminal,
          new Promise<void>((resolve) =>
            setTimeout(resolve, SSE_POLL_INTERVAL_MS),
          ),
        ]);
      }

      sseAbort.abort();
      await sseTask;

      // Nothing listens to this session once the run settles, so a child
      // finishing later would only start an unobserved parent turn: stop what
      // is left (best effort). The abort handler already did on cancel.
      if (
        expiry === "ceiling" ||
        expiry === "finished" ||
        ((sessionErrorFromSse || dispatchError) && liveChildren().length > 0)
      ) {
        debugOpencode(
          "★ run over (%s) with %d subagent(s) live; aborting them",
          expiry ?? "failure",
          liveChildren().length,
        );
        await postAbort(sessionId);
      }
      // However the run ended, nothing is pending once it settles (a no-op
      // unless a background set was reported).
      endWait();
      emitTasks([], false);

      if (userAbortRequested || sessionAbortedFromSse) {
        debugOpencode(
          "★ run.cancelled (%dms since execute start)",
          Date.now() - executeStartedAt,
        );
        sink.cancel({
          text: streamedTextFromSse || undefined,
          costData: extractOpenCodeCostData(rawPayloads),
        });
      } else if (sessionErrorFromSse) {
        sink.fail(sessionErrorFromSse);
      } else if (dispatchError) {
        sink.fail(dispatchError);
      } else if (sessionIdleFromSse || expiry) {
        debugOpencode(
          "★ run.completed (%dms since execute start) chars=%d",
          Date.now() - executeStartedAt,
          streamedTextFromSse.length,
        );
        // Flush any assistant message buffers that didn't receive a
        // terminal `message.updated{info.time.completed}` before
        // `session.idle`. Map iteration order is insertion order, so
        // the LAST emitted `message.completed` is the most recent
        // assistant message — exactly the REPLACE target the host
        // uses to settle `result.text`.
        let lastAssistantText = "";
        for (const [messageId, text] of assistantTextByMessageId) {
          lastAssistantText = text;
          if (!announcedAssistantCompletions.has(messageId)) {
            announcedAssistantCompletions.add(messageId);
            sink.emitEvent(
              createNormalizedEvent(
                "message.completed",
                {
                  provider: request.provider,
                  runId: request.runId,
                },
                { text },
              ),
            );
          }
        }
        sink.emitEvent(
          createNormalizedEvent(
            "run.completed",
            {
              provider: request.provider,
              runId: request.runId,
            },
            { text: lastAssistantText },
          ),
        );
        sink.complete({
          text: lastAssistantText,
          costData: extractOpenCodeCostData(rawPayloads),
        });
      } else if (sseSilent) {
        sink.fail(
          new Error("opencode SSE went silent before the session reached idle"),
        );
      } else {
        sink.fail(new Error("opencode run ended without a terminal signal"));
      }
    } finally {
      endWait();
      sseAbort.abort();
      if (sseTask) {
        await sseTask.catch(() => undefined);
      }
      // No runtime cleanup: the opencode server is shared across runs
      // (started by setup() once). Per-run state (SSE task) is torn
      // down via the abort controller above.
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
    const authHeaders = await opencodeAuthHeaders(request.sandbox);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      await fetch(`${baseUrl}/session/${request.sessionId}/abort`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...authHeaders,
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
   * Stateless message injection. Fire-and-forget POST to
   * `/session/:id/prompt_async` (returns 204) — opencode appends the
   * message to the running session and the originating instance picks
   * up the new turn through its existing SSE stream.
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
    const authHeaders = await opencodeAuthHeaders(request.sandbox);
    const url = `${baseUrl}/session/${request.sessionId}/prompt_async`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({
        agent: openCodeAgentSlug(undefined),
        parts,
      }),
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(`POST ${url} returned ${response.status}`);
    }
  }
}
