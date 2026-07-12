import { createHash } from "node:crypto";
import path from "node:path";

import {
  createNormalizedEvent,
  normalizeRawAgentEvent,
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
import { isInteractiveApproval } from "../approval";
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
import { spawnCommand, waitForHttpReady } from "../transports/spawn";
import { sleep, waitFor } from "../../shared/network";
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
const LOCAL_OPENCODE_PORT = 4096;
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

/**
 * Stop a local `opencode serve` listening on {@link LOCAL_OPENCODE_PORT}
 * and wait until the port is actually released, so the cold path that
 * follows binds a fresh server (and its readiness probe can't get a false
 * positive from the lingering old process).
 *
 * Best-effort + unix-only: kills by port via `lsof`. Local opencode mode
 * already relies on unix-only spawn behaviour elsewhere, so this is an
 * acceptable platform constraint.
 */
async function killLocalOpenCodeServer(): Promise<void> {
  await time(debugOpencode, "kill local opencode server", async () => {
    const killer = spawnCommand({
      command: "sh",
      args: [
        "-c",
        `lsof -ti tcp:${LOCAL_OPENCODE_PORT} | xargs kill 2>/dev/null || true`,
      ],
    });
    await killer.wait().catch(() => undefined);
    // Wait for the health endpoint to stop responding — the port is then
    // free for the fresh spawn below.
    await waitFor(
      async () => {
        try {
          const res = await fetch(
            `http://127.0.0.1:${LOCAL_OPENCODE_PORT}/global/health`,
          );
          return !res.ok;
        } catch {
          return true;
        }
      },
      { timeoutMs: 5_000, intervalMs: 200 },
    ).catch(() => undefined);
  });
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
    const interactiveApproval = isInteractiveApproval(options);

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

/**
 * Host-side preparation for opencode (local mode). Idempotent:
 *
 *   1. Compute the setupId over the artifact set, daemon expectation,
 *      and an `options.env` fingerprint, then `preflightSetup`: if the
 *      `setup.id` marker matches AND the server answers
 *      `127.0.0.1:LOCAL_OPENCODE_PORT/global/health`, reuse it.
 *   2. Drift/cold path: stop any stale server still on the port (its env
 *      or config no longer matches), re-apply the on-disk config, spawn a
 *      fresh `opencode serve`, wait for ready.
 *
 * The spawned process is left running across runs — `execute` doesn't
 * own its lifecycle, the process is the property of the host that
 * invoked `setup()`. A drifting `setup()` (changed credentials/config)
 * restarts the shared server so the new settings take effect.
 */
async function ensureLocalOpenCodeServer(
  request: AgentSetupRequest<"open-code">,
): Promise<void> {
  const options = request.options;

  const plugins = assertHooksSupported(request.provider, options);
  assertCommandsSupported(request.provider, options.commands);
  const interactiveApproval = isInteractiveApproval(options);

  const target = await createSetupTarget(
    request.provider,
    "shared-setup",
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

  const configPath = path.join(target.layout.opencodeDir, "agentbox.json");
  const openCodeConfig = buildOpenCodeConfig(options, interactiveApproval);
  const commonEnv = {
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_DIR: target.layout.opencodeDir,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  };

  const allArtifacts = [
    ...skillArtifacts,
    ...pluginArtifacts,
    {
      path: configPath,
      content: JSON.stringify(openCodeConfig, null, 2),
    },
  ];
  // The setupId encodes the artifact set AND a fingerprint of the LLM
  // provider API keys in `options.env`; the daemon probe adds liveness. A
  // reuse therefore requires both that nothing drifted and that the server
  // is up — and the marker lives on disk under the shared target, so a fresh
  // process / new Agent carrying a different OPENROUTER_API_KEY sees the
  // mismatch.
  const daemonInfo = {
    port: LOCAL_OPENCODE_PORT,
    healthPath: "/global/health",
  };
  const setupId = computeSetupId({
    artifacts: allArtifacts,
    installCommands,
    daemon: daemonInfo,
    extras: [`apiKeys:${hashLlmApiKeys(options.env)}`],
  });
  if (await preflightSetup(target, setupId, daemonInfo)) {
    debugOpencode("local opencode server up-to-date — reusing");
    return;
  }

  // Preflight missed: either no server is up, or one IS up but the desired
  // config/credentials drifted. We never auto-kill a running server to apply
  // that drift (it is shared across runs on a static port); restarts are the
  // developer's explicit call via `agent.killServer()`. Reuse a healthy
  // server untouched — the staged config takes effect on the next cold start.
  if (await isLocalOpenCodeServerHealthy()) {
    debugOpencode(
      "local opencode server already running but setup drifted — reusing it " +
        "without restart; call agent.killServer() to apply the new config",
    );
    return;
  }
  debugOpencode("local opencode server absent — spawning");

  await applyDifferentialSetup(target, allArtifacts, installCommands);

  // No healthy server is up (the health check above returned early when one
  // was), so this is a genuine cold start. Reap any stale/dead process still
  // bound to the port so the spawn below binds fresh and its readiness probe
  // can't get a false positive from a dying one. No-op when nothing is there.
  await killLocalOpenCodeServer();

  spawnCommand({
    command: options.provider?.binary ?? "opencode",
    args: [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(LOCAL_OPENCODE_PORT),
      ...(options.provider?.args ?? []),
    ],
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      ...commonEnv,
    },
  });

  await waitForHttpReady(
    `http://127.0.0.1:${LOCAL_OPENCODE_PORT}/global/health`,
    { timeoutMs: LOCAL_OPENCODE_READY_TIMEOUT_MS },
  );

  await markSetupComplete(target, setupId);
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

/** Host-side counterpart of {@link isSandboxOpenCodeServerHealthy}. */
async function isLocalOpenCodeServerHealthy(): Promise<boolean> {
  try {
    const res = await fetch(
      `http://127.0.0.1:${LOCAL_OPENCODE_PORT}/global/health`,
    );
    return res.ok;
  } catch {
    return false;
  }
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
  await killLocalOpenCodeServer();
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

  const baseUrl = `http://127.0.0.1:${LOCAL_OPENCODE_PORT}`;
  return {
    baseUrl,
    previewHeaders: {},
    raw: { baseUrl, port: LOCAL_OPENCODE_PORT },
  };
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
    // 127.0.0.1:LOCAL_OPENCODE_PORT for local). The opencode server
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
    let userAbortRequested = false;
    sink.setAbort(async () => {
      userAbortRequested = true;
      const sessionIdAtAbort = capturedSessionId;
      if (sessionIdAtAbort) {
        try {
          await Promise.race([
            fetchJson<boolean>(
              `${runtime.baseUrl}/session/${sessionIdAtAbort}/abort`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...runtime.previewHeaders,
                },
              },
            ),
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
      }
      // Bail the wait loop in case the SSE-side cancel signal is slow.
      resolveSessionTerminal();
    });

    try {
      const interactiveApproval = isInteractiveApproval(request.options);
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
            if (eventType === "permission.asked") {
              const properties = (payload as Record<string, unknown>)
                .properties as Record<string, unknown> | undefined;
              // Answer asks from ANY session on this server, not just the
              // main one: sub-agents spawned via the `task` tool run in
              // child sessions and (since opencode 1.17.2) raise their own
              // permission events under the child sessionID. Dropping those
              // blocks the sub-agent's tool call forever — the run then
              // hangs emitting nothing but heartbeats. Every session on the
              // server belongs to this run, so replying is always safe. The
              // reply must go to the ASKING session's endpoint; opencode
              // resolves permissions per session.
              if (properties && typeof properties.sessionID === "string") {
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
                } else {
                  sessionIdleFromSse = true;
                }
                debugOpencode(
                  "★ %s for session=%s",
                  payloadRecord.type,
                  sessionId,
                );
                resolveSessionTerminal();
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
              if (
                (!eventSessionId || eventSessionId === sessionId) &&
                status?.type === "idle"
              ) {
                sessionIdleFromSse = true;
                debugOpencode(
                  "★ session.status{idle} for session=%s",
                  sessionId,
                );
                resolveSessionTerminal();
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
          agent: agentSlug,
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
        await dispatchPrompt(mapToOpenCodeParts(inputParts));
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
        !dispatchError
      ) {
        const silence = Date.now() - lastSseActivityAt;
        if (silence > SSE_SILENCE_THRESHOLD_MS) {
          sseSilent = true;
          debugOpencode("SSE went silent (%dms) — giving up", silence);
          break;
        }
        await Promise.race([
          sessionTerminal,
          new Promise<void>((resolve) =>
            setTimeout(resolve, SSE_POLL_INTERVAL_MS),
          ),
        ]);
      }

      sseAbort.abort();
      await sseTask;

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
      } else if (sessionIdleFromSse) {
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
