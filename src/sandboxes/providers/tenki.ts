import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  TenkiSandbox as TenkiClient,
  type CreateOptions,
  type ProcessRunHandle,
  type ProcessRunResult,
  type Session,
} from "@tenkicloud/sandbox";

import { SandboxAdapter } from "../base";
import {
  SandboxProvider,
  type AsyncCommandHandle,
  type CommandEvent,
  type CommandOptions,
  type CommandResult,
  type SandboxDescriptor,
  type SandboxListOptions,
  type TenkiSandboxOptions,
} from "../types";
import { AsyncQueue } from "../../shared/async-queue";
import { asError, suppressUnhandledRejection } from "../../shared/errors";
import { pipeReadableStream } from "../../shared/streams";
import { shellQuote, toShellCommand } from "../../shared/shell";
import { resolveSandboxImage, resolveSandboxResources } from "../image-utils";

export type TenkiRaw = {
  client: TenkiClient;
  session?: Session;
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const TENKI_FS_ROOT = "/home/tenki";

function isUnderFsRoot(absolutePath: string): boolean {
  const normalized = path.posix.normalize(absolutePath);
  return (
    normalized === TENKI_FS_ROOT || normalized.startsWith(`${TENKI_FS_ROOT}/`)
  );
}

function shellArgv(command: string | string[]): string[] {
  return ["/bin/sh", "-lc", toShellCommand(command)];
}

function bytesToStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

const SESSION_GONE_ERRORS = new Set([
  "SessionNotFoundError",
  "SessionExpiredError",
  "SessionTerminatedError",
]);

const WARM_REUSABLE_STATES = new Set<string>([
  "RUNNING",
  "PAUSED",
  "CREATING",
  "RESUMING",
]);

const PREVIEW_EXPIRY_MARGIN_MS = 5_000;

function isSessionGone(error: unknown): boolean {
  return error instanceof Error && SESSION_GONE_ERRORS.has(error.name);
}

function matchesAllTags(
  candidate: Record<string, string> | undefined,
  required: Record<string, string>,
): boolean {
  return Object.entries(required).every(
    ([key, value]) => candidate?.[key] === value,
  );
}

export class TenkiSandboxAdapter extends SandboxAdapter<
  "tenki",
  TenkiSandboxOptions,
  TenkiRaw
> {
  private readonly client: TenkiClient;
  private session?: Session;
  private clientClosed = false;
  private readonly previewLinks = new Map<
    number,
    { url: string; expiresAtMs?: number }
  >();

  constructor(options: TenkiSandboxOptions) {
    super(options);

    const provider = options.provider;
    const authToken =
      provider?.apiKey ??
      provider?.authToken ??
      process.env.TENKI_API_KEY ??
      process.env.TENKI_AUTH_TOKEN;

    this.client = new TenkiClient({
      ...(authToken ? { authToken } : {}),
      ...(provider?.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    });
  }

  get provider(): "tenki" {
    return SandboxProvider.Tenki;
  }

  get raw(): TenkiRaw {
    return {
      client: this.client,
      session: this.session,
    };
  }

  get id(): string | undefined {
    return this.session?.id;
  }

  override get workingDir(): string {
    return this.options.workingDir ?? TENKI_FS_ROOT;
  }

  protected async provision(): Promise<void> {
    const tags = this.getTags();

    const existing = await this.findMatchingSession(tags);
    if (existing) {
      this.session = existing;
      this.isWarmFlag = true;
      if (existing.state === "PAUSED") {
        await existing.resume();
      } else if (existing.state !== "RUNNING") {
        await existing.waitReady();
      }
      return;
    }

    const provider = this.options.provider;
    const resources = resolveSandboxResources(this.options.resources);

    const createOptions: CreateOptions = {
      ...(provider?.createParams ?? {}),
      allowInbound: provider?.allowInbound ?? true,
      allowOutbound: provider?.allowOutbound ?? true,
      env: this.getMergedEnv(),
      metadata: tags,
      tags: [this.providerMarker()],
    };

    createOptions.name =
      provider?.name ?? `agentbox-${randomUUID().slice(0, 8)}`;
    const cpuCores = provider?.cpuCores ?? resources?.cpu;
    if (cpuCores !== undefined) {
      createOptions.cpuCores = cpuCores;
    }
    const memoryMb = provider?.memoryMb ?? resources?.memoryMiB;
    if (memoryMb !== undefined) {
      createOptions.memoryMb = memoryMb;
    }
    if (provider?.sshAuthorizedKeys !== undefined) {
      createOptions.sshAuthorizedKeys = provider.sshAuthorizedKeys;
    }
    const image = resolveSandboxImage(this.options.image);
    if (image !== undefined) {
      createOptions.image = image;
    }
    if (provider?.snapshotId !== undefined) {
      createOptions.snapshotId = provider.snapshotId;
    }
    if (this.options.idleTimeoutMs !== undefined) {
      createOptions.idleTimeoutMinutes = Math.max(
        1,
        Math.ceil(this.options.idleTimeoutMs / 60_000),
      );
    }
    if (this.options.autoStopMs !== undefined) {
      createOptions.maxDurationMs = this.options.autoStopMs;
    }

    if (provider?.workspaceId !== undefined) {
      createOptions.workspaceId = provider.workspaceId;
    }

    const session = await this.client.createAndWait(createOptions);
    this.session = session;

    if (this.workingDir !== TENKI_FS_ROOT) {
      try {
        const dir = shellQuote(this.workingDir);
        const result = await session.run(
          [
            "/bin/sh",
            "-c",
            `mkdir -p ${dir} && chown --reference=${TENKI_FS_ROOT} ${dir}`,
          ],
          { privileged: true },
        );
        if (result.exitCode !== 0) {
          throw new Error(
            `Failed to create Tenki working directory ${this.workingDir} ` +
              `(exit ${result.exitCode}): ${decoder.decode(result.stderr).trim()}`,
          );
        }
      } catch (error) {
        this.session = undefined;
        await session.close().catch(() => undefined);
        throw asError(error);
      }
    }
  }

  async run(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    this.requireProvisioned();
    const session = this.requireSession();

    const handle = session.run(shellArgv(command), {
      cwd: options?.cwd ?? this.workingDir,
      env: this.getMergedEnv(options?.env),
    });

    const result = await this.awaitHandle(handle, command, options?.timeoutMs);
    const stdout = decoder.decode(result.stdout);
    const stderr = decoder.decode(result.stderr);

    return {
      exitCode: result.exitCode,
      stdout,
      stderr,
      combinedOutput: `${stdout}${stderr}`,
      raw: result,
    };
  }

  private async awaitHandle(
    handle: ProcessRunHandle,
    command: string | string[],
    timeoutMs: number | undefined,
  ): Promise<ProcessRunResult> {
    if (!timeoutMs || timeoutMs <= 0) {
      return handle;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void handle.kill().catch(() => undefined);
        reject(
          new Error(
            `Tenki command timed out after ${timeoutMs}ms: ${toShellCommand(command)}`,
          ),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([handle, timeout]);
    } catch (error) {
      throw asError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async runAsync(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<AsyncCommandHandle> {
    this.requireProvisioned();
    const session = this.requireSession();

    const handle = session.run(shellArgv(command), {
      cwd: options?.cwd ?? this.workingDir,
      env: this.getMergedEnv(options?.env),
    });

    const queue = new AsyncQueue<CommandEvent>();
    let stdout = "";
    let stderr = "";

    const stdoutPump = pipeReadableStream(handle.stdout, (chunk) => {
      stdout += chunk;
      queue.push({
        type: "stdout",
        chunk,
        timestamp: new Date().toISOString(),
      });
    });

    const stderrPump = pipeReadableStream(handle.stderr, (chunk) => {
      stderr += chunk;
      queue.push({
        type: "stderr",
        chunk,
        timestamp: new Date().toISOString(),
      });
    });

    const completion = Promise.all([stdoutPump, stderrPump, handle])
      .then(([, , result]) => {
        queue.push({
          type: "exit",
          exitCode: result.exitCode,
          timestamp: new Date().toISOString(),
        });
        queue.finish();

        return {
          exitCode: result.exitCode,
          stdout,
          stderr,
          combinedOutput: `${stdout}${stderr}`,
          raw: result,
        } satisfies CommandResult;
      })
      .catch((error) => {
        queue.fail(error);
        throw error;
      });

    suppressUnhandledRejection(completion);

    let killedResolve: ((result: CommandResult) => void) | undefined;
    let timeoutReject: ((error: Error) => void) | undefined;
    const settledEarly = new Promise<CommandResult>((resolve, reject) => {
      killedResolve = resolve;
      timeoutReject = reject;
    });
    const settled = Promise.race([completion, settledEarly]);
    suppressUnhandledRejection(settled);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    void completion.then(clearTimer, clearTimer);

    const timeoutMs = options?.timeoutMs;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        void handle.kill().catch(() => undefined);
        const error = new Error(
          `Tenki command timed out after ${timeoutMs}ms: ${toShellCommand(command)}`,
        );
        queue.fail(error);
        timeoutReject?.(error);
      }, timeoutMs);
    }

    let stdinWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;

    return {
      id: `${session.id}:${Date.now()}`,
      raw: handle,
      write: async (input: string) => {
        if (!stdinWriter) {
          stdinWriter = handle.stdin.getWriter();
        }
        await stdinWriter.write(encoder.encode(input));
      },
      wait: () => settled,
      kill: async () => {
        clearTimer();
        await handle.kill().catch(() => undefined);
        queue.push({
          type: "exit",
          exitCode: 137,
          timestamp: new Date().toISOString(),
        });
        queue.finish();
        killedResolve?.({
          exitCode: 137,
          stdout,
          stderr,
          combinedOutput: `${stdout}${stderr}`,
          raw: handle,
        });
      },
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    };
  }

  override async uploadFile(
    content: Buffer | string,
    targetPath: string,
  ): Promise<void> {
    this.requireProvisioned();
    const session = this.requireSession();
    const target = this.resolveSandboxPath(targetPath);
    const data =
      typeof content === "string"
        ? encoder.encode(content)
        : new Uint8Array(content);

    if (isUnderFsRoot(target)) {
      await session.writeFile(target, data);
      return;
    }

    const dir = path.posix.dirname(target);
    const result = await session.run(
      [
        "/bin/sh",
        "-c",
        `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(target)}`,
      ],
      { stdin: bytesToStream(data) },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to upload file to Tenki sandbox at ${target} ` +
          `(exit ${result.exitCode}): ${decoder.decode(result.stderr).trim()}`,
      );
    }
  }

  override async downloadFile(sourcePath: string): Promise<Buffer> {
    this.requireProvisioned();
    const session = this.requireSession();
    const source = this.resolveSandboxPath(sourcePath);

    if (isUnderFsRoot(source)) {
      return Buffer.from(await session.readFile(source));
    }

    const result = await session.run([
      "/bin/sh",
      "-c",
      `cat -- ${shellQuote(source)}`,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to download file from Tenki sandbox at ${source} ` +
          `(exit ${result.exitCode}): ${decoder.decode(result.stderr).trim()}`,
      );
    }
    return Buffer.from(result.stdout);
  }

  private resolveSandboxPath(filePath: string): string {
    return path.posix.isAbsolute(filePath)
      ? filePath
      : path.posix.join(this.workingDir, filePath);
  }

  async list(options?: SandboxListOptions): Promise<SandboxDescriptor[]> {
    const filterTags = options?.tags ?? this.getTags();
    const sessions = await this.client.list({ tags: [this.providerMarker()] });

    return sessions
      .filter((session) => matchesAllTags(session.metadata, filterTags))
      .map((session) => ({
        provider: this.provider,
        id: session.id,
        state: session.state,
        tags: { ...session.metadata },
        raw: session,
      }));
  }

  async snapshot(): Promise<string | null> {
    this.requireProvisioned();
    const session = this.requireSession();
    const snap = await this.client.createSnapshotAndWait(session.id);
    return snap.id ?? null;
  }

  async stop(): Promise<void> {
    if (this.session) {
      await this.session.pause();
    }
  }

  async delete(): Promise<void> {
    const session = this.session;
    if (session) {
      try {
        await session.close();
      } catch (error) {
        if (!isSessionGone(error)) {
          throw asError(error);
        }
      }
      this.session = undefined;
      this.previewLinks.clear();
    }
    this.closeClient();
  }

  async openPort(port: number): Promise<void> {
    this.requireProvisioned();
    await this.exposePreviewLink(port);
  }

  async getPreviewLink(port: number): Promise<string> {
    this.requireProvisioned();
    const cached = this.previewLinks.get(port);
    if (
      cached &&
      (cached.expiresAtMs === undefined ||
        cached.expiresAtMs - PREVIEW_EXPIRY_MARGIN_MS > Date.now())
    ) {
      return cached.url;
    }
    return this.exposePreviewLink(port);
  }

  private async exposePreviewLink(port: number): Promise<string> {
    const session = this.requireSession();
    const ttlMs = this.options.provider?.previewTtlMs;
    const exposed = await session.exposePort(
      port,
      ttlMs ? { ttlMs } : undefined,
    );
    const expiresAtMs =
      exposed.expiresAt?.getTime() ?? (ttlMs ? Date.now() + ttlMs : undefined);
    this.previewLinks.set(port, { url: exposed.previewUrl, expiresAtMs });
    return exposed.previewUrl;
  }

  private async findMatchingSession(
    desiredTags: Record<string, string>,
  ): Promise<Session | undefined> {
    const sessions = await this.client.list({
      tags: [this.providerMarker()],
    });
    return sessions.find(
      (session) =>
        WARM_REUSABLE_STATES.has(session.state) &&
        matchesAllTags(session.metadata, desiredTags),
    );
  }

  private getTags(): Record<string, string> {
    return {
      "agentbox.provider": this.provider,
      ...(this.options.tags ?? {}),
    };
  }

  private providerMarker(): string {
    return `agentbox.provider:${this.provider}`;
  }

  private closeClient(): void {
    if (this.clientClosed) {
      return;
    }
    this.clientClosed = true;
    try {
      this.client.close();
    } catch {
      return;
    }
  }

  private requireSession(): Session {
    if (!this.session) {
      throw new Error("Tenki sandbox has not been provisioned.");
    }
    return this.session;
  }
}
