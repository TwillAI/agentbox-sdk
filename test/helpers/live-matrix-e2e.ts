import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Agent,
  AgentProvider,
  Sandbox,
  SandboxProvider,
  type AgentProviderName,
  type SandboxProviderName,
} from "../../src";
import type { NormalizedAgentEvent } from "../../src";
import { buildSandboxImage } from "../../src/sandbox-images/build";

export type LiveMatrixSandboxProvider = Extract<
  SandboxProviderName,
  "local-docker" | "modal" | "daytona" | "e2b" | "vercel"
>;

export type LiveMatrixAgentProvider = AgentProviderName;

export type LiveMatrixCombination = {
  sandboxProvider: LiveMatrixSandboxProvider;
  agentProvider: LiveMatrixAgentProvider;
};

export type LiveMatrixSkippedCombination = LiveMatrixCombination & {
  reason: string;
};

export type LiveMatrixSessionResult = {
  sessionId: string;
  expectedText: string;
  text: string;
  streamedText: string;
  eventTypes: NormalizedAgentEvent["type"][];
};

export type LiveMatrixScenarioResult = LiveMatrixCombination & {
  image: string;
  version: string;
  sessions: LiveMatrixSessionResult[];
};

export const LIVE_MATRIX_E2E_ENABLED =
  process.env.AGENTBOX_RUN_MATRIX_E2E === "1";

export const LIVE_MATRIX_E2E_TIMEOUT_MS = Number.parseInt(
  process.env.AGENTBOX_MATRIX_E2E_TIMEOUT_MS ?? "480000",
  10,
);

export const LIVE_MATRIX_CONCURRENT_SESSION_COUNT = 2;

export const LIVE_MATRIX_SANDBOX_PROVIDERS = [
  SandboxProvider.LocalDocker,
  SandboxProvider.Modal,
  SandboxProvider.Daytona,
  SandboxProvider.E2B,
  SandboxProvider.Vercel,
] as const satisfies readonly LiveMatrixSandboxProvider[];

export const LIVE_MATRIX_AGENT_PROVIDERS = [
  AgentProvider.Codex,
  AgentProvider.OpenCode,
  AgentProvider.ClaudeCode,
] as const satisfies readonly LiveMatrixAgentProvider[];

const ROOT_ENV = loadDotEnvFile(new URL("../../.env", import.meta.url));
const HOST_HOME = os.homedir();
const HOST_AUTH_PATHS = {
  codex: path.join(HOST_HOME, ".codex"),
  claude: path.join(HOST_HOME, ".claude"),
} as const;
const OPENCODE_CONFIG_CONTENT = buildOpenCodeConfigContent();
const LOCAL_DOCKER_OPENCODE_PORT = 4096;
const LOCAL_DOCKER_CLAUDE_CODE_PORT = 43180;
const MODAL_OPENCODE_PORT = 4096;
const MODAL_CODEX_PORT = 43181;
const VERCEL_OPENCODE_PORT = 4096;
const VERCEL_CODEX_PORT = 43181;
const VERCEL_CLAUDE_CODE_PORT = 43180;
const IMAGE_BUILD_SUFFIX = randomUUID().slice(0, 8);
const imageCache = new Map<LiveMatrixSandboxProvider, Promise<string>>();

const COMMON_SANDBOX_ENV = {
  ...(ROOT_ENV.OPENAI_API_KEY
    ? { OPENAI_API_KEY: ROOT_ENV.OPENAI_API_KEY }
    : {}),
  ...(ROOT_ENV.ANTHROPIC_API_KEY
    ? { ANTHROPIC_API_KEY: ROOT_ENV.ANTHROPIC_API_KEY }
    : {}),
  ...(OPENCODE_CONFIG_CONTENT
    ? { OPENCODE_CONFIG_CONTENT: OPENCODE_CONFIG_CONTENT }
    : {}),
};

const BINARY_BY_PROVIDER: Record<LiveMatrixAgentProvider, string> = {
  codex: "codex",
  "open-code": "opencode",
  "claude-code": "claude",
};

