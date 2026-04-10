import type { Sandbox as E2bSandbox } from "e2b";

import { SandboxAdapter } from "../base";
import type {
  AsyncCommandHandle,
  CommandEvent,
  CommandOptions,
  CommandResult,
  E2bProviderOptions,
  E2bSandboxOptions,
  SandboxDescriptor,
  SandboxListOptions,
} from "../types";
import { AsyncQueue } from "../../shared/async-queue";
import { toShellCommand } from "../../shared/shell";
import { resolveSandboxImage, resolveSandboxResources } from "../image-utils";

export type E2bRaw = {
  sandbox?: E2bSandbox;
};

type E2bTimeoutConfig = {
  timeoutMs?: number;
  lifecycle?: {
    onTimeout: "pause" | "kill";
    autoResume?: boolean;
  };
};

let e2bModulePromise: Promise<typeof import("e2b")> | undefined;

async function loadE2bModule(): Promise<typeof import("e2b")> {
  if (!e2bModulePromise) {
    e2bModulePromise = import("e2b");
  }

  return e2bModulePromise;
}

export class E2bSandboxAdapter extends SandboxAdapter<
  "e2b",
  E2bSandboxOptions,
  E2bRaw
> {
  private sandbox?: E2bSandbox;

  get provider(): "e2b" {
    return "e2b";
  }

  get raw(): E2bRaw {
    return {
      sandbox: this.sandbox,
    };
  }

  get id(): string | undefined {
    return this.sandbox?.sandboxId;
  }

  protected async provision(): Promise<void> {
    const { Sandbox: E2bSandbox } = await loadE2bModule();
    const existing = await this.findMatchingSandbox();
    if (existing) {
      this.sandbox = existing;
      return;
    }

    const template = resolveSandboxImage(this.options.image);
    const resources = resolveSandboxResources(this.options.resources);
    if (!template) {
      throw new Error(
        "e2b sandboxes require options.image to reference an existing E2B template name or tag.",
      );
    }
    if (resources) {
      throw new Error(
        "e2b sandbox sizing must be defined when building the E2B template and cannot be set via options.resources.",
      );
    }

    const timeout = this.resolveTimeoutConfig();
    this.sandbox = await E2bSandbox.create(template, {
      ...this.getConnectionOptions(),
      metadata: this.getMetadata(),
      envs: this.getMergedEnv(),
      secure: this.options.provider?.secure,
      allowInternetAccess: this.options.provider?.allowInternetAccess,
      ...timeout,
    });
  }

  async run(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    await this.ensureProvisioned();
    const sandbox = this.requireSandbox();
    const { CommandExitError } = await loadE2bModule();
    if (options?.pty) {
      const queue = new AsyncQueue<CommandEvent>();
      const handle = await this.runAsyncWithPty(
        sandbox,
        command,
        options,
        queue,
      );
      const result = await handle.wait();
      return result;
    }

    try {
      const result = await sandbox.commands.run(
        toShellCommand(command),
        this.getCommandStartOptions(options),
      );
      return this.toCommandResult(result, result);
    } catch (error) {
      if (error instanceof CommandExitError) {
        return this.toCommandResult(error, error);
      }
      throw error;
    }
  }

  async runAsync(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<AsyncCommandHandle> {
    await this.ensureProvisioned();
    const sandbox = this.requireSandbox();
    const { CommandExitError } = await loadE2bModule();
    const queue = new AsyncQueue<CommandEvent>();
    let stdout = "";
    let stderr = "";

    if (options?.pty) {
      return this.runAsyncWithPty(sandbox, command, options, queue);
    }

    const handle = await sandbox.commands.run(toShellCommand(command), {
      ...this.getCommandStartOptions(options),
      timeoutMs: options?.timeoutMs ?? 0,
      background: true,
      stdin: true,
      onStdout: async (chunk: string) => {
        stdout += chunk;
        queue.push({
          type: "stdout",
          chunk,
          timestamp: new Date().toISOString(),
        });
      },
      onStderr: async (chunk: string) => {
        stderr += chunk;
        queue.push({
          type: "stderr",
          chunk,
          timestamp: new Date().toISOString(),
        });
      },
    });

    const completion = handle
      .wait()
      .then((result) => {
        const mapped = this.toCommandResult(
          {
            exitCode: result.exitCode,
            stdout: stdout || result.stdout,
            stderr: stderr || result.stderr,
            error: result.error,
          },
          result,
        );
        queue.push({
          type: "exit",
          exitCode: mapped.exitCode,
          timestamp: new Date().toISOString(),
        });
        queue.finish();
        return mapped;
      })
      .catch((error) => {
        if (error instanceof CommandExitError) {
          const mapped = this.toCommandResult(
            {
              exitCode: error.exitCode,
              stdout: stdout || error.stdout,
              stderr: stderr || error.stderr,
              error: error.error,
            },
            error,
          );
          queue.push({
            type: "exit",
            exitCode: mapped.exitCode,
            timestamp: new Date().toISOString(),
          });
          queue.finish();
          return mapped;
        }
        queue.fail(error);
        throw error;
      });

    return {
      id: String(handle.pid),
      raw: handle,
      write: async (input: string) => {
        await sandbox.commands.sendStdin(handle.pid, input);
      },
      wait: () => completion,
      kill: async () => {
        await handle.kill();
      },
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    };
  }

  private async runAsyncWithPty(
    sandbox: E2bSandbox,
    command: string | string[],
    options: CommandOptions | undefined,
    queue: AsyncQueue<CommandEvent>,
  ): Promise<AsyncCommandHandle> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let output = "";

    const handle = await sandbox.pty.create({
      cols: 120,
      rows: 40,
      cwd: options?.cwd ?? this.workingDir,
      envs: this.getMergedEnv(options?.env),
      timeoutMs: options?.timeoutMs ?? 0,
      onData: async (chunk: Uint8Array) => {
        const text = decoder.decode(chunk, { stream: true });
        output += text;
        queue.push({
          type: "stdout",
          chunk: text,
          timestamp: new Date().toISOString(),
        });
      },
    });

    await sandbox.pty.sendInput(
      handle.pid,
      encoder.encode(`${toShellCommand(command)}\n`),
    );

    const completion = handle
      .wait()
      .then((result) => {
        const flush = decoder.decode();
        if (flush) {
          output += flush;
          queue.push({
            type: "stdout",
            chunk: flush,
            timestamp: new Date().toISOString(),
          });
        }
        queue.push({
          type: "exit",
          exitCode: result.exitCode,
          timestamp: new Date().toISOString(),
        });
        queue.finish();
        return {
          exitCode: result.exitCode,
          stdout: output || result.stdout,
          stderr: result.stderr,
          combinedOutput: `${output || result.stdout}${result.stderr}`,
          raw: result,
        } satisfies CommandResult;
      })
      .catch((error) => {
        queue.fail(error);
        throw error;
      });

    return {
      id: String(handle.pid),
      raw: handle,
      write: async (input: string) => {
        await sandbox.pty.sendInput(handle.pid, encoder.encode(input));
      },
      wait: () => completion,
      kill: async () => {
        await handle.kill();
      },
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    };
  }

  async list(options?: SandboxListOptions): Promise<SandboxDescriptor[]> {
    const { Sandbox: E2bSandbox } = await loadE2bModule();
    const paginator = E2bSandbox.list({
      ...this.getConnectionOptions(),
      query: {
        metadata: options?.tags ?? this.getMetadata(),
        state: ["running", "paused"],
      },
    });
    const sandboxes: SandboxDescriptor[] = [];

    while (paginator.hasNext) {
      const items = await paginator.nextItems();
      for (const sandbox of items) {
        sandboxes.push({
          provider: this.provider,
          id: sandbox.sandboxId,
          state: sandbox.state,
          tags: sandbox.metadata,
          createdAt: sandbox.startedAt.toISOString(),
          raw: sandbox,
        });
      }
    }

    return sandboxes;
  }

  async snapshot(): Promise<string | null> {
    await this.ensureProvisioned();
    const sandbox = this.requireSandbox();
    const snapshot = await sandbox.createSnapshot();
    return snapshot.snapshotId;
  }

  async stop(): Promise<void> {
    const sandbox = this.sandbox;
    if (!sandbox) {
      return;
    }

    await sandbox.kill();
    this.sandbox = undefined;
  }

  async delete(): Promise<void> {
    await this.stop();
  }

  async openPort(_port: number): Promise<void> {
    // E2B exposes preview URLs directly via getHost(port), so there is no
    // separate provisioning step equivalent to Docker port publishing.
    void _port;
  }

  async getPreviewLink(port: number): Promise<string> {
    await this.ensureProvisioned();
    const sandbox = this.requireSandbox();
    const host = sandbox.getHost(port);
    return host.startsWith("localhost:") ? `http://${host}` : `https://${host}`;
  }

  private async findMatchingSandbox(): Promise<E2bSandbox | undefined> {
    const { Sandbox: E2bSandbox } = await loadE2bModule();
    const matches = await this.list();
    const match = matches[0];
    if (!match) {
      return undefined;
    }

    const timeout = this.resolveTimeoutConfig();
    return E2bSandbox.connect(match.id, {
      ...this.getConnectionOptions(),
      timeoutMs: timeout.timeoutMs,
    });
  }

  private getMetadata(): Record<string, string> {
    return {
      "agentbox.provider": this.provider,
      ...(this.options.tags ?? {}),
    };
  }

  private getConnectionOptions(): Pick<
    E2bProviderOptions,
    | "accessToken"
    | "apiKey"
    | "apiUrl"
    | "debug"
    | "domain"
    | "headers"
    | "requestTimeoutMs"
    | "sandboxUrl"
  > {
    return {
      accessToken: this.options.provider?.accessToken,
      apiKey: this.options.provider?.apiKey,
      apiUrl: this.options.provider?.apiUrl,
      debug: this.options.provider?.debug,
      domain: this.options.provider?.domain,
      headers: this.options.provider?.headers,
      requestTimeoutMs: this.options.provider?.requestTimeoutMs,
      sandboxUrl: this.options.provider?.sandboxUrl,
    };
  }

  private getCommandStartOptions(options?: CommandOptions): {
    cwd: string;
    envs: Record<string, string>;
    timeoutMs?: number;
  } {
    return {
      cwd: options?.cwd ?? this.workingDir,
      envs: this.getMergedEnv(options?.env),
      timeoutMs: options?.timeoutMs,
    };
  }

  private resolveTimeoutConfig(): E2bTimeoutConfig {
    const providerTimeoutMs = this.options.provider?.timeoutMs;
    const providerLifecycle = this.options.provider?.lifecycle;
    const hasProviderTimeoutOverride =
      providerTimeoutMs !== undefined || providerLifecycle !== undefined;
    const normalizedLifecycle = providerLifecycle?.onTimeout
      ? {
          onTimeout: providerLifecycle.onTimeout,
          autoResume: providerLifecycle.autoResume,
        }
      : undefined;

    if (
      hasProviderTimeoutOverride &&
      (this.options.idleTimeoutMs !== undefined ||
        this.options.autoStopMs !== undefined)
    ) {
      throw new Error(
        "e2b sandbox timeout configuration must use either provider.timeoutMs/provider.lifecycle or the shared idleTimeoutMs/autoStopMs fields, but not both.",
      );
    }

    if (
      providerLifecycle?.autoResume &&
      providerLifecycle.onTimeout !== "pause"
    ) {
      throw new Error(
        "e2b provider.lifecycle.autoResume can only be enabled when provider.lifecycle.onTimeout is 'pause'.",
      );
    }

    if (hasProviderTimeoutOverride) {
      return {
        timeoutMs: providerTimeoutMs,
        lifecycle: normalizedLifecycle,
      };
    }

    if (
      this.options.idleTimeoutMs !== undefined &&
      this.options.autoStopMs !== undefined
    ) {
      throw new Error(
        "e2b sandboxes do not support combining idleTimeoutMs and autoStopMs because the provider exposes a single timeout/lifecycle configuration.",
      );
    }

    if (this.options.idleTimeoutMs !== undefined) {
      return {
        timeoutMs: this.options.idleTimeoutMs,
        lifecycle: {
          onTimeout: "pause",
          autoResume: false,
        },
      };
    }

    if (this.options.autoStopMs !== undefined) {
      return {
        timeoutMs: this.options.autoStopMs,
        lifecycle: {
          onTimeout: "kill",
          autoResume: false,
        },
      };
    }

    return {};
  }

  private requireSandbox(): E2bSandbox {
    if (!this.sandbox) {
      throw new Error("E2B sandbox has not been provisioned.");
    }

    return this.sandbox;
  }

  private toCommandResult(
    result: {
      exitCode: number;
      stdout: string;
      stderr: string;
      error?: string;
    },
    raw: unknown,
  ): CommandResult {
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      combinedOutput: `${result.stdout}${result.stderr}`,
      raw,
    };
  }
}
