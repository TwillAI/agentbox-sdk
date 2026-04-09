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
import { buildGitCloneCommand } from "./git";

export abstract class SandboxDriver<
  TProvider extends SandboxProviderName = SandboxProviderName,
  TOptions extends SandboxOptions<TProvider> = SandboxOptions<TProvider>,
  TRaw = unknown,
> {
  protected readonly options: TOptions;
  protected readonly secrets: Record<string, string> = {};
  protected readonly baseEnv: Record<string, string>;
  private provisioned = false;
  private provisioning?: Promise<void>;

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

  protected async ensureProvisioned(): Promise<void> {
    if (this.provisioned) {
      return;
    }

    if (!this.provisioning) {
      this.provisioning = (async () => {
        await this.provision();
        this.provisioned = true;
      })().finally(() => {
        this.provisioning = undefined;
      });
    }

    await this.provisioning;
  }

  get tags(): Record<string, string> {
    return { ...(this.options.tags ?? {}) };
  }

  get workingDir(): string {
    return this.options.workingDir ?? "/workspace";
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
    await this.ensureProvisioned();
    return this.run(buildGitCloneCommand(options), {
      cwd: this.workingDir,
      env: this.getMergedEnv(),
    });
  }
}