const ALL_LIVE_MATRIX_COMBINATIONS: LiveMatrixCombination[] =
  LIVE_MATRIX_SANDBOX_PROVIDERS.flatMap((sandboxProvider) =>
    LIVE_MATRIX_AGENT_PROVIDERS.map((agentProvider) => ({
      sandboxProvider,
      agentProvider,
    })),
  );

const LIVE_MATRIX_PLAN = buildLiveMatrixPlan();

export const LIVE_MATRIX_E2E_RUNNABLE_COMBINATIONS = LIVE_MATRIX_PLAN.runnable;
export const LIVE_MATRIX_E2E_SKIPPED_COMBINATIONS = LIVE_MATRIX_PLAN.skipped;

let loggedPlan = false;

export function formatLiveMatrixLabel(
  combination: LiveMatrixCombination,
): string {
  return `${combination.sandboxProvider} x ${combination.agentProvider}`;
}

export function logLiveMatrixPlan(): void {
  if (loggedPlan) {
    return;
  }
  loggedPlan = true;

  const runnable = LIVE_MATRIX_E2E_RUNNABLE_COMBINATIONS.map(
    formatLiveMatrixLabel,
  );
  console.info(
    `[live-matrix-e2e] runnable combinations (${runnable.length}): ${
      runnable.length > 0 ? runnable.join(", ") : "none"
    }`,
  );

  for (const skipped of LIVE_MATRIX_E2E_SKIPPED_COMBINATIONS) {
    console.info(
      `[live-matrix-e2e] skip ${formatLiveMatrixLabel(skipped)}: ${skipped.reason}`,
    );
  }
}

export async function runSimpleStreamMatrixScenario(
  combination: LiveMatrixCombination,
): Promise<LiveMatrixScenarioResult> {
  const image = await resolveSandboxImage(combination.sandboxProvider);
  const sandbox = createSandboxForCombination(combination, image);

  try {
    return await runScenarioWithSandbox(combination, sandbox, image);
  } finally {
    await sandbox.delete().catch(() => undefined);
  }
}

async function runScenarioWithSandbox(
  combination: LiveMatrixCombination,
  sandbox: Sandbox<LiveMatrixSandboxProvider>,
  image: string,
): Promise<LiveMatrixScenarioResult> {
  const version = await prepareSandboxForCombination(combination, sandbox);
  const sessions = await Promise.all(
    Array.from(
      { length: LIVE_MATRIX_CONCURRENT_SESSION_COUNT },
      async (_, index) => {
        const expectedText = `matrix-ok-${combination.sandboxProvider}-${combination.agentProvider}-${index + 1}-${randomUUID()}`;
        const agent = createAgentForCombination(combination, sandbox);
        // setup() must come before stream(): it uploads artifacts and
        // boots the in-sandbox relay/app-server. Idempotent across the
        // parallel sessions sharing a sandbox.
        await agent.setup();
        const run = agent.stream({
          input: `Reply with exactly ${expectedText} and nothing else.`,
          model: getModelForCombination(combination.agentProvider),
        });
        void run.finished.catch(() => undefined);

        return {
          expectedText,
          run,
          eventTypes: [] as NormalizedAgentEvent["type"][],
          streamedText: "",
        };
      },
    ),
  );

  const abortAllRuns = async () => {
    await Promise.allSettled(sessions.map((session) => session.run.abort()));
  };

  await Promise.all(
    sessions.map((session, index) =>
      withTimeout(
        `${formatLiveMatrixLabel(combination)} session ${index + 1}`,
        () => session.run.sessionIdReady,
        Math.min(LIVE_MATRIX_E2E_TIMEOUT_MS, 120_000),
        () => session.run.abort(),
      ),
    ),
  );

  let completedSessions: LiveMatrixSessionResult[];
  try {
    completedSessions = await withTimeout(
      `${formatLiveMatrixLabel(combination)} concurrent run`,
      () =>
        Promise.all(
          sessions.map(async (session) => {
            for await (const event of session.run) {
              session.eventTypes.push(event.type);
              if (event.type === "text.delta") {
                session.streamedText += event.delta;
              }
            }
            const result = await session.run.finished;
            return {
              sessionId: result.sessionId,
              expectedText: session.expectedText,
              text: result.text.trim(),
              streamedText: session.streamedText.trim(),
              eventTypes: [...new Set(session.eventTypes)],
            };
          }),
        ),
      LIVE_MATRIX_E2E_TIMEOUT_MS,
      abortAllRuns,
    );
  } catch (error) {
    await abortAllRuns();
    throw error;
  }

  return {
    ...combination,
    image,
    version,
    sessions: completedSessions,
  };
}

