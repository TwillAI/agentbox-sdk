import { mkdir, chmod, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { TarballEntry } from "../../sandboxes/tarball";
import type { CommandResult } from "../../sandboxes/types";
import type { AgentOptions, AgentProviderName } from "../types";
import type { SetupTarget, SetupLayout } from "./types";
import { spawnCommand } from "../transports/spawn";
import { debugRuntime, time } from "../../shared/debug";

function shortLabel(command: string): string {
  // Trim & collapse whitespace, then keep only the first ~60 characters
  // so the debug stream stays readable when commands are huge heredocs.
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

/**
 * The on-disk root for every artifact agentbox writes for a given
 * provider. Deterministic — same inputs, same path — so `setup()` and
 * `execute()` / `forkAt()` agree on file locations without any data
 * channel between them.
 *
 *  - **Sandbox**: `/tmp/agentbox/<provider>` inside the sandbox.
 *  - **Local host**: `<os.tmpdir()>/agentbox-<provider>` on the host.
 */
export function agentboxRoot(
  provider: AgentProviderName,
  hasSandbox: boolean,
): string {
  return hasSandbox
    ? `/tmp/agentbox/${provider}`
    : path.join(os.tmpdir(), `agentbox-${provider}`);
}

function buildLayout(rootDir: string): SetupLayout {
  const xdgConfigHome = path.join(rootDir, ".config");
  return {
    rootDir,
    homeDir: rootDir,
    xdgConfigHome,
    agentsDir: path.join(rootDir, ".agents"),
    claudeDir: path.join(rootDir, ".claude"),
    opencodeDir: path.join(xdgConfigHome, "opencode"),
    codexDir: path.join(rootDir, ".codex"),
  };
}

/**
 * Provider-specific env keys that point at the on-disk config layout.
 * Used internally by `HostSetupTarget` / `SandboxSetupTarget` so the
 * commands they run inherit the right config-home env. Each provider's
 * `execute()` builds the same env inline (it's two or three lines).
 */
function buildLayoutEnv(
  provider: AgentProviderName,
  layout: SetupLayout,
): Record<string, string> {
  switch (provider) {
    case "claude-code":
      return { CLAUDE_CONFIG_DIR: layout.claudeDir };
    case "codex":
      return { CODEX_HOME: layout.codexDir };
    case "open-code":
      // OpenCode reads `OPENCODE_CONFIG` as a path to the config FILE
      // (we name ours `agentbox.json`) and `OPENCODE_CONFIG_DIR` as
      // the parent dir for plugins / skills lookup.
      return {
        OPENCODE_CONFIG: path.join(layout.opencodeDir, "agentbox.json"),
        OPENCODE_CONFIG_DIR: layout.opencodeDir,
      };
  }
}

class HostSetupTarget implements SetupTarget {
  readonly env: Record<string, string>;

  constructor(
    readonly provider: AgentProviderName,
    readonly layout: SetupLayout,
    private readonly cwd: string,
    private readonly baseEnv: Record<string, string>,
  ) {
    this.env = buildLayoutEnv(provider, layout);
  }

  /**
   * Host implementation: write each artifact directly to the local
   * filesystem (we're already on the box), then run the command via
   * `sh -c`. No tarball needed since there's no RPC to amortize.
   */
  async uploadAndRun(
    files: TarballEntry[],
    command: string,
  ): Promise<CommandResult> {
    return time(
      debugRuntime,
      `host uploadAndRun ${shortLabel(command)}`,
      async () => {
        await Promise.all(
          files.map(async (entry) => {
            await mkdir(path.dirname(entry.path), { recursive: true });
            const content =
              typeof entry.content === "string" ? entry.content : entry.content;
            await writeFile(entry.path, content);
            if (entry.mode && (entry.mode & 0o111) !== 0) {
              await chmod(entry.path, entry.mode);
            }
          }),
        );

        const handle = spawnCommand({
          command: "sh",
          args: ["-c", command],
          cwd: this.cwd,
          env: {
            ...process.env,
            ...this.baseEnv,
            ...this.env,
          },
        });

        const exitCode = await handle.wait();
        return {
          exitCode,
          stdout: "",
          stderr: "",
          combinedOutput: "",
        };
      },
      (result) => ({ exit: result.exitCode, files: files.length }),
    );
  }

  async runCommand(
    command: string,
    extraEnv?: Record<string, string>,
  ): Promise<void> {
    await time(
      debugRuntime,
      `host runCommand ${shortLabel(command)}`,
      async () => {
        const handle = spawnCommand({
          command: process.env.SHELL || "sh",
          args: ["-c", command],
          cwd: this.cwd,
          env: {
            ...process.env,
            ...this.baseEnv,
            ...this.env,
            ...(extraEnv ?? {}),
          },
        });

        const exitCode = await handle.wait();
        if (exitCode !== 0) {
          throw new Error(`Setup command failed (${exitCode}): ${command}`);
        }
      },
    );
  }

  async cleanup(): Promise<void> {
    await rm(this.layout.rootDir, { recursive: true, force: true });
  }
}

class SandboxSetupTarget implements SetupTarget {
  readonly env: Record<string, string>;

  constructor(
    readonly provider: AgentProviderName,
    readonly layout: SetupLayout,
    private readonly options: AgentOptions,
  ) {
    this.env = buildLayoutEnv(provider, layout);
  }

  /**
   * Sandbox implementation: delegate to `Sandbox.uploadAndRun` so the
   * tarball + extract + exec all happen in a single Modal RPC. This is
   * the hot path used by `applyDifferentialSetup`.
   */
  async uploadAndRun(
    files: TarballEntry[],
    command: string,
  ): Promise<CommandResult> {
    const sandbox = this.options.sandbox;
    if (!sandbox) {
      throw new Error(
        "SandboxSetupTarget.uploadAndRun called without a sandbox.",
      );
    }
    return time(
      debugRuntime,
      `sandbox uploadAndRun ${shortLabel(command)}`,
      () =>
        sandbox.uploadAndRun(files, command, {
          cwd: this.options.cwd,
          env: {
            ...(this.options.env ?? {}),
            ...this.env,
          },
        }),
      (result) => ({ exit: result.exitCode, files: files.length }),
    );
  }

  async runCommand(
    command: string,
    extraEnv?: Record<string, string>,
  ): Promise<void> {
    await time(
      debugRuntime,
      `sandbox runCommand ${shortLabel(command)}`,
      async () => {
        const result = await this.options.sandbox?.run(command, {
          cwd: this.options.cwd,
          env: {
            ...(this.options.env ?? {}),
            ...this.env,
            ...(extraEnv ?? {}),
          },
        });

        if (result && result.exitCode !== 0) {
          throw new Error(
            `Sandbox setup command failed (${result.exitCode}): ${command}`,
          );
        }
      },
    );
  }

  async cleanup(): Promise<void> {
    // Intentionally a no-op. The setup layout is shared across runs in the
    // same sandbox so the differential setup cache (see `setup-manifest.ts`)
    // can skip work that has already been applied. Wiping the root dir on
    // every run would defeat that cache and reintroduce the sequential
    // artifact-write latency the cache is meant to eliminate.
    //
    // Per-run state (transport sockets, processes) is in-memory and torn down
    // by the higher-level cleanup paths in each provider. There is nothing on
    // disk that needs to be removed between runs in the same sandbox.
  }
}

/**
 * Build an upload+run-capable target for a setup phase.
 *
 * Setup-only API. Execute / forkAt should NOT call this; they need
 * paths/env (use {@link getSetupLayout} + {@link buildLayoutEnv}) or
 * direct sandbox access, not a heavyweight target wrapper that mkdirs
 * the host layout as a side effect.
 *
 * Idempotent for both transports: sandbox mode just constructs a thin
 * wrapper, and host mode `mkdir -p`s the layout dirs which is safe to
 * re-run.
 */
export async function createSetupTarget<P extends AgentProviderName>(
  provider: P,
  setupId: string,
  options: AgentOptions<P>,
): Promise<SetupTarget> {
  return time(debugRuntime, `createSetupTarget ${provider}`, async () => {
    // `setupId` is intentionally unused for the on-disk layout root: the
    // layout is stable per (sandbox, provider) so the differential setup
    // cache works across runs. We keep the parameter so callers can label
    // distinct setup invocations (e.g. shared app-server vs per-run
    // skill staging).
    void setupId;

    const layout = buildLayout(
      agentboxRoot(provider, Boolean(options.sandbox)),
    );

    if (options.sandbox) {
      // The sandbox-side `tar -x` will create the directory structure for
      // every artifact path implicitly; we don't need a per-create
      // `mkdir -p` round-trip just to seed the layout dirs.
      return new SandboxSetupTarget(provider, layout, options);
    }

    // Host: ensure the deterministic layout exists on disk so the
    // upload-and-run path can drop files straight into it.
    await mkdir(layout.homeDir, { recursive: true });
    await mkdir(layout.xdgConfigHome, { recursive: true });
    await mkdir(layout.agentsDir, { recursive: true });
    await mkdir(layout.claudeDir, { recursive: true });
    await mkdir(layout.opencodeDir, { recursive: true });
    await mkdir(layout.codexDir, { recursive: true });

    return new HostSetupTarget(
      provider,
      layout,
      options.cwd ?? process.cwd(),
      options.env ?? {},
    );
  });
}

export async function writeHostArtifact(
  target: SetupTarget,
  artifact: { path: string; content: string; executable?: boolean },
): Promise<void> {
  // Used by host-only paths (e.g. local Codex login) that need to write a
  // single file without rebuilding the whole setup tarball. Sandbox
  // targets shouldn't reach this — those paths bundle through
  // `applyDifferentialSetup`.
  await mkdir(path.dirname(artifact.path), { recursive: true });
  await writeFile(artifact.path, artifact.content, "utf8");
  if (artifact.executable) {
    await chmod(artifact.path, 0o755);
  }
}
