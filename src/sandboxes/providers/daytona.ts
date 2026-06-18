import { Daytona, type Sandbox as DaytonaSandboxObject } from "@daytonaio/sdk";

import { SandboxAdapter } from "../base";
import {
  SandboxProvider,
  type AsyncCommandHandle,
  type CommandEvent,
  type CommandOptions,
  type CommandResult,
  type DaytonaSandboxOptions,
  type SandboxDescriptor,
  type SandboxListOptions,
} from "../types";
import { AsyncQueue } from "../../shared/async-queue";
import { suppressUnhandledRejection } from "../../shared/errors";
import { sleep } from "../../shared/network";
import { shellQuote, toShellCommand } from "../../shared/shell";
import { resolveSandboxImage, resolveSandboxResources } from "../image-utils";

export type DaytonaRaw = {
  client: Daytona;
  sandbox?: DaytonaSandboxObject;
};

// Stable states where `start()` is the right move (the sandbox is at rest).
const STARTABLE_STATES = new Set<string>(["stopped", "archived"]);
// Terminal states — there's no recovering by waiting; fail fast.
const TERMINAL_STATES = new Set<string>([
  "error",
  "build_failed",
  "destroyed",
  "destroying",
]);
// Any other non-"started" state (creating, starting, restoring, stopping,
// snapshotting, forking, pulling_snapshot, resizing, …) is an in-flight
// transition: calling `start()` during it makes Daytona 409 with "Sandbox
// state change in progress", so we wait it out instead.

const ATTACH_SETTLE_TIMEOUT_MS = 120_000;
const ATTACH_POLL_INTERVAL_MS = 2_000;

/**
 * Detect Daytona's 409 "Sandbox state change in progress" conflict, raised
 * when `start()`/`stop()` races a transition that's already underway. Matches
 * the structured error (statusCode / name) and a message fallback in case the
 * error class doesn't survive a re-throw across module boundaries.
 */
function isStateChangeInProgressError(err: unknown): boolean {
  const e = err as
    | { statusCode?: number; name?: string; message?: string }
    | undefined;
  if (!e) return false;
  return (
    e.statusCode === 409 ||
    e.name === "DaytonaConflictError" ||
    /state change in progress/i.test(e.message ?? "")
  );
}

export class DaytonaSandboxAdapter extends SandboxAdapter<
  "daytona",
  DaytonaSandboxOptions,
  DaytonaRaw
> {
  private readonly client: Daytona;
  private sandbox?: DaytonaSandboxObject;
  /**
   * Per-sandbox preview access token, captured from `getPreviewLink`.
   * Daytona's preview proxy now requires this token to reach a sandbox's
   * ports: unauthenticated requests get 307-redirected to an Auth0 login
   * (which surfaces as a 307 on WebSocket upgrades and a 404 on plain GETs).
   * The token is sandbox-level and stable across ports, so caching the most
   * recent one is sufficient — every consumer calls `getPreviewLink` to build
   * the URL right before reading `previewHeaders`. See {@link previewHeaders}.
   */
  private previewToken?: string;

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
    return SandboxProvider.Daytona;
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

  protected async attachExisting(id: string): Promise<void> {
    const existing = await this.client.get(id);
    if (!existing) {
      throw new Error(`Daytona sandbox ${id} not found`);
    }
    this.sandbox = existing;
    this.isWarmFlag = (existing.state as string | undefined) === "started";
    await this.ensureStarted(existing);
  }

  /**
   * Bring a sandbox to the `started` state, tolerating in-flight transitions.
   *
   * `start()` only works from a resting state (`stopped`/`archived`); calling
   * it while the sandbox is creating/starting/restoring/snapshotting/etc. — or
   * racing another caller that's already starting it — makes Daytona 409 with
   * "Sandbox state change in progress". So we poll: start from a resting
   * state, wait out a transition, fail fast on a terminal state, and treat a
   * 409 as "someone else is mid-transition" and keep waiting.
   */
  private async ensureStarted(sandbox: DaytonaSandboxObject): Promise<void> {
    let current = sandbox;
    const deadline = Date.now() + ATTACH_SETTLE_TIMEOUT_MS;
    for (;;) {
      const state = (current.state as string | undefined) ?? "unknown";
      if (state === "started") return;
      if (TERMINAL_STATES.has(state)) {
        throw new Error(
          `Daytona sandbox ${current.id} is in a terminal state: ${state}`,
        );
      }
      if (STARTABLE_STATES.has(state)) {
        try {
          await current.start();
          return;
        } catch (err) {
          if (!isStateChangeInProgressError(err)) throw err;
          // Raced an in-flight transition — fall through to polling.
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for Daytona sandbox ${current.id} to start (state=${state})`,
        );
      }
      await sleep(ATTACH_POLL_INTERVAL_MS);
      current = await this.client.get(current.id);
      this.sandbox = current;
    }
  }

  protected async provision(): Promise<void> {
    const existing = await this.findMatchingSandbox();
    if (existing) {
      this.sandbox = existing;
      this.isWarmFlag = existing.state === "started";
      await this.ensureStarted(existing);
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
      ...this.options.provider?.createParams,
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
    this.requireProvisioned();
    const sandbox = this.requireSandbox();
    // Daytona's `executeCommand(cmd, cwd, envVars, timeout)` silently
    // drops `envVars` — observed empirically (variables are missing from
    // both the immediate process env and any nohup'd subshell). We
    // inline `export NAME='value'` statements ahead of the command so
    // env vars actually reach the process. Matches `buildSessionCommand`
    // for `runAsync`.
    const result = await sandbox.process.executeCommand(
      this.buildSessionCommand(command, options),
      options?.cwd ?? this.workingDir,
      undefined,
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
    this.requireProvisioned();
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

    suppressUnhandledRejection(completion);

    return {
      id: commandId,
      raw: { sessionId, commandId },
      write: async (input: string) => {
        await sandbox.process.sendSessionCommandInput(
          sessionId,
          commandId,
          input,
        );
      },
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
    this.requireProvisioned();
    const preview = await this.requireSandbox().getPreviewLink(port);
    this.previewToken = preview.token;
  }

  /**
   * Headers callers must attach to HTTP/WebSocket requests against this
   * sandbox's preview URLs. Daytona private sandboxes gate their preview
   * proxy behind `x-daytona-preview-token`; without it the proxy 307-redirects
   * to Auth0, which breaks every provider (claude-code `/start` 404, codex WS
   * "307", opencode `/session` 404). The token is captured lazily from
   * `getPreviewLink`/`openPort`, both of which every consumer calls to build
   * the URL immediately before reading these headers.
   */
  override get previewHeaders(): Record<string, string> {
    return this.previewToken
      ? { "x-daytona-preview-token": this.previewToken }
      : {};
  }

  async getPreviewLink(port: number): Promise<string> {
    this.requireProvisioned();
    const sandbox = this.requireSandbox();
    const preview = await sandbox.getPreviewLink(port);
    this.previewToken = preview.token;
    return preview.url;
  }

  async uploadFile(
    content: Buffer | string,
    targetPath: string,
  ): Promise<void> {
    this.requireProvisioned();
    const sandbox = this.requireSandbox();
    const buffer = Buffer.isBuffer(content)
      ? content
      : Buffer.from(content, "utf8");
    await sandbox.fs.uploadFile(buffer, targetPath);
  }

  async downloadFile(sourcePath: string): Promise<Buffer> {
    this.requireProvisioned();
    const sandbox = this.requireSandbox();
    return sandbox.fs.downloadFile(sourcePath);
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