function buildLiveMatrixPlan(): {
  runnable: LiveMatrixCombination[];
  skipped: LiveMatrixSkippedCombination[];
} {
  const runnable: LiveMatrixCombination[] = [];
  const skipped: LiveMatrixSkippedCombination[] = [];

  for (const combination of ALL_LIVE_MATRIX_COMBINATIONS) {
    const reason =
      getSandboxSkipReason(combination.sandboxProvider) ??
      getAgentSkipReason(
        combination.agentProvider,
        combination.sandboxProvider,
      );

    if (reason) {
      skipped.push({ ...combination, reason });
      continue;
    }

    runnable.push(combination);
  }

  return { runnable, skipped };
}

function getSandboxSkipReason(
  sandboxProvider: LiveMatrixSandboxProvider,
): string | null {
  if (sandboxProvider === SandboxProvider.LocalDocker) {
    return null;
  }

  if (sandboxProvider === SandboxProvider.Modal) {
    if (!ROOT_ENV.MODAL_TOKEN_ID || !ROOT_ENV.MODAL_TOKEN_SECRET) {
      return "requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.";
    }
    return null;
  }

  if (sandboxProvider === SandboxProvider.Daytona) {
    if (!ROOT_ENV.DAYTONA_API_KEY && !ROOT_ENV.DAYTONA_JWT_TOKEN) {
      return "requires DAYTONA_API_KEY or DAYTONA_JWT_TOKEN.";
    }
    return null;
  }

  if (sandboxProvider === SandboxProvider.Vercel) {
    if (
      !ROOT_ENV.VERCEL_TOKEN ||
      !ROOT_ENV.VERCEL_TEAM_ID ||
      !ROOT_ENV.VERCEL_PROJECT_ID
    ) {
      return "requires VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID.";
    }
    return null;
  }

  if (!ROOT_ENV.E2B_API_KEY) {
    return "requires E2B_API_KEY or E2B_ACCESS_TOKEN.";
  }
  if (Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) < 20) {
    return `requires Node 20+ in the Vitest runtime (current ${process.version}).`;
  }
  return null;
}

function getAgentSkipReason(
  agentProvider: LiveMatrixAgentProvider,
  sandboxProvider: LiveMatrixSandboxProvider,
): string | null {
  if (agentProvider === AgentProvider.Codex) {
    if (
      sandboxProvider === SandboxProvider.LocalDocker &&
      (fs.existsSync(HOST_AUTH_PATHS.codex) || ROOT_ENV.OPENAI_API_KEY)
    ) {
      return null;
    }
    return ROOT_ENV.OPENAI_API_KEY
      ? null
      : "requires OPENAI_API_KEY outside local-docker.";
  }

  if (agentProvider === AgentProvider.ClaudeCode) {
    if (
      sandboxProvider === SandboxProvider.LocalDocker &&
      (fs.existsSync(HOST_AUTH_PATHS.claude) || ROOT_ENV.ANTHROPIC_API_KEY)
    ) {
      return null;
    }
    return ROOT_ENV.ANTHROPIC_API_KEY
      ? null
      : "requires ANTHROPIC_API_KEY outside local-docker.";
  }

  return OPENCODE_CONFIG_CONTENT
    ? null
    : "requires OPENAI_API_KEY, ANTHROPIC_API_KEY, or AGENTBOX_E2E_OPENCODE_CONFIG_CONTENT.";
}

