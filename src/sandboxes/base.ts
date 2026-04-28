import type {
  AsyncCommandHandle,
  CommandOptions,
  CommandResult,
  GitCloneOptions,
  SandboxDescriptor,
  SandboxListOptions,
  SandboxOptions,
  SandboxProviderName,
} from "./types";
import type { TarballEntry } from "./tarball";
import { buildGitCloneCommand } from "./git";
import { shellQuote } from "../shared/shell";
import { debugSandbox, time } from "../shared/debug";

export abstract class SandboxAdapter<
  TProvider extends SandboxProviderName = SandboxProviderName,
  TOptions extends SandboxOptions<TProvider> = SandboxOptions<TProvider>,
  TRaw = unknown,
> {
  protected readonly options: TOptions;
  protected readonly secrets: Record<string, string> = {};
  protected readonly baseEnv: Record<string, string>;
  private provisioned = false;
  private provisioning?: Promise<void>;
  /**
   * Whether `provision()` warm-attached to a pre-existing tagged sandbox
   * (true) or had to create a fresh one (false). Set by adapter
   * `provision()` implementations. Stays `false` until `findOrProvision()`
   * has resolved.
   */
  protected wasFoundFlag = false;

  constructor(options: TOptions) {
    this.options = options;
    this.baseEnv = { ...(options.env ?? {}) };
  }

  abstract get provider(): TProvider;
  abstract get raw(): TRaw | undefined;
  abstract get id(): string | undefined;

  protected abstract provision(): Promise<void>;
  abstract run(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
  abstract runAsync(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<AsyncCommandHandle>;
  abstract list(options?: SandboxListOptions): Promise<SandboxDescriptor[]>;
  abstract snapshot(): Promise<string | null>;
  abstract stop(): Promise<void>;
  abstract delete(): Promise<void>;
  abstract openPort(port: number): Promise<void>;
  abstract getPreviewLink(port: number): Promise<string>;

  async uploadFile(
    _content: Buffer | string,
    _targetPath: string,
  ): Promise<void> {
    void _content;
    void _targetPath;
    throw new Error(
      `uploadFile is not supported by the ${this.provider} provider.`,
    );
  }

  async downloadFile(_sourcePath: string): Promise<Buffer> {
    void _sourcePath;
    throw new Error(
      `downloadFile is not supported by the ${this.provider} provider.`,
    );
  }

  /**
   * Upload a tarball of files into the sandbox and execute a command in
   * the same round-trip. Used by setup paths that would otherwise need one
   * sandbox RPC per file plus another to run the install script — Modal-
   * style providers pay ~700ms per RPC, so collapsing N+1 calls into one
   * is the single biggest win on cold setup.
   *
   * Default implementation falls back to `uploadFile` per entry + a final
   * `run`. Providers that support stdin streaming (Modal) override this to
   * do the upload + extract + exec in a single sandbox `exec` call.
   */
  async uploadAndRun(
    files: TarballEntry[],
    command: string,
    options?: CommandOptions,
  ): Promise<CommandResult> {
    this.requireProvisioned();
    for (const entry of files) {
      const content =
        typeof entry.content === "string"
          ? Buffer.from(entry.content, "utf8")
          : entry.content;
      await this.uploadFile(content, entry.path);
    }
    if (files.length > 0) {
      const chmodCmd = files
        .filter((entry) => entry.mode && (entry.mode & 0o111) !== 0)
        .map(
          (entry) =>
            `chmod ${entry.mode!.toString(8)} ${shellQuote(entry.path)}`,
        );
      if (chmodCmd.length > 0) {
        await this.run(chmodCmd.join(" && "), options);
      }
    }
    return this.run(command, options);
  }

  /**
   * Public hook that callers must invoke before they touch the sandbox
   * (running commands, cloning repos, uploading files, opening preview
   * links, …). It either attaches to an existing tagged sandbox or creates
   * a new one. The result is cached so repeated calls are cheap.
   *
   * Provisioning is no longer triggered implicitly by `run`, `runAsync`,
   * `gitClone`, `uploadAndRun`, etc. Those methods now throw a clear error
   * when the adapter has not been provisioned yet, which makes the
   * lifecycle explicit and gives callers control over when the
   * (potentially slow) sandbox attach / create happens.
   */
  async findOrProvision(): Promise<void> {
    if (this.provisioned) {
      return;
    }

    if (!this.provisioning) {
      this.provisioning = time(
        debugSandbox,
        `provision [${this.provider}] (find-or-create)`,
        async () => {
          await this.provision();
          this.provisioned = true;
        },
      ).finally(() => {
        this.provisioning = undefined;
      });
    }

    await this.provisioning;
  }

  /**
   * Throw a consistent error when a method that needs a provisioned
   * sandbox is called before `findOrProvision()`. Provider adapters call
   * this at the top of `run`, `runAsync`, `uploadFile`, etc.
   */
  protected requireProvisioned(): void {
    if (!this.provisioned) {
      throw new Error(
        `Sandbox (${this.provider}) is not provisioned. ` +
          `Call \`sandbox.findOrProvision()\` once before running commands, ` +
          `cloning repos, or uploading files.`,
      );
    }
  }

  get tags(): Record<string, string> {
    return { ...(this.options.tags ?? {}) };
  }

  get workingDir(): string {
    return this.options.workingDir ?? "/workspace";
  }

  /**
   * Whether `findOrProvision()` warm-attached to a pre-existing tagged
   * sandbox (`true`) or created a fresh one (`false`). Useful to skip
   * idempotent setup that the previous run already performed (e.g.
   * `agent.setup()`). Always `false` before `findOrProvision()` resolves.
   */
  get wasFound(): boolean {
    return this.wasFoundFlag;
  }

  /**
   * Headers that callers should attach to HTTP / WebSocket requests they make
   * against this sandbox's preview URL. Default is empty; providers like
   * Vercel override this to inject Deployment Protection bypass tokens.
   */
  get previewHeaders(): Record<string, string> {
    return {};
  }

  getMergedEnv(extra?: Record<string, string>): Record<string, string> {
    return {
      ...this.baseEnv,
      ...this.secrets,
      ...(extra ?? {}),
    };
  }

  setSecret(name: string, value: string): void {
    this.secrets[name] = value;
  }

  setSecrets(values: Record<string, string>): void {
    Object.assign(this.secrets, values);
  }

  async gitClone(options: GitCloneOptions): Promise<CommandResult> {
    this.requireProvisioned();
    return this.run(buildGitCloneCommand(options), {
      cwd: this.workingDir,
      env: this.getMergedEnv(),
    });
  }
}
