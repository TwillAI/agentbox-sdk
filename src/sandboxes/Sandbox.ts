import { DaytonaSandboxDriver } from "./providers/daytona";
import { LocalDockerSandboxDriver } from "./providers/local-docker";
import { ModalSandboxDriver } from "./providers/modal";
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
import type { SandboxDriver } from "./base";
import { UnsupportedProviderError } from "../shared/errors";

function createSandboxDriver<P extends SandboxProviderName>(
  provider: P,
  options: SandboxOptions<P>,
): SandboxDriver<P, SandboxOptions<P>> {
  switch (provider) {
    case "local-docker":
      return new LocalDockerSandboxDriver(
        options as SandboxOptions<"local-docker">,
      ) as unknown as SandboxDriver<P, SandboxOptions<P>>;
    case "modal":
      return new ModalSandboxDriver(
        options as SandboxOptions<"modal">,
      ) as unknown as SandboxDriver<P, SandboxOptions<P>>;
    case "daytona":
      return new DaytonaSandboxDriver(
        options as SandboxOptions<"daytona">,
      ) as unknown as SandboxDriver<P, SandboxOptions<P>>;
    default:
      throw new UnsupportedProviderError("sandbox", provider);
  }
}

export class Sandbox<P extends SandboxProviderName = SandboxProviderName> {
  private readonly driver: SandboxDriver<P, SandboxOptions<P>>;

  constructor(
    private readonly providerName: P,
    private readonly options: SandboxOptions<P>,
  ) {
    this.driver = createSandboxDriver(providerName, options);
  }

  get provider(): P {
    return this.providerName;
  }

  get optionsSnapshot(): SandboxOptions<P> {
    return this.options;
  }

  get id(): string | undefined {
    return this.driver.id;
  }

  get raw(): unknown {
    return this.driver.raw;
  }

  async openPort(port: number): Promise<this> {
    await this.driver.openPort(port);
    return this;
  }

  setSecret(name: string, value: string): this {
    this.driver.setSecret(name, value);
    return this;
  }

  setSecrets(values: Record<string, string>): this {
    this.driver.setSecrets(values);
    return this;
  }

  async gitClone(options: GitCloneOptions): Promise<CommandResult> {
    return this.driver.gitClone(options);
  }

  async run(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    return this.driver.run(command, options);
  }

  async runAsync(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<AsyncCommandHandle> {
    return this.driver.runAsync(command, options);
  }

  async list(options?: SandboxListOptions): Promise<SandboxDescriptor[]> {
    return this.driver.list(options);
  }

  async snapshot(): Promise<string | null> {
    return this.driver.snapshot();
  }

  async stop(): Promise<void> {
    return this.driver.stop();
  }

  async delete(): Promise<void> {
    return this.driver.delete();
  }

  async getPreviewLink(port: number): Promise<string> {
    return this.driver.getPreviewLink(port);
  }
}