async function resolveSandboxImage(
  sandboxProvider: LiveMatrixSandboxProvider,
): Promise<string> {
  const cached = imageCache.get(sandboxProvider);
  if (cached) {
    return cached;
  }

  const build = (async () => {
    if (sandboxProvider === SandboxProvider.LocalDocker) {
      if (ROOT_ENV.AGENTBOX_E2E_DOCKER_IMAGE) {
        return ROOT_ENV.AGENTBOX_E2E_DOCKER_IMAGE;
      }
      return buildSandboxImage({
        provider: SandboxProvider.LocalDocker,
        preset: "browser-agent",
        imageName: "agentbox-browser-agent:matrix-e2e",
        env: ROOT_ENV,
        log: (chunk) => logImageBuildProgress(sandboxProvider, chunk),
      });
    }

    if (sandboxProvider === SandboxProvider.Modal) {
      if (ROOT_ENV.AGENTBOX_MODAL_IMAGE) {
        return ROOT_ENV.AGENTBOX_MODAL_IMAGE;
      }
      return buildSandboxImage({
        provider: SandboxProvider.Modal,
        preset: "browser-agent",
        modalAppName:
          ROOT_ENV.MODAL_APP_NAME ??
          ROOT_ENV.AGENTBOX_MODAL_APP_NAME ??
          "agentbox-images",
        env: ROOT_ENV,
        log: (chunk) => logImageBuildProgress(sandboxProvider, chunk),
      });
    }

    if (sandboxProvider === SandboxProvider.Daytona) {
      return buildSandboxImage({
        provider: SandboxProvider.Daytona,
        preset: "browser-agent",
        imageName: `browser-agent-matrix-e2e-${IMAGE_BUILD_SUFFIX}`,
        env: ROOT_ENV,
        log: (chunk) => logImageBuildProgress(sandboxProvider, chunk),
      });
    }

    if (sandboxProvider === SandboxProvider.Vercel) {
      if (ROOT_ENV.AGENTBOX_VERCEL_SNAPSHOT_ID) {
        return ROOT_ENV.AGENTBOX_VERCEL_SNAPSHOT_ID;
      }
      return buildVercelMatrixSnapshot();
    }

    return buildSandboxImage({
      provider: SandboxProvider.E2B,
      preset: "browser-agent",
      imageName: `agentbox-browser-agent-matrix-e2e:${IMAGE_BUILD_SUFFIX}`,
      env: ROOT_ENV,
      log: (chunk) => logImageBuildProgress(sandboxProvider, chunk),
    });
  })();

  imageCache.set(sandboxProvider, build);
  return build;
}

