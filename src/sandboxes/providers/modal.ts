import { ModalClient } from "modal";
import type { Image as ModalImage } from "modal";
import type { Sandbox as ModalSandboxObject } from "modal";

import { SandboxAdapter } from "../base";
import type {
  AsyncCommandHandle,
  CommandEvent,
  CommandOptions,
  CommandResult,
  ModalSandboxOptions,
  SandboxDescriptor,
  SandboxListOptions,
} from "../types";
import { AsyncQueue } from "../../shared/async-queue";
import { pipeReadableStream, readStreamAsText } from "../../shared/streams";
import { toShellCommand } from "../../shared/shell";
import { resolveSandboxImage, resolveSandboxResources } from "../image-utils";

export type ModalRaw = {
  client: ModalClient;
  sandbox?: ModalSandboxObject;
};

export class ModalSandboxAdapter extends SandboxAdapter<
  "modal",
  ModalSandboxOptions,
  ModalRaw
> {
  private readonly client: ModalClient;
  private sandbox?: ModalSandboxObject;
  private clientClosed = false;

  constructor(options: ModalSandboxOptions) {
    super(options);

    this.client = new ModalClient({
      tokenId: options.provider?.tokenId,
      tokenSecret: options.provider?.tokenSecret,
      environment: options.provider?.environment,
      endpoint: options.provider?.endpoint,
    });
  }

  get provider(): "modal" {
    return "modal";
  }

  get raw(): ModalRaw {
    return {
      client: this.client,
      sandbox: this.sandbox,
    };
  }

  get id(): string | undefined {
    return this.sandbox?.sandboxId;
  }

  protected async provision(): Promise<void> {
    const existing = await this.findMatchingSandbox();
    if (existing) {
      this.sandbox = existing;
      return;
    }

    const appName = this.options.provider?.appName ?? "agentbox";
    const app = await this.client.apps.fromName(appName, {
      createIfMissing: true,
      environment: this.options.provider?.environment,
    });
    const image = await this.resolveModalImage();
    const resources = resolveSandboxResources(this.options.resources);

    const sandbox = await this.client.sandboxes.create(app, image, {
      cpu: resources?.cpu,
      memoryMiB: resources?.memoryMiB,
      timeoutMs: this.options.autoStopMs,
      idleTimeoutMs: this.options.idleTimeoutMs,
      workdir: this.workingDir,
      command: this.options.provider?.command ?? ["sleep", "infinity"],
      env: this.getMergedEnv(),
      encryptedPorts: this.options.provider?.encryptedPorts,
      unencryptedPorts: this.options.provider?.unencryptedPorts,
      verbose: this.options.provider?.verbose,
    });

    await sandbox.setTags(this.getTags());
    this.sandbox = sandbox;
  }

  async run(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    await this.ensureProvisioned();
    const sandbox = this.requireSandbox();
    const process = await sandbox.exec(
      ["/bin/sh", "-lc", toShellCommand(command)],
      {
        workdir: options?.cwd ?? this.workingDir,
        timeoutMs: options?.timeoutMs,
        env: this.getMergedEnv(options?.env),
        pty: options?.pty,
        mode: "text",
      },
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      readStreamAsText(process.stdout),
      readStreamAsText(process.stderr),
      process.wait(),
    ]);

    return {
      exitCode,
      stdout,
      stderr,
      combinedOutput: `${stdout}${stderr}`,
      raw: process,
    };
  }

  async runAsync(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<AsyncCommandHandle> {
    await this.ensureProvisioned();
    const sandbox = this.requireSandbox();
    const process = await sandbox.exec(
      ["/bin/sh", "-lc", toShellCommand(command)],
      {
        workdir: options?.cwd ?? this.workingDir,
        timeoutMs: options?.timeoutMs,
        env: this.getMergedEnv(options?.env),
        pty: options?.pty,
        mode: "text",
      },
    );

    const queue = new AsyncQueue<CommandEvent>();
    let stdout = "";
    let stderr = "";

    const stdoutPump = pipeReadableStream(process.stdout, (chunk) => {
      stdout += chunk;
      queue.push({
        type: "stdout",
        chunk,
        timestamp: new Date().toISOString(),
      });
    });

    const stderrPump = pipeReadableStream(process.stderr, (chunk) => {
      stderr += chunk;
      queue.push({
        type: "stderr",
        chunk,
        timestamp: new Date().toISOString(),
      });
    });

    const completion = Promise.all([stdoutPump, stderrPump, process.wait()])
      .then(([, , exitCode]) => {
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
          raw: process,
        } satisfies CommandResult;
      })
      .catch((error) => {
        queue.fail(error);
        throw error;
      });

    return {
      id: `${sandbox.sandboxId}:${Date.now()}`,
      raw: process,
      write: async (input: string) => {
        await process.stdin.writeText(input);
      },
      wait: () => completion,
      kill: async () => {
        try {
          await process.stdin.writeText("\u0003");
        } catch {
          // Modal exec processes do not expose a dedicated kill API.
        }
      },
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    };
  }

  async list(options?: SandboxListOptions): Promise<SandboxDescriptor[]> {
    const sandboxes: SandboxDescriptor[] = [];

    for await (const sandbox of this.client.sandboxes.list({
      tags: options?.tags ?? this.tags,
    })) {
      sandboxes.push({
        provider: this.provider,
        id: sandbox.sandboxId,
        state: (await sandbox.poll()) === null ? "running" : "finished",
        tags: await sandbox.getTags(),
        raw: sandbox,
      });
    }

    return sandboxes;
  }

  async snapshot(): Promise<string | null> {
    await this.ensureProvisioned();
    const sandbox = this.requireSandbox();
    const image = await sandbox.snapshotFilesystem();
    return image.imageId;
  }

  async stop(): Promise<void> {
    const sandbox = this.sandbox;
    if (!sandbox) {
      return;
    }

    await sandbox.terminate();
    this.sandbox = undefined;
  }

  async delete(): Promise<void> {
    await this.stop();
    await this.closeClient();
  }

  async openPort(port: number): Promise<void> {
    const provider = this.options.provider ?? (this.options.provider = {});
    if (provider.encryptedPorts?.includes(port)) {
      return;
    }

    provider.unencryptedPorts = provider.unencryptedPorts?.includes(port)
      ? provider.unencryptedPorts
      : [...(provider.unencryptedPorts ?? []), port];
  }

  async getPreviewLink(port: number): Promise<string> {
    await this.ensureProvisioned();
    const sandbox = this.requireSandbox();
    const tunnels = await sandbox.tunnels();
    const tunnel = tunnels[port];
    if (!tunnel) {
      throw new Error(`Modal sandbox does not expose port ${port}.`);
    }

    return tunnel.url;
  }

  private async findMatchingSandbox(): Promise<ModalSandboxObject | undefined> {
    for await (const sandbox of this.client.sandboxes.list({
      tags: this.getTags(),
    })) {
      return sandbox;
    }

    return undefined;
  }

  private getTags(): Record<string, string> {
    return {
      "agentbox.provider": this.provider,
      ...(this.options.tags ?? {}),
    };
  }

  private async closeClient(): Promise<void> {
    if (this.clientClosed) {
      return;
    }

    this.clientClosed = true;
    try {
      this.client.close();
    } catch {
      // Ignore client shutdown errors during cleanup.
    }
  }

  private requireSandbox(): ModalSandboxObject {
    if (!this.sandbox) {
      throw new Error("Modal sandbox has not been provisioned.");
    }

    return this.sandbox;
  }

  private async resolveModalImage(): Promise<ModalImage> {
    const image = resolveSandboxImage(this.options.image);
    if (!image) {
      throw new Error(
        "modal sandboxes require options.image to reference an existing Modal image id.",
      );
    }
    return this.client.images.fromId(image);
  }
}
