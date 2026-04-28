import { Sandbox as VercelSandbox } from "@vercel/sandbox";

import { SandboxAdapter } from "../base";
import {
  SandboxProvider,
  type AsyncCommandHandle,
  type CommandEvent,
  type CommandOptions,
  type CommandResult,
  type SandboxDescriptor,
  type SandboxListOptions,
  type VercelSandboxOptions,
} from "../types";
import { AsyncQueue } from "../../shared/async-queue";
import { suppressUnhandledRejection } from "../../shared/errors";
import { toShellCommand } from "../../shared/shell";
import { resolveSandboxResources } from "../image-utils";

// @vercel/sandbox uses static-method-style API (VercelSandbox.create/list/get)
// so there is no client instance to expose — only the provisioned sandbox.
export type VercelRaw = {
  sandbox?: VercelSandbox;
};

// Vercel's list endpoint accepts at most ONE tag filter at a time
// (`bad_request: Only one tag filter is supported at a time`). To support
// the broader peer convention of filtering by multiple tags, we send the
// first entry server-side and intersect the rest client-side.
function pickFirstTag(
  tags: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!tags) return undefined;
  const entries = Object.entries(tags);
  if (entries.length === 0) return undefined;
  const [key, value] = entries[0]!;
  return { [key]: value };
}

function matchesAllTags(
  candidateTags: Record<string, string> | undefined,
  required: Record<string, string>,
): boolean {
  return Object.entries(required).every(
    ([key, value]) => candidateTags?.[key] === value,
  );
}