function createSandboxForCombination(
  combination: LiveMatrixCombination,
  image: string,
): Sandbox<LiveMatrixSandboxProvider> {
  const tags = {
    scope: "e2e",
    runner: "live-matrix",
    sandboxProvider: combination.sandboxProvider,
    agentProvider: combination.agentProvider,
    run: randomUUID(),
  };

  if (combination.sandboxProvider === SandboxProvider.LocalDocker) {
    return new Sandbox(SandboxProvider.LocalDocker, {
      workingDir: "/workspace",
      image,
      env: COMMON_SANDBOX_ENV,
      tags,
      provider: {
        ...(combination.agentProvider === AgentProvider.OpenCode
          ? { publishedPorts: [LOCAL_DOCKER_OPENCODE_PORT] }
          : {}),
        ...(combination.agentProvider === AgentProvider.ClaudeCode
          ? { publishedPorts: [LOCAL_DOCKER_CLAUDE_CODE_PORT] }
          : {}),
      },
    });
  }

  if (combination.sandboxProvider === SandboxProvider.Modal) {
    return new Sandbox(SandboxProvider.Modal, {
      workingDir: "/workspace",
      image,
      tags,
      idleTimeoutMs: 15 * 60_000,
      autoStopMs: 60 * 60_000,
      resources: {
        cpu: 2,
        memoryMiB: 4096,
      },
      provider: {
        appName: ROOT_ENV.MODAL_APP_NAME ?? "agentbox-matrix",
        ...(ROOT_ENV.MODAL_TOKEN_ID
          ? { tokenId: ROOT_ENV.MODAL_TOKEN_ID }
          : {}),
        ...(ROOT_ENV.MODAL_TOKEN_SECRET
          ? { tokenSecret: ROOT_ENV.MODAL_TOKEN_SECRET }
          : {}),
        unencryptedPorts: getModalPortsForAgent(combination.agentProvider),
      },
    });
  }

  if (combination.sandboxProvider === SandboxProvider.Daytona) {
    return new Sandbox(SandboxProvider.Daytona, {
      workingDir: "/workspace",
      image,
      tags,
      idleTimeoutMs: 30 * 60_000,
      provider: {
        name: `agentbox-matrix-${combination.agentProvider}-${randomUUID().slice(0, 8)}`,
        language: "typescript",
        ...(ROOT_ENV.DAYTONA_API_KEY
          ? { apiKey: ROOT_ENV.DAYTONA_API_KEY }
          : {}),
        ...(ROOT_ENV.DAYTONA_JWT_TOKEN
          ? { jwtToken: ROOT_ENV.DAYTONA_JWT_TOKEN }
          : {}),
        ...(ROOT_ENV.DAYTONA_ORGANIZATION_ID
          ? { organizationId: ROOT_ENV.DAYTONA_ORGANIZATION_ID }
          : {}),
        ...(ROOT_ENV.DAYTONA_API_URL
          ? { apiUrl: ROOT_ENV.DAYTONA_API_URL }
          : {}),
        ...(ROOT_ENV.DAYTONA_TARGET ? { target: ROOT_ENV.DAYTONA_TARGET } : {}),
      },
    });
  }

  if (combination.sandboxProvider === SandboxProvider.Vercel) {
    // Vercel sandboxes are capped at 5 tags total. The shared `tags` block
    // already has 5 entries, and the adapter auto-adds `agentbox.provider`,
    // which would push us to 6 and fail at create time. Drop `runner` since
    // `scope: "e2e"` already conveys it.
    const { runner: _runner, ...vercelTags } = tags;
    void _runner;
    return new Sandbox(SandboxProvider.Vercel, {
      workingDir: "/workspace",
      tags: vercelTags,
      resources: {
        cpu: 2,
        memoryMiB: 4096,
      },
      provider: {
        runtime: "node24",
        snapshotId: image,
        timeoutMs: 30 * 60_000,
        ports: getVercelPortsForAgent(combination.agentProvider),
        ...(ROOT_ENV.VERCEL_TOKEN ? { token: ROOT_ENV.VERCEL_TOKEN } : {}),
        ...(ROOT_ENV.VERCEL_TEAM_ID ? { teamId: ROOT_ENV.VERCEL_TEAM_ID } : {}),
        ...(ROOT_ENV.VERCEL_PROJECT_ID
          ? { projectId: ROOT_ENV.VERCEL_PROJECT_ID }
          : {}),
        ...(ROOT_ENV.VERCEL_PROTECTION_BYPASS
          ? { protectionBypass: ROOT_ENV.VERCEL_PROTECTION_BYPASS }
          : {}),
      },
    });
  }

  return new Sandbox(SandboxProvider.E2B, {
    workingDir: "/workspace",
    image,
    tags,
    provider: {
      ...(ROOT_ENV.E2B_API_KEY ? { apiKey: ROOT_ENV.E2B_API_KEY } : {}),
      ...(ROOT_ENV.E2B_ACCESS_TOKEN
        ? { accessToken: ROOT_ENV.E2B_ACCESS_TOKEN }
        : {}),
      ...(ROOT_ENV.E2B_DOMAIN ? { domain: ROOT_ENV.E2B_DOMAIN } : {}),
      ...(ROOT_ENV.E2B_API_URL ? { apiUrl: ROOT_ENV.E2B_API_URL } : {}),
      timeoutMs: 30 * 60_000,
      lifecycle: {
        onTimeout: "pause",
      },
      allowInternetAccess: true,
    },
  });
}

async function prepareSandboxForCombination(
  combination: LiveMatrixCombination,
  sandbox: Sandbox<LiveMatrixSandboxProvider>,
): Promise<string> {
  if (combination.sandboxProvider === SandboxProvider.LocalDocker) {
    assertLocalDockerPrerequisites(combination.agentProvider);
  }

  await sandbox.findOrProvision();

  const version = await sandbox.run(
    `${BINARY_BY_PROVIDER[combination.agentProvider]} --version`,
    {
      cwd: "/workspace",
      timeoutMs: 30_000,
    },
  );
  if (version.exitCode !== 0) {
    throw new Error(
      `Could not read ${formatLiveMatrixLabel(combination)} version: ${version.combinedOutput || version.stderr}`,
    );
  }

  return version.stdout.trim() || version.combinedOutput.trim();
}

