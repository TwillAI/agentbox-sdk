import Docker from "dockerode";
import tar from "tar-stream";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";

import { SandboxAdapter } from "../base";
import {
  SandboxProvider,
  type AsyncCommandHandle,
  type CommandEvent,
  type CommandOptions,
  type CommandResult,
  type LocalDockerSandboxOptions,
  type SandboxDescriptor,
  type SandboxListOptions,
} from "../types";
import { AsyncQueue } from "../../shared/async-queue";
import { suppressUnhandledRejection } from "../../shared/errors";
import { readNodeStream } from "../../shared/streams";
import { toShellCommand } from "../../shared/shell";
import { resolveSandboxImage, resolveSandboxResources } from "../image-utils";
import { collectAllAgentReservedPorts } from "../../agents/ports";

export type DockerRaw = {
  client: Docker;
  container?: Docker.Container;
};

export class LocalDockerSandboxAdapter extends SandboxAdapter<
  "local-docker",
  LocalDockerSandboxOptions,
  DockerRaw
> {
  private readonly client = new Docker();
  private container?: Docker.Container;

  get provider(): "local-docker" {
    return SandboxProvider.LocalDocker;
  }

  get raw(): DockerRaw {
    return {
      client: this.client,
      container: this.container,
    };
  }

  get id(): string | undefined {
    return this.container?.id;
  }

  protected async provision(): Promise<void> {
    const existing = await this.findMatchingContainer();
    if (existing) {
      this.container = this.client.getContainer(existing.Id);
      if (existing.State !== "running") {
        await this.container.start();
      }
      return;
    }

    const normalizedImage = resolveSandboxImage(this.options.image);
    const image = await this.resolveContainerImage(normalizedImage);
    const resources = resolveSandboxResources(this.options.resources);

    const labels = this.getLabels();
    const env = Object.entries(this.getMergedEnv()).map(
      ([key, value]) => `${key}=${value}`,
    );
    const publishedPorts = this.resolveDefaultPublishedPorts();
    // Bind every published container port with `HostPort: ""` so Docker
    // assigns a fresh ephemeral host port for each one. This avoids host
    // port collisions when several local-docker sandboxes (or other
    // unrelated processes) want the same well-known agent ports
    // (43180 for claude-code, 4096 for opencode, etc.) at the same
    // time. The actual host port is recovered via `getPreviewLink`,
    // which inspects the container at call time.
    const portBindings =
      publishedPorts.length > 0
        ? Object.fromEntries(
            publishedPorts.map((port) => [
              `${port}/tcp`,
              [{ HostIp: "127.0.0.1", HostPort: "" }],
            ]),
          )
        : undefined;
    const exposedPorts =
      publishedPorts.length > 0
        ? Object.fromEntries(publishedPorts.map((port) => [`${port}/tcp`, {}]))
        : undefined;
    const container = await this.client.createContainer({
      Image: image,
      name: this.options.provider?.name,
      Cmd: this.options.provider?.command ?? ["sleep", "infinity"],
      WorkingDir: this.workingDir,
      Env: env,
      Labels: labels,
      Tty: false,
      OpenStdin: true,
      ...(exposedPorts ? { ExposedPorts: exposedPorts } : {}),
      HostConfig: {
        AutoRemove: this.options.provider?.autoRemove ?? false,
        Binds: this.options.provider?.binds,
        NetworkMode: this.options.provider?.networkMode,
        ExtraHosts: ["host.docker.internal:host-gateway"],
        ...(portBindings ? { PortBindings: portBindings } : {}),
        ...(resources?.cpu
          ? { NanoCpus: Math.round(resources.cpu * 1_000_000_000) }
          : {}),
        ...(resources?.memoryMiB
          ? { Memory: resources.memoryMiB * 1024 * 1024 }
          : {}),
      },
    });

    this.container = container;
    await container.start();
  }

  async run(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    this.requireProvisioned();
    const container = this.requireContainer();
    const exec = await container.exec({
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ["/bin/sh", "-lc", toShellCommand(command)],
      Env: this.toDockerEnv(options?.env),
      WorkingDir: options?.cwd ?? this.workingDir,
    });

    const stream = await exec.start({ hijack: true, stdin: false, Tty: false });
    const { stdout, stderr } = this.demuxExecStream(container, stream);

    const work = Promise.all([
      readNodeStream(stdout),
      readNodeStream(stderr),
      finished(stream),
    ]).then(([out, err]) => [out, err] as const);

    let result: readonly [Buffer, Buffer];
    if (options?.timeoutMs && options.timeoutMs > 0) {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`Command timed out after ${options.timeoutMs}ms.`),
            ),
          options.timeoutMs,
        ),
      );
      result = await Promise.race([work, timeout]);
    } else {
      result = await work;
    }

    const [stdoutBuffer, stderrBuffer] = result;
    const inspect = await exec.inspect();
    const stdoutText = stdoutBuffer.toString("utf8");
    const stderrText = stderrBuffer.toString("utf8");

    return {
      exitCode: inspect.ExitCode ?? 0,
      stdout: stdoutText,
      stderr: stderrText,
      combinedOutput: `${stdoutText}${stderrText}`,
      raw: { exec, inspect },
    };
  }

  async runAsync(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<AsyncCommandHandle> {
    this.requireProvisioned();
    const container = this.requireContainer();
    const exec = await container.exec({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ["/bin/sh", "-lc", toShellCommand(command)],
      Env: this.toDockerEnv(options?.env),
      WorkingDir: options?.cwd ?? this.workingDir,
      Tty: options?.pty ?? false,
    });

    const tty = options?.pty ?? false;
    const stream = await exec.start({ hijack: true, stdin: true, Tty: tty });
    const { stdout, stderr } = tty
      ? this.wrapTtyExecStream(stream)
      : this.demuxExecStream(container, stream);

    const queue = new AsyncQueue<CommandEvent>();
    let stdoutText = "";
    let stderrText = "";

    stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdoutText += text;
      queue.push({
        type: "stdout",
        chunk: text,
        timestamp: new Date().toISOString(),
      });
    });

    stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrText += text;
      queue.push({
        type: "stderr",
        chunk: text,
        timestamp: new Date().toISOString(),
      });
    });

    const completion = (async () => {
      await finished(stream);
      const inspect = await exec.inspect();
      const exitCode = inspect.ExitCode ?? 0;
      queue.push({
        type: "exit",
        exitCode,
        timestamp: new Date().toISOString(),
        raw: inspect,
      });
      queue.finish();

      return {
        exitCode,
        stdout: stdoutText,
        stderr: stderrText,
        combinedOutput: `${stdoutText}${stderrText}`,
        raw: { exec, inspect },
      } satisfies CommandResult;
    })().catch((error) => {
      queue.fail(error);
      throw error;
    });

    suppressUnhandledRejection(completion);

    return {
      id: exec.id,
      raw: { exec, stream },
      write: async (input: string) => {
        stream.write(input);
      },
      wait: () => completion,
      kill: async () => {
        try {
          stream.write("\u0003");
          stream.end();
        } catch {
          // Best effort only for Docker exec sessions.
        }
      },
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    };
  }

  private demuxExecStream(
    container: Docker.Container,
    stream: NodeJS.ReadableStream,
  ): { stdout: PassThrough; stderr: PassThrough } {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    container.modem.demuxStream(stream, stdout, stderr);

    const endOutputs = () => {
      stdout.end();
      stderr.end();
    };

    stream.on("end", endOutputs);
    stream.on("close", endOutputs);
    stream.on("error", (error) => {
      stdout.destroy(error);
      stderr.destroy(error);
    });

    return { stdout, stderr };
  }

  private wrapTtyExecStream(stream: NodeJS.ReadableStream): {
    stdout: PassThrough;
    stderr: PassThrough;
  } {
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    stream.on("data", (chunk) => {
      stdout.write(chunk);
    });
    stream.on("end", () => {
      stdout.end();
      stderr.end();
    });
    stream.on("close", () => {
      stdout.end();
      stderr.end();
    });
    stream.on("error", (error) => {
      stdout.destroy(error);
      stderr.destroy(error);
    });

    return { stdout, stderr };
  }

  async list(options?: SandboxListOptions): Promise<SandboxDescriptor[]> {
    const filters = {
      label: this.toDockerLabelFilters(options?.tags),
    };
    const containers = await this.client.listContainers({ all: true, filters });

    return containers.map((container) => ({
      provider: this.provider,
      id: container.Id,
      state: container.State,
      tags: container.Labels ?? {},
      raw: container,
    }));
  }

  async snapshot(): Promise<string | null> {
    return null;
  }

  async stop(): Promise<void> {
    const container = this.container;
    if (!container) {
      return;
    }

    await container.stop().catch(() => undefined);
  }

  async delete(): Promise<void> {
    const container = this.container;
    if (!container) {
      return;
    }

    await container.remove({ force: true }).catch(() => undefined);
    this.container = undefined;
  }

  async openPort(port: number): Promise<void> {
    const provider = this.options.provider ?? (this.options.provider = {});
    if (provider.networkMode === "host") {
      return;
    }

    provider.publishedPorts = provider.publishedPorts?.includes(port)
      ? provider.publishedPorts
      : [...(provider.publishedPorts ?? []), port];
  }

  async getPreviewLink(port: number): Promise<string> {
    const networkMode = this.options.provider?.networkMode;
    if (networkMode === "host") {
      return `http://127.0.0.1:${port}`;
    }

    const declared = this.resolveDefaultPublishedPorts();
    if (!declared.includes(port)) {
      throw new Error(
        `Port ${port} is not reachable from the host. Use local-docker provider.networkMode="host" or provider.publishedPorts to expose it.`,
      );
    }

    // The container was started with `HostPort: ""`, so Docker has
    // assigned a real ephemeral host port that we need to look up via
    // `inspect()`. This call is only made when the caller actually
    // needs a preview URL, so the inspect cost is bounded to the slow
    // path.
    const container = this.requireContainer();
    const inspect = await container.inspect();
    const portsMap = inspect.NetworkSettings?.Ports ?? {};
    const bindings = portsMap[`${port}/tcp`];
    const hostPort = Array.isArray(bindings)
      ? bindings.find((binding) => binding?.HostPort)?.HostPort
      : undefined;
    if (!hostPort) {
      throw new Error(
        `Port ${port} is not bound on the local-docker container. ` +
          `Make sure it is listed in provider.publishedPorts (or covered ` +
          `by AGENT_RESERVED_PORTS) before findOrProvision().`,
      );
    }
    return `http://127.0.0.1:${hostPort}`;
  }

  async uploadFile(
    content: Buffer | string,
    targetPath: string,
  ): Promise<void> {
    this.requireProvisioned();
    const container = this.requireContainer();
    const pack = tar.pack();
    const body = Buffer.isBuffer(content)
      ? content
      : Buffer.from(content, "utf8");
    pack.entry({ name: targetPath.replace(/^\/+/, "") }, body);
    pack.finalize();
    await container.putArchive(pack, { path: "/" });
  }

  async downloadFile(sourcePath: string): Promise<Buffer> {
    this.requireProvisioned();
    const container = this.requireContainer();
    const archive = await container.getArchive({ path: sourcePath });
    const chunks: Buffer[] = [];

    for await (const chunk of archive) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  private requireContainer(): Docker.Container {
    if (!this.container) {
      throw new Error("Docker container is not provisioned.");
    }

    return this.container;
  }

  /**
   * Local-docker requires ports to be declared at container creation
   * time (the `PortBindings` host config can't be amended on a running
   * container). To make `openPort` work predictably across providers,
   * we pre-publish all well-known agent-harness ports on every
   * local-docker sandbox we create — mirroring the Modal adapter's
   * `resolveDefaultUnencryptedPorts` behavior. Any explicit
   * `provider.publishedPorts` is honored AND merged with the reserved
   * set, so callers don't have to remember to list the agent's
   * default port for things like the claude-code SDK relay.
   *
   * Network-mode "host" containers don't use port bindings at all, so
   * we skip the merge in that case.
   */
  private resolveDefaultPublishedPorts(): number[] {
    if (this.options.provider?.networkMode === "host") {
      return [];
    }
    const declared = this.options.provider?.publishedPorts;
    const reserved = collectAllAgentReservedPorts();
    const merged = new Set<number>(declared ?? []);
    for (const port of reserved) {
      merged.add(port);
    }
    return Array.from(merged);
  }

  private getLabels(): Record<string, string> {
    return {
      "agentbox.provider": this.provider,
      ...(this.options.tags ?? {}),
    };
  }

  private toDockerEnv(extra?: Record<string, string>): string[] {
    return Object.entries(this.getMergedEnv(extra)).map(
      ([key, value]) => `${key}=${value}`,
    );
  }

  private toDockerLabelFilters(tags?: Record<string, string>): string[] {
    const labels = {
      "agentbox.provider": this.provider,
      ...(tags ?? {}),
    };

    return Object.entries(labels).map(([key, value]) => `${key}=${value}`);
  }

  private async findMatchingContainer(): Promise<
    Docker.ContainerInfo | undefined
  > {
    const containers = await this.client.listContainers({
      all: true,
      filters: { label: this.toDockerLabelFilters(this.options.tags) },
    });

    return containers[0];
  }

  private async pullImage(image: string): Promise<void> {
    const stream = await this.client.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.client.modem.followProgress(stream, (error: Error | null) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async resolveContainerImage(
    image: ReturnType<typeof resolveSandboxImage>,
  ): Promise<string> {
    if (!image) {
      throw new Error(
        "local-docker sandboxes require options.image to reference a local Docker image.",
      );
    }

    if (this.options.provider?.pull) {
      await this.pullImage(image);
    }
    return image;
  }
}
