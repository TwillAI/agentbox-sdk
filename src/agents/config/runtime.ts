import { mkdtemp, mkdir, chmod, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentOptions, AgentProviderName } from "../types";
import type {
  MaterializationTarget,
  RuntimeLayout,
  TextArtifact,
} from "./types";
import { shellQuote } from "../../shared/shell";
import { spawnCommand } from "../transports/spawn";

function createLayout(
  rootDir: string,
  env?: Record<string, string>,
): RuntimeLayout {
  const homeDir = env?.HOME ?? path.join(rootDir, "home");
  const xdgConfigHome = env?.XDG_CONFIG_HOME ?? path.join(homeDir, ".config");
  const codexDir = env?.CODEX_HOME ?? path.join(homeDir, ".codex");

  return {
    rootDir,
    homeDir,
    xdgConfigHome,
    agentsDir: path.join(homeDir, ".agents"),
    claudeDir: path.join(homeDir, ".claude"),
    opencodeDir: path.join(xdgConfigHome, "opencode"),
    codexDir,
  };
}

class HostMaterializationTarget implements MaterializationTarget {
  readonly env: Record<string, string>;

  constructor(
    readonly provider: AgentProviderName,
    readonly layout: RuntimeLayout,
    private readonly cwd: string,
    private readonly baseEnv: Record<string, string>,
  ) {
    this.env = {
      HOME: layout.homeDir,
      XDG_CONFIG_HOME: layout.xdgConfigHome,
      CODEX_HOME: layout.codexDir,
    };
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

class SandboxMaterializationTarget implements MaterializationTarget {
  readonly env: Record<string, string>;

  constructor(
    readonly provider: AgentProviderName,
    readonly layout: RuntimeLayout,
    private readonly options: AgentOptions,
  ) {
    this.env = {
      HOME: layout.homeDir,
      XDG_CONFIG_HOME: layout.xdgConfigHome,
      CODEX_HOME: layout.codexDir,
    };
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

export async function createMaterializationTarget<P extends AgentProviderName>(
  provider: P,
  runId: string,
  options: AgentOptions<P>,
): Promise<MaterializationTarget> {
  if (options.sandbox) {
    const layout = createLayout(
      `/tmp/openagent/${provider}/${runId}`,
      options.env,
    );
    return new SandboxMaterializationTarget(provider, layout, options);
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

  return new HostMaterializationTarget(
    provider,
    layout,
    options.cwd ?? process.cwd(),
    options.env ?? {},
  );
}