function describeVercelApiError(error: unknown, action: string): Error {
  if (
    error &&
    typeof error === "object" &&
    "response" in error &&
    error.response instanceof Response
  ) {
    const apiError = error as Error & {
      response: Response;
      json?: unknown;
      text?: string;
    };
    const status = apiError.response.status;
    const body =
      apiError.json !== undefined
        ? JSON.stringify(apiError.json)
        : (apiError.text ?? "");
    return new Error(
      `Vercel ${action} failed with HTTP ${status}: ${body || apiError.message}`,
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

async function wrapVercelApiError<T>(
  action: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw describeVercelApiError(error, action);
  }
}

function buildTimeoutSignal(
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return undefined;
  return AbortSignal.timeout(timeoutMs);
}

// `CommandOptions.pty` is not supported by the Vercel Sandbox SDK —
// `RunCommandParams` has no PTY flag. Callers that request it (e.g.
// claude-code) continue to work because they do not strictly require a
// TTY; we silently run non-PTY, matching daytona's behavior.

function getCredentials(options: VercelSandboxOptions) {
  const token = options.provider?.token ?? process.env.VERCEL_TOKEN;
  const teamId = options.provider?.teamId ?? process.env.VERCEL_TEAM_ID;
  const projectId =
    options.provider?.projectId ?? process.env.VERCEL_PROJECT_ID;

  if (token && teamId && projectId) {
    return { token, teamId, projectId };
  }

  return {};
}

export class VercelSandboxAdapter extends SandboxAdapter<
  "vercel",
  VercelSandboxOptions,
  VercelRaw
> {
  private sandbox?: VercelSandbox;

  get provider(): "vercel" {
    return SandboxProvider.Vercel;
  }

  get raw(): VercelRaw {
    return { sandbox: this.sandbox };
  }

  get id(): string | undefined {
    return this.sandbox?.name;
  }

  override get workingDir(): string {
    return this.options.workingDir ?? "/vercel/sandbox";
  }

  override get previewHeaders(): Record<string, string> {
    const token = this.options.provider?.protectionBypass;
    return token ? { "x-vercel-protection-bypass": token } : {};
  }

  protected async provision(): Promise<void> {
    const existing = await this.findExistingSandbox();
    if (existing) {
      this.sandbox = existing;
      return;
    }

    const credentials = getCredentials(this.options);
    const provider = this.options.provider;
    const snapshotId = provider?.snapshotId;
    const timeout = provider?.timeoutMs ?? 120_000;
    const runtime = provider?.runtime ?? "node24";
    const resources = resolveSandboxResources(this.options.resources);
    const vcpus = resources?.cpu ? { resources: { vcpus: resources.cpu } } : {};

    const base = {
      ...credentials,
      timeout,
      env: this.getMergedEnv(),
      ...vcpus,
      tags: this.getTags(),
      ...(provider?.ports?.length ? { ports: provider.ports } : {}),
    };

    const sandbox = await wrapVercelApiError("create sandbox", () => {
      if (snapshotId) {
        // Snapshot sources carry their own runtime; the Vercel SDK rejects
        // `runtime` alongside a snapshot source, so we don't forward it here.
        return VercelSandbox.create({
          ...base,
          source: { type: "snapshot", snapshotId },
        });
      }
      if (provider?.gitSource) {
        const git = provider.gitSource;
        const source = {
          type: "git" as const,
          url: git.url,
          depth: git.depth,
          revision: git.revision,
          ...(git.username && git.password
            ? { username: git.username, password: git.password }
            : {}),
        };
        return VercelSandbox.create({ ...base, runtime, source });
      }
      return VercelSandbox.create({ ...base, runtime });
    });

    this.sandbox = sandbox;
    if (this.workingDir !== "/vercel/sandbox") {
      await wrapVercelApiError("create working directory", () =>
        sandbox.runCommand({
          cmd: "mkdir",
          args: ["-p", this.workingDir],
          sudo: true,
        }),
      );
    }
  }

  async run(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    this.requireProvisioned();
    const sandbox = this.requireSandbox();

    const signal = buildTimeoutSignal(options?.timeoutMs);

    const result = await wrapVercelApiError("run command", () =>
      sandbox.runCommand({
        cmd: "sh",
        args: ["-lc", toShellCommand(command)],
        cwd: options?.cwd ?? this.workingDir,
        env: this.getMergedEnv(options?.env),
        ...(signal ? { signal } : {}),
      }),
    );

    const [stdout, stderr] = await Promise.all([
      result.stdout(),
      result.stderr(),
    ]);

    return {
      exitCode: result.exitCode,
      stdout,
      stderr,
      combinedOutput: `${stdout}${stderr}`,
      raw: result,
    };
  }

  async runAsync(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<AsyncCommandHandle> {
    this.requireProvisioned();
    const sandbox = this.requireSandbox();

    const signal = buildTimeoutSignal(options?.timeoutMs);

    const cmd = await wrapVercelApiError("start async command", () =>
      sandbox.runCommand({
        cmd: "sh",
        args: ["-lc", toShellCommand(command)],
        cwd: options?.cwd ?? this.workingDir,
        env: this.getMergedEnv(options?.env),
        detached: true,
        ...(signal ? { signal } : {}),
      }),
    );

    const queue = new AsyncQueue<CommandEvent>();
    let stdout = "";
    let stderr = "";

    const completion = (async () => {
      for await (const log of cmd.logs()) {
        if (log.stream === "stdout") {
          stdout += log.data;
          queue.push({
            type: "stdout",
            chunk: log.data,
            timestamp: new Date().toISOString(),
          });
        } else {
          stderr += log.data;
          queue.push({
            type: "stderr",
            chunk: log.data,
            timestamp: new Date().toISOString(),
          });
        }
      }

      const finished = await cmd.wait();
      const exitCode = finished.exitCode;

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
        raw: finished,
      } satisfies CommandResult;
    })().catch((error) => {
      queue.fail(error);
      throw error;
    });

    // Callers are not required to await `completion` (e.g. fire-and-forget
    // background processes) — attach a no-op rejection handler so Node does
    // not surface the error as an unhandled rejection. Consumers that do
    // await via `wait()` still observe the original error.
    suppressUnhandledRejection(completion);

    return {
      id: cmd.cmdId,
      raw: cmd,
      wait: () => completion,
      kill: async () => {
        await cmd.kill();
      },
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    };
  }

  async list(options?: SandboxListOptions): Promise<SandboxDescriptor[]> {
    const filterTags = options?.tags ?? this.getTags();
    const sandboxes = await this.listSandboxesByTags(filterTags);

    return sandboxes.map(
      (s: {
        name: string;
        status: string;
        createdAt: number;
        tags?: Record<string, string>;
      }) => ({
        provider: this.provider,
        id: s.name,
        state: s.status,
        tags: s.tags ?? {},
        createdAt: new Date(s.createdAt).toISOString(),
        raw: s,
      }),
    );
  }

  async snapshot(): Promise<string | null> {
    this.requireProvisioned();
    const sandbox = this.requireSandbox();
    const snap = await wrapVercelApiError("snapshot sandbox", () =>
      sandbox.snapshot(),
    );
    return snap.snapshotId;
  }

  async stop(): Promise<void> {
    const sandbox = this.sandbox;
    if (!sandbox) {
      return;
    }

    await wrapVercelApiError("stop sandbox", () => sandbox.stop());
    this.sandbox = undefined;
  }

  async delete(): Promise<void> {
    await this.stop();
  }

  async openPort(_port: number): Promise<void> {
    // Vercel sandboxes expose ports declared at create time via the SDK;
    // there is no runtime equivalent to Docker port publishing.
    void _port;
  }

  async getPreviewLink(port: number): Promise<string> {
    this.requireProvisioned();
    const sandbox = this.requireSandbox();
    return sandbox.domain(port);
  }

  async uploadFile(
    content: Buffer | string,
    targetPath: string,
  ): Promise<void> {
    this.requireProvisioned();
    const sandbox = this.requireSandbox();
    const data =
      typeof content === "string" ? content : new Uint8Array(content);
    await sandbox.writeFiles([{ path: targetPath, content: data }]);
  }

  async downloadFile(sourcePath: string): Promise<Buffer> {
    this.requireProvisioned();
    const sandbox = this.requireSandbox();
    const result = await sandbox.readFileToBuffer({ path: sourcePath });
    if (!result) {
      throw new Error(`File not found in Vercel sandbox: ${sourcePath}`);
    }
    return result;
  }

  private getTags(): Record<string, string> {
    return {
      "agentbox.provider": this.provider,
      ...(this.options.tags ?? {}),
    };
  }

  private async listSandboxesByTags(tags: Record<string, string>): Promise<
    Array<{
      name: string;
      status: string;
      createdAt: number;
      tags?: Record<string, string>;
    }>
  > {
    const credentials = getCredentials(this.options);
    const result = await wrapVercelApiError("list sandboxes", () =>
      VercelSandbox.list({
        ...credentials,
        tags: pickFirstTag(tags),
      }),
    );
    return result.sandboxes.filter((s: { tags?: Record<string, string> }) =>
      matchesAllTags(s.tags, tags),
    );
  }

  private async findExistingSandbox(): Promise<VercelSandbox | undefined> {
    const credentials = getCredentials(this.options);
    const sandboxes = await this.listSandboxesByTags(this.getTags());
    const match = sandboxes.find((s) => s.status === "running");
    if (!match) {
      return undefined;
    }
    return wrapVercelApiError("get sandbox", () =>
      VercelSandbox.get({ ...credentials, name: match.name }),
    );
  }

  private requireSandbox(): VercelSandbox {
    if (!this.sandbox) {
      throw new Error("Vercel sandbox has not been provisioned.");
    }

    return this.sandbox;
  }
}
