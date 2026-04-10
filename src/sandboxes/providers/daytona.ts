import { Daytona, type Sandbox as DaytonaSandboxObject } from "@daytonaio/sdk";

import { SandboxAdapter } from "../base";
import type {
  AsyncCommandHandle,
  CommandEvent,
  CommandOptions,
  CommandResult,
  DaytonaSandboxOptions,
  SandboxDescriptor,
  SandboxListOptions,
} from "../types";
import { AsyncQueue } from "../../shared/async-queue";
import { sleep } from "../../shared/network";
import { shellQuote, toShellCommand } from "../../shared/shell";
import { resolveSandboxImage, resolveSandboxResources } from "../image-utils";

export type DaytonaRaw = {
  client: Daytona;
  sandbox?: DaytonaSandboxObject;
};

export class DaytonaSandboxAdapter extends SandboxAdapter<
  "daytona",
  DaytonaSandboxOptions,
  DaytonaRaw
> {
  private readonly client: Daytona;
  private sandbox?: DaytonaSandboxObject;

  constructor(options: DaytonaSandboxOptions) {
    super(options);

    this.client = new Daytona({
      apiKey: options.provider?.apiKey,
      jwtToken: options.provider?.jwtToken,
      organizationId: options.provider?.organizationId,
      apiUrl: options.provider?.apiUrl,
      target: options.provider?.target,
    });
  }

  get provider(): "daytona" {
    return "daytona";
  }

  get raw(): DaytonaRaw {
    return {
      client: this.client,
      sandbox: this.sandbox,
    };
  }

  get id(): string | undefined {
    return this.sandbox?.id;
  }

  protected async provision(): Promise<void> {
    const existing = await this.findMatchingSandbox();
    if (existing) {
      this.sandbox = existing;
      await existing.start();
      return;
    }

    const labels = this.getLabels();
    const autoStopInterval = this.options.idleTimeoutMs
      ? Math.max(1, Math.ceil(this.options.idleTimeoutMs / 60_000))
      : undefined;
    const autoDeleteInterval = this.options.autoStopMs
      ? Math.max(1, Math.ceil(this.options.autoStopMs / 60_000))
      : undefined;
    const image = resolveSandboxImage(this.options.image);
    const resources = resolveSandboxResources(this.options.resources);

    if (!image) {
      throw new Error(
        "daytona sandboxes require options.image to reference a prebuilt Daytona snapshot.",
      );
    }
    if (resources) {
      throw new Error(
        "daytona sandbox sizing is embedded in the image id and cannot be set via options.resources.",
      );
    }

    const createBase = {
      name: this.options.provider?.name,
      language: this.options.provider?.language ?? "typescript",
      user: this.options.provider?.user,
      envVars: this.getMergedEnv(),
      labels,
      public: this.options.provider?.public ?? true,
      autoStopInterval,
      autoDeleteInterval,
    };

    const sandbox = await this.client.create({
      ...createBase,
      snapshot: image,
    });

    await sandbox.start();
    this.sandbox = sandbox;
  }

  async run(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    await this.ensureProvisioned();
    const sandbox = this.requireSandbox();
    const result = await sandbox.process.executeCommand(
      toShellCommand(command),
      options?.cwd ?? this.workingDir,
      this.getMergedEnv(options?.env),
      options?.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined,
    );

    const output = result.result ?? "";
    return {
      exitCode: result.exitCode,
      stdout: output,
      stderr: output,
      combinedOutput: output,
      raw: result,
    };
  }

  async runAsync(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<AsyncCommandHandle> {
    await this.ensureProvisioned();
    const sandbox = this.requireSandbox();
    const sessionId = `agentbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await sandbox.process.createSession(sessionId);

    const response = await sandbox.process.executeSessionCommand(
      sessionId,
      {
        command: this.buildSessionCommand(command, options),
        runAsync: true,
      },
      options?.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined,
    );

    const commandId = response.cmdId;
    const queue = new AsyncQueue<CommandEvent>();
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    let killed = false;

    const streamLogs = sandbox.process.getSessionCommandLogs(
      sessionId,
      commandId,
      (chunk) => {
        stdout += chunk;
        queue.push({
          type: "stdout",
          chunk,
          timestamp: new Date().toISOString(),
        });
      },
      (chunk) => {
        stderr += chunk;
        queue.push({
          type: "stderr",
          chunk,
          timestamp: new Date().toISOString(),
        });
      },
    );

    const pollTimeoutMs = options?.timeoutMs ?? 0;
    const completion = (async () => {
      const pollStart = Date.now();
      while (true) {
        let status;
        try {
          status = await sandbox.process.getSessionCommand(
            sessionId,
            commandId,
          );
        } catch (error) {
          if (killed) {
            break;
          }
          throw error;
        }
        if (status.exitCode !== null && status.exitCode !== undefined) {
          if (!killed) {
            exitCode = status.exitCode;
          }
          break;
        }

        if (pollTimeoutMs > 0 && Date.now() - pollStart > pollTimeoutMs) {
          await sandbox.process.deleteSession(sessionId).catch(() => undefined);
          killed = true;
          exitCode = 130;
          break;
        }

        await sleep(500);
      }

      try {
        await streamLogs;
      } catch (error) {
        if (!killed) {
          throw error;
        }
      }
      queue.push({
        type: "exit",
        exitCode,
        timestamp: new Date().toISOString(),
      });
      queue.finish();

      return {
        exitCode,
        stdout,
        stderr,
        combinedOutput: `${stdout}${stderr}`,
        raw: { sessionId, commandId },
      } satisfies CommandResult;
    })().catch((error) => {
      queue.fail(error);
      throw error;
    });

    return {
      id: commandId,
      raw: { sessionId, commandId },
      wait: () => completion,
      kill: async () => {
        killed = true;
        exitCode = 130;
        await sandbox.process.deleteSession(sessionId).catch(() => undefined);
      },
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    };
  }

  async list(options?: SandboxListOptions): Promise<SandboxDescriptor[]> {
    const result = await this.client.list(options?.tags ?? this.getLabels());

    return result.items.map((sandbox) => ({
      provider: this.provider,
      id: sandbox.id,
      state: sandbox.state,
      tags: sandbox.labels ?? {},
      createdAt: sandbox.createdAt,
      raw: sandbox,
    }));
  }

  async snapshot(): Promise<string | null> {
    return null;
  }

  async stop(): Promise<void> {
    const sandbox = this.sandbox;
    if (!sandbox) {
      return;
    }

    await sandbox.stop();
    this.sandbox = undefined;
  }

  async delete(): Promise<void> {
    const sandbox = this.sandbox;
    if (!sandbox) {
      return;
    }

    await sandbox.delete();
    this.sandbox = undefined;
  }

  async openPort(port: number): Promise<void> {
    await this.ensureProvisioned();
    await this.requireSandbox().getPreviewLink(port);
  }

  async getPreviewLink(port: number): Promise<string> {
    await this.ensureProvisioned();
    const sandbox = this.requireSandbox();
    const preview = await sandbox.getPreviewLink(port);
    return preview.url;
  }

  private getLabels(): Record<string, string> {
    return {
      "agentbox.provider": this.provider,
      ...(this.options.tags ?? {}),
    };
  }

  private buildSessionCommand(
    command: string | string[],
    options?: CommandOptions,
  ): string {
    const statements: string[] = [];
    const cwd = options?.cwd ?? this.workingDir;
    const env = this.getMergedEnv(options?.env);

    if (cwd) {
      statements.push(`cd ${shellQuote(cwd)}`);
    }

    for (const [name, value] of Object.entries(env)) {
      statements.push(`export ${name}=${shellQuote(value)}`);
    }

    statements.push(toShellCommand(command));
    return statements.join(" && ");
  }

  private async findMatchingSandbox(): Promise<
    DaytonaSandboxObject | undefined
  > {
    const result = await this.client.list(this.getLabels());
    return result.items[0];
  }

  private requireSandbox(): DaytonaSandboxObject {
    if (!this.sandbox) {
      throw new Error("Daytona sandbox has not been provisioned.");
    }

    return this.sandbox;
  }
}
