import path from "node:path";

import { ModalClient } from "modal";
import type { Image as ModalImage } from "modal";
import type { Sandbox as ModalSandboxObject } from "modal";

import { SandboxAdapter } from "../base";
import {
  SandboxProvider,
  type AsyncCommandHandle,
  type CommandEvent,
  type CommandOptions,
  type CommandResult,
  type ModalSandboxOptions,
  type SandboxDescriptor,
  type SandboxListOptions,
} from "../types";
import { AsyncQueue } from "../../shared/async-queue";
import { suppressUnhandledRejection } from "../../shared/errors";
import {
  pipeReadableStream,
  readStreamAsBytes,
  readStreamAsText,
} from "../../shared/streams";
import { shellQuote, toShellCommand } from "../../shared/shell";
import { resolveSandboxImage, resolveSandboxResources } from "../image-utils";
import { collectAllAgentReservedPorts } from "../../agents/ports";
import { buildTarball, type TarballEntry } from "../tarball";

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
  // Cached tunnel map. Populated on the first `getPreviewLink` call after
  // provision; reused on every subsequent call so the agent runtime path
  // doesn't re-issue the Modal RPC for each per-run tunnel lookup.
  private tunnelsPromise?: Promise<Record<number, { url: string }>>;

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
    return SandboxProvider.Modal;
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
      this.isWarmFlag = true;
      return;
    }

    const appName = this.options.provider?.appName ?? "agentbox";
    const app = await this.client.apps.fromName(appName, {
      createIfMissing: true,
      environment: this.options.provider?.environment,
    });
    const image = await this.resolveModalImage();
    const resources = resolveSandboxResources(this.options.resources);

    const unencryptedPorts = this.resolveDefaultUnencryptedPorts();

    const sandbox = await this.client.sandboxes.create(app, image, {
      ...this.options.provider?.createParams,
      cpu: resources?.cpu,
      memoryMiB: resources?.memoryMiB,
      timeoutMs: this.options.autoStopMs,
      idleTimeoutMs: this.options.idleTimeoutMs,
      workdir: this.workingDir,
      command: this.options.provider?.command ?? ["sleep", "infinity"],
      env: this.getMergedEnv(),
      encryptedPorts: this.options.provider?.encryptedPorts,
      unencryptedPorts,
      verbose: this.options.provider?.verbose,
    });

    await sandbox.setTags(this.getTags());
    this.sandbox = sandbox;
  }

  /**
   * Modal requires ports to be declared at sandbox creation time — a running
   * sandbox cannot gain new tunnels. To make `openPort` work predictably
   * across providers, we pre-declare all well-known agent-harness ports on
   * every Modal sandbox we create, unless the caller has explicitly pinned
   * them to a specific (possibly empty) list.
   */
  private resolveDefaultUnencryptedPorts(): number[] | undefined {
    const declared = this.options.provider?.unencryptedPorts;
    const encrypted = new Set(this.options.provider?.encryptedPorts ?? []);
    const reserved = collectAllAgentReservedPorts().filter(
      (port) => !encrypted.has(port),
    );

    if (declared === undefined) {
      return reserved.length > 0 ? reserved : undefined;
    }

    // Caller passed an explicit list — honor it but still include reserved
    // agent ports so agentbox's own harnesses keep working out of the box.
    const merged = new Set<number>(declared);
    for (const port of reserved) {
      merged.add(port);
    }
    return Array.from(merged);
  }

  async run(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    this.requireProvisioned();
    const sandbox = this.requireSandbox();
    const process = await sandbox.exec(
      ["/bin/sh", "-c", toShellCommand(command)],
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
    this.requireProvisioned();
    const sandbox = this.requireSandbox();
    const process = await sandbox.exec(
      ["/bin/sh", "-c", toShellCommand(command)],
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

    suppressUnhandledRejection(completion);

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

  /**
   * Upload `files` as a tarball piped through stdin to a single in-sandbox
   * `tar -x` invocation, then exec `command` — all in one Modal `exec`
   * round-trip. This collapses the typical "N writeArtifact RPCs +
   * runCommand" setup pattern (~25 RPCs on cold paths, ~6s wall) into a
   * single ~1s call dominated by the actual install work.
   */
  override async uploadAndRun(
    files: TarballEntry[],
    command: string,
    options?: CommandOptions,
  ): Promise<CommandResult> {
    this.requireProvisioned();
    const sandbox = this.requireSandbox();
    const tar = await buildTarball(files);

    // Extract from stdin (`tar -x -`) to absolute root (`-C /`); the entry
    // paths in the archive are absolute (with leading `/` stripped during
    // packing), so each file lands in its declared destination. Then run
    // the user-provided command. Both halves are wrapped in a single
    // `bash -c` invocation so the sandbox sees a single exec round-trip.
    //
    // We use binary mode so we can stream raw tar bytes through stdin.
    const wrapped = `set -e\ntar -xf - -C /\n${command}`;
    const process = await sandbox.exec(["/bin/sh", "-c", wrapped], {
      workdir: options?.cwd ?? this.workingDir,
      timeoutMs: options?.timeoutMs,
      env: this.getMergedEnv(options?.env),
      mode: "binary",
    });

    // Modal's `ModalWriteStream` extends `WritableStream`, which doesn't
    // expose `close()` directly. Acquire a default writer, push the tar
    // bytes, then close — that signals EOF to the sandbox-side `tar -x -`.
    const writer = (
      process.stdin as unknown as WritableStream<Uint8Array>
    ).getWriter();
    try {
      await writer.write(tar);
      await writer.close();
    } finally {
      try {
        writer.releaseLock();
      } catch {
        // Lock may already be released on close in some runtimes.
      }
    }

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

  /**
   * Upload `content` to `targetPath` inside the Modal sandbox.
   *
   * Modal's TS SDK only exposes a `Sandbox.open()` FileIO handle for direct
   * filesystem access, which is deprecated and capped at 100 MiB per
   * operation. To match the cross-provider semantics (works for arbitrarily
   * large artifacts, parent dirs are created on demand), we instead pipe
   * raw bytes through stdin into a single `mkdir -p … && cat > …` shell —
   * the same single-exec pattern `uploadAndRun` uses.
   */
  override async uploadFile(
    content: Buffer | string,
    targetPath: string,
  ): Promise<void> {
    this.requireProvisioned();
    const sandbox = this.requireSandbox();

    const data = Buffer.isBuffer(content)
      ? content
      : Buffer.from(content, "utf8");

    const dir = path.posix.dirname(targetPath);
    const wrapped =
      dir && dir !== "." && dir !== "/"
        ? `set -e; mkdir -p ${shellQuote(dir)}; cat > ${shellQuote(targetPath)}`
        : `set -e; cat > ${shellQuote(targetPath)}`;

    const proc = await sandbox.exec(["/bin/sh", "-c", wrapped], {
      mode: "binary",
    });

    const writer = (
      proc.stdin as unknown as WritableStream<Uint8Array>
    ).getWriter();
    try {
      await writer.write(data);
      await writer.close();
    } finally {
      try {
        writer.releaseLock();
      } catch {
        // Lock may already be released after close in some runtimes.
      }
    }

    const [stderrBytes, exitCode] = await Promise.all([
      readStreamAsBytes(proc.stderr),
      proc.wait(),
    ]);

    if (exitCode !== 0) {
      const stderr = stderrBytes.toString("utf8").trim();
      throw new Error(
        `Failed to upload file to Modal sandbox at ${targetPath} (exit ${exitCode})${
          stderr ? `: ${stderr}` : ""
        }`,
      );
    }
  }

  /**
   * Download a file from the Modal sandbox as raw bytes.
   *
   * Implemented by `cat`-ing the file in a binary-mode `exec` and
   * collecting stdout. This matches the cross-provider contract (returns a
   * Node `Buffer` of the file's exact bytes) and avoids the deprecated
   * 100 MiB FileIO cap on `Sandbox.open()`.
   */
  override async downloadFile(sourcePath: string): Promise<Buffer> {
    this.requireProvisioned();
    const sandbox = this.requireSandbox();

    const proc = await sandbox.exec(
      ["/bin/sh", "-c", `cat -- ${shellQuote(sourcePath)}`],
      { mode: "binary" },
    );

    const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
      readStreamAsBytes(proc.stdout),
      readStreamAsBytes(proc.stderr),
      proc.wait(),
    ]);

    if (exitCode !== 0) {
      const stderr = stderrBytes.toString("utf8").trim();
      throw new Error(
        `Failed to download file from Modal sandbox at ${sourcePath} (exit ${exitCode})${
          stderr ? `: ${stderr}` : ""
        }`,
      );
    }

    return stdoutBytes;
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
    this.requireProvisioned();
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
    this.tunnelsPromise = undefined;
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

    const alreadyDeclared = provider.unencryptedPorts?.includes(port) ?? false;
    if (!alreadyDeclared) {
      provider.unencryptedPorts = [...(provider.unencryptedPorts ?? []), port];
    }

    // If the sandbox is already running we can't retroactively punch a new
    // tunnel. Skip the round-trip when the port was declared up-front
    // (typical when callers pre-declare via `unencryptedPorts` or via
    // `AGENT_RESERVED_PORTS`).
    if (!this.sandbox) {
      return;
    }
    if (alreadyDeclared) {
      return;
    }

    // Port wasn't declared at creation time — verify the tunnel exists
    // (Modal might have surfaced one for us anyway) before failing loudly.
    try {
      if (!this.tunnelsPromise) {
        this.tunnelsPromise = this.sandbox.tunnels();
      }
      const tunnels = await this.tunnelsPromise;
      if (tunnels[port]) {
        return;
      }
    } catch {
      return;
    }

    throw new Error(
      `Modal sandbox is already running and cannot expose port ${port} dynamically. ` +
        `Declare it at creation time via \`provider.unencryptedPorts\` ` +
        `(e.g. \`provider: { unencryptedPorts: [${port}] }\`) or use ` +
        `\`AGENT_RESERVED_PORTS\` / \`collectAllAgentReservedPorts()\` ` +
        `from agentbox-sdk to pre-declare the agent harness ports.`,
    );
  }

  async getPreviewLink(port: number): Promise<string> {
    this.requireProvisioned();
    const sandbox = this.requireSandbox();
    if (!this.tunnelsPromise) {
      this.tunnelsPromise = sandbox.tunnels();
    }
    let tunnels: Record<number, { url: string }>;
    try {
      tunnels = await this.tunnelsPromise;
    } catch (error) {
      // Don't poison the cache on transient errors; force a fresh lookup
      // next time so callers can recover.
      this.tunnelsPromise = undefined;
      throw error;
    }
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

    const swallowGrpcShutdown = (reason: unknown) => {
      if (
        reason instanceof Error &&
        reason.message.includes("Channel has been shut down")
      ) {
        return;
      }
      throw reason;
    };
    process.on("unhandledRejection", swallowGrpcShutdown);
    try {
      this.client.close();
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch {
      // Ignore client shutdown errors during cleanup.
    } finally {
      process.off("unhandledRejection", swallowGrpcShutdown);
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
