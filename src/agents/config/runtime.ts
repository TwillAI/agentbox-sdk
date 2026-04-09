import { mkdtemp, mkdir, chmod, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentOptions, AgentProviderName } from "../types";
import type { RuntimeTarget, RuntimeLayout, TextArtifact } from "./types";
import { shellQuote } from "../../shared/shell";
import { spawnCommand } from "../transports/spawn";

function createLayout(homeDir: string): RuntimeLayout {
  const xdgConfigHome = path.join(homeDir, ".config");
  const codexDir = path.join(homeDir, ".codex");

  return {
    rootDir: homeDir,
    homeDir,
    xdgConfigHome,
    agentsDir: path.join(homeDir, ".agents"),
    claudeDir: path.join(homeDir, ".claude"),
    opencodeDir: path.join(xdgConfigHome, "opencode"),
    codexDir,
  };
}

class HostRuntimeTarget implements RuntimeTarget {
  readonly env: Record<string, string>;

  constructor(
    readonly provider: AgentProviderName,
    readonly layout: RuntimeLayout,
    private readonly cwd: string,
    private readonly baseEnv: Record<string, string>,
  ) {
    this.env = {};
  }

  async writeArtifact(artifact: TextArtifact): Promise<void> {
    await mkdir(path.dirname(artifact.path), { recursive: true });
    await writeFile(artifact.path, artifact.content, "utf8");
    if (artifact.executable) {
      await chmod(artifact.path, 0o755);
    }
  }

  async runCommand(
    command: string,
    extraEnv?: Record<string, string>,
  ): Promise<void> {
    const handle = spawnCommand({
      command: process.env.SHELL || "sh",
      args: ["-lc", command],
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
  }

  async cleanup(): Promise<void> {
    await rm(this.layout.rootDir, { recursive: true, force: true });
  }
}

class SandboxRuntimeTarget implements RuntimeTarget {
  readonly env: Record<string, string>;

  constructor(
    readonly provider: AgentProviderName,
    readonly layout: RuntimeLayout,
    private readonly options: AgentOptions,
  ) {
    this.env = {};
  }

  async writeArtifact(artifact: TextArtifact): Promise<void> {
    const marker = `__OPENAGENT_${Math.random().toString(36).slice(2)}__`;
    const command = `mkdir -p ${shellQuote(
      path.posix.dirname(artifact.path),
    )} && cat > ${shellQuote(artifact.path)} <<'${marker}'
${artifact.content}
${marker}`;

    await this.options.sandbox?.run(command, {
      cwd: this.options.cwd,
      env: {
        ...(this.options.env ?? {}),
        ...this.env,
      },
    });

    if (artifact.executable) {
      await this.options.sandbox?.run(`chmod +x ${shellQuote(artifact.path)}`, {
        cwd: this.options.cwd,
        env: {
          ...(this.options.env ?? {}),
          ...this.env,
        },
      });
    }
  }

  async runCommand(
    command: string,
    extraEnv?: Record<string, string>,
  ): Promise<void> {
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
  }

  async cleanup(): Promise<void> {
    await this.options.sandbox?.run(
      `rm -rf ${shellQuote(this.layout.rootDir)}`,
      {
        cwd: this.options.cwd,
        env: {
          ...(this.options.env ?? {}),
          ...this.env,
        },
      },
    );
  }
}

export async function createRuntimeTarget<P extends AgentProviderName>(
  provider: P,
  runId: string,
  options: AgentOptions<P>,
): Promise<RuntimeTarget> {
  if (options.sandbox) {
    const layout = createLayout(`/tmp/openagent/${provider}/${runId}`);
    await options.sandbox.run(
      [
        `mkdir -p ${shellQuote(layout.homeDir)}`,
        `mkdir -p ${shellQuote(layout.xdgConfigHome)}`,
        `mkdir -p ${shellQuote(layout.agentsDir)}`,
        `mkdir -p ${shellQuote(layout.claudeDir)}`,
        `mkdir -p ${shellQuote(layout.opencodeDir)}`,
        `mkdir -p ${shellQuote(layout.codexDir)}`,
      ].join(" && "),
      {
        cwd: options.cwd,
        env: {
          ...(options.env ?? {}),
        },
      },
    );
    return new SandboxRuntimeTarget(provider, layout, options);
  }

  const rootDir = await mkdtemp(
    path.join(os.tmpdir(), `openagent-${provider}-`),
  );
  const layout = createLayout(rootDir);
  await mkdir(layout.homeDir, { recursive: true });
  await mkdir(layout.xdgConfigHome, { recursive: true });
  await mkdir(layout.agentsDir, { recursive: true });
  await mkdir(layout.claudeDir, { recursive: true });
  await mkdir(layout.opencodeDir, { recursive: true });
  await mkdir(layout.codexDir, { recursive: true });

  return new HostRuntimeTarget(
    provider,
    layout,
    options.cwd ?? process.cwd(),
    options.env ?? {},
  );
}