function assertLocalDockerPrerequisites(
  agentProvider: LiveMatrixAgentProvider,
): void {
  if (agentProvider === AgentProvider.Codex) {
    if (!fs.existsSync(HOST_AUTH_PATHS.codex) && !ROOT_ENV.OPENAI_API_KEY) {
      throw new Error(
        "Codex local Docker matrix E2E requires either ~/.codex or OPENAI_API_KEY.",
      );
    }
    return;
  }

  if (agentProvider === AgentProvider.ClaudeCode) {
    if (!fs.existsSync(HOST_AUTH_PATHS.claude) && !ROOT_ENV.ANTHROPIC_API_KEY) {
      throw new Error(
        "Claude Code local Docker matrix E2E requires either ~/.claude or ANTHROPIC_API_KEY.",
      );
    }
    return;
  }

  if (!OPENCODE_CONFIG_CONTENT) {
    throw new Error(
      "OpenCode local Docker matrix E2E requires env-backed provider auth.",
    );
  }
}

function createAgentForCombination(
  combination: LiveMatrixCombination,
  sandbox: Sandbox<LiveMatrixSandboxProvider>,
): Agent<LiveMatrixAgentProvider> {
  if (combination.agentProvider === AgentProvider.Codex) {
    return new Agent(AgentProvider.Codex, {
      sandbox,
      cwd: "/workspace",
      approvalMode: "auto",
      env: {
        ...(ROOT_ENV.OPENAI_API_KEY
          ? { OPENAI_API_KEY: ROOT_ENV.OPENAI_API_KEY }
          : {}),
      },
    });
  }

  if (combination.agentProvider === AgentProvider.ClaudeCode) {
    return new Agent(AgentProvider.ClaudeCode, {
      sandbox,
      cwd: "/workspace",
      approvalMode: "auto",
      env: {
        ...(ROOT_ENV.ANTHROPIC_API_KEY
          ? { ANTHROPIC_API_KEY: ROOT_ENV.ANTHROPIC_API_KEY }
          : {}),
      },
      provider: {
        autoApproveTools: true,
        verbose: true,
      },
    });
  }

  return new Agent(AgentProvider.OpenCode, {
    sandbox,
    cwd: "/workspace",
    approvalMode: "auto",
    env: COMMON_SANDBOX_ENV,
  });
}

function getModelForCombination(
  agentProvider: LiveMatrixAgentProvider,
): string {
  if (agentProvider === AgentProvider.Codex) {
    return "gpt-5.4";
  }

  if (agentProvider === AgentProvider.ClaudeCode) {
    return "sonnet";
  }

  if (ROOT_ENV.ANTHROPIC_API_KEY) {
    return "anthropic/claude-sonnet-4-6";
  }

  if (ROOT_ENV.OPENAI_API_KEY) {
    return "openai/gpt-4.1";
  }

  throw new Error(
    "OpenCode matrix E2E requires an image-capable provider configuration.",
  );
}

function getModalPortsForAgent(
  agentProvider: LiveMatrixAgentProvider,
): number[] {
  if (agentProvider === AgentProvider.Codex) {
    return [MODAL_CODEX_PORT];
  }

  if (agentProvider === AgentProvider.OpenCode) {
    return [MODAL_OPENCODE_PORT];
  }

  return [43180];
}

function getVercelPortsForAgent(
  agentProvider: LiveMatrixAgentProvider,
): number[] {
  if (agentProvider === AgentProvider.Codex) {
    return [VERCEL_CODEX_PORT];
  }

  if (agentProvider === AgentProvider.OpenCode) {
    return [VERCEL_OPENCODE_PORT];
  }

  // claude-code uses an SDK WebSocket relay on REMOTE_SDK_RELAY_PORT (43180)
  return [VERCEL_CLAUDE_CODE_PORT];
}

