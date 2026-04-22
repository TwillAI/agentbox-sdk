import { DaytonaSandboxAdapter } from "./providers/daytona";
import { E2bSandboxAdapter } from "./providers/e2b";
import { LocalDockerSandboxAdapter } from "./providers/local-docker";
import { ModalSandboxAdapter } from "./providers/modal";
import { VercelSandboxAdapter } from "./providers/vercel";
import {
  SandboxProvider,
  type AsyncCommandHandle,
  type CommandOptions,
  type CommandResult,
  type GitCloneOptions,
  type SandboxDescriptor,
  type SandboxListOptions,
  type SandboxOptions,
  type SandboxProviderName,
  type SandboxRaw,
} from "./types";
import type { SandboxAdapter } from "./base";
import { UnsupportedProviderError } from "../shared/errors";

function createSandboxAdapter<P extends SandboxProviderName>(
  provider: P,
  options: SandboxOptions<P>,
): SandboxAdapter<P, SandboxOptions<P>, SandboxRaw<P>> {
  switch (provider) {
    case SandboxProvider.LocalDocker:
      return new LocalDockerSandboxAdapter(
        options as SandboxOptions<"local-docker">,
      ) as unknown as SandboxAdapter<P, SandboxOptions<P>, SandboxRaw<P>>;
    case SandboxProvider.Modal:
      return new ModalSandboxAdapter(
        options as SandboxOptions<"modal">,
      ) as unknown as SandboxAdapter<P, SandboxOptions<P>, SandboxRaw<P>>;
    case SandboxProvider.Daytona:
      return new DaytonaSandboxAdapter(
        options as SandboxOptions<"daytona">,
      ) as unknown as SandboxAdapter<P, SandboxOptions<P>, SandboxRaw<P>>;
    case SandboxProvider.Vercel:
      return new VercelSandboxAdapter(
        options as SandboxOptions<"vercel">,
      ) as unknown as SandboxAdapter<P, SandboxOptions<P>, SandboxRaw<P>>;
    case SandboxProvider.E2B:
      return new E2bSandboxAdapter(
        options as SandboxOptions<"e2b">,
      ) as unknown as SandboxAdapter<P, SandboxOptions<P>, SandboxRaw<P>>;
    default:
      throw new UnsupportedProviderError("sandbox", provider);
  }
}

export class Sandbox<P extends SandboxProviderName = SandboxProviderName> {
  private readonly adapter: SandboxAdapter<P, SandboxOptions<P>, SandboxRaw<P>>;

  constructor(
    private readonly providerName: P,
    private readonly options: SandboxOptions<P>,
  ) {
    this.adapter = createSandboxAdapter(providerName, options);
  }

  get provider(): P {
    return this.providerName;
  }

  get optionsSnapshot(): SandboxOptions<P> {
    return this.options;
  }

  get id(): string | undefined {
    return this.adapter.id;
  }

  get raw(): SandboxRaw<P> | undefined {
    return this.adapter.raw;
  }

  async openPort(port: number): Promise<this> {
    await this.adapter.openPort(port);
    return this;
  }

  setSecret(name: string, value: string): this {
    this.adapter.setSecret(name, value);
    return this;
  }

  setSecrets(values: Record<string, string>): this {
    this.adapter.setSecrets(values);
    return this;
  }

  async gitClone(options: GitCloneOptions): Promise<CommandResult> {
    return this.adapter.gitClone(options);
  }

  async run(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    return this.adapter.run(command, options);
  }

  async runAsync(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<AsyncCommandHandle> {
    return this.adapter.runAsync(command, options);
  }

  async list(options?: SandboxListOptions): Promise<SandboxDescriptor[]> {
    return this.adapter.list(options);
  }

  async snapshot(): Promise<string | null> {
    return this.adapter.snapshot();
  }

  async stop(): Promise<void> {
    return this.adapter.stop();
  }

  async delete(): Promise<void> {
    return this.adapter.delete();
  }

  async getPreviewLink(port: number): Promise<string> {
    return this.adapter.getPreviewLink(port);
  }

  get previewHeaders(): Record<string, string> {
    return this.adapter.previewHeaders;
  }

  async uploadFile(
    content: Buffer | string,
    targetPath: string,
  ): Promise<void> {
    return this.adapter.uploadFile(content, targetPath);
  }

  async downloadFile(sourcePath: string): Promise<Buffer> {
    return this.adapter.downloadFile(sourcePath);
  }
}