async function buildVercelMatrixSnapshot(): Promise<string> {
  if (
    !ROOT_ENV.VERCEL_TOKEN ||
    !ROOT_ENV.VERCEL_TEAM_ID ||
    !ROOT_ENV.VERCEL_PROJECT_ID
  ) {
    throw new Error(
      "Vercel matrix snapshot build requires VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID.",
    );
  }

  const log = (chunk: string) =>
    logImageBuildProgress(SandboxProvider.Vercel, chunk);

  const prep = new Sandbox(SandboxProvider.Vercel, {
    workingDir: "/workspace",
    tags: {
      scope: "e2e",
      runner: "live-matrix",
      role: "snapshot-build",
      run: IMAGE_BUILD_SUFFIX,
    },
    resources: { cpu: 2, memoryMiB: 4096 },
    provider: {
      runtime: "node24",
      timeoutMs: 30 * 60_000,
      token: ROOT_ENV.VERCEL_TOKEN,
      teamId: ROOT_ENV.VERCEL_TEAM_ID,
      projectId: ROOT_ENV.VERCEL_PROJECT_ID,
      ...(ROOT_ENV.VERCEL_PROTECTION_BYPASS
        ? { protectionBypass: ROOT_ENV.VERCEL_PROTECTION_BYPASS }
        : {}),
    },
  });

  try {
    log("provisioning prep sandbox");
    // The shared `Sandbox` API now requires an explicit `findOrProvision()`
    // before any `run`/`uploadFile`/`gitClone` etc. — provisioning is no
    // longer triggered implicitly. Without this call the snapshot build
    // would fail with `Sandbox (vercel) is not provisioned`.
    await prep.findOrProvision();
    const install = await prep.run(
      "sudo npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai",
      { timeoutMs: 5 * 60_000 },
    );
    if (install.exitCode !== 0) {
      throw new Error(
        `Failed to install agent CLIs in Vercel prep sandbox: ${
          install.stderr || install.combinedOutput
        }`,
      );
    }
    log("agent CLIs installed");

    const snapshotId = await prep.snapshot();
    if (!snapshotId) {
      throw new Error("Vercel prep sandbox returned a null snapshot id.");
    }
    log(`snapshot ready ${snapshotId}`);
    return snapshotId;
  } finally {
    await prep.delete().catch(() => undefined);
  }
}

function buildOpenCodeConfigContent(): string | undefined {
  if (ROOT_ENV.AGENTBOX_E2E_OPENCODE_CONFIG_CONTENT) {
    return ROOT_ENV.AGENTBOX_E2E_OPENCODE_CONFIG_CONTENT;
  }

  const providerConfig = {
    ...(ROOT_ENV.OPENAI_API_KEY
      ? {
          openai: {
            options: {
              apiKey: "{env:OPENAI_API_KEY}",
            },
          },
        }
      : {}),
    ...(ROOT_ENV.ANTHROPIC_API_KEY
      ? {
          anthropic: {
            options: {
              apiKey: "{env:ANTHROPIC_API_KEY}",
            },
          },
        }
      : {}),
  };

  if (Object.keys(providerConfig).length === 0) {
    return undefined;
  }

  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: providerConfig,
  });
}

function loadDotEnvFile(fileUrl: URL): Record<string, string> {
  if (!fs.existsSync(fileUrl)) {
    return { ...process.env } as Record<string, string>;
  }

  const values: Record<string, string> = {};
  const content = fs.readFileSync(fileUrl, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);
    values[key] = value;
  }

  return {
    ...values,
    ...(process.env as Record<string, string | undefined>),
  } as Record<string, string>;
}

async function withTimeout<TResult>(
  label: string,
  task: () => Promise<TResult>,
  timeoutMs: number,
  onTimeout: () => Promise<void>,
): Promise<TResult> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(async () => {
      try {
        await onTimeout();
      } catch {
        // Ignore abort failures; the timeout error is still the signal.
      }
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task(), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function logImageBuildProgress(
  sandboxProvider: LiveMatrixSandboxProvider,
  chunk: string,
): void {
  const trimmed = chunk.trim();
  if (!trimmed) {
    return;
  }
  console.info(`[live-matrix-e2e:image:${sandboxProvider}] ${trimmed}`);
}
