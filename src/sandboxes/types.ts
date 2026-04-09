export type SandboxProviderName = "local-docker" | "modal" | "daytona" | "e2b";

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  pty?: boolean;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  raw?: unknown;
}

export interface CommandEvent {
  type: "stdout" | "stderr" | "exit";
  chunk?: string;
  exitCode?: number;
  timestamp: string;
  raw?: unknown;
}

export interface AsyncCommandHandle extends AsyncIterable<CommandEvent> {
  id: string;
  raw?: unknown;
  write?(input: string): Promise<void>;
  wait(): Promise<CommandResult>;
  kill(): Promise<void>;
}

export interface GitCloneOptions {
  repoUrl: string;
  branch?: string;
  targetDir?: string;
  depth?: number;
  token?: string;
  headers?: Record<string, string>;
}

export interface SandboxListOptions {
  tags?: Record<string, string>;
}

export interface SandboxDescriptor {
  provider: SandboxProviderName;
  id: string;
  state?: string;
  tags: Record<string, string>;
  createdAt?: string;
  raw?: unknown;
}

export interface SandboxOptionsBase {
  tags?: Record<string, string>;
  env?: Record<string, string>;
  workingDir?: string;
  idleTimeoutMs?: number;
  autoStopMs?: number;
  image?: string;
  resources?: SandboxResourceSpec;
}

export interface SandboxResourceSpec {
  cpu?: number;
  memoryMiB?: number;
}

export interface LocalDockerProviderOptions {
  name?: string;
  command?: string[];
  pull?: boolean;
  autoRemove?: boolean;
  binds?: string[];
  networkMode?: string;
  publishedPorts?: number[];
}

export interface ModalProviderOptions {
  appName?: string;
  environment?: string;
  endpoint?: string;
  tokenId?: string;
  tokenSecret?: string;
  encryptedPorts?: number[];
  unencryptedPorts?: number[];
  command?: string[];
  verbose?: boolean;
}

export interface DaytonaProviderOptions {
  apiKey?: string;
  jwtToken?: string;
  organizationId?: string;
  apiUrl?: string;
  target?: string;
  name?: string;
  language?: string;
  user?: string;
  public?: boolean;
}

export interface E2bProviderOptions {
  apiKey?: string;
  accessToken?: string;
  domain?: string;
  apiUrl?: string;
  sandboxUrl?: string;
  debug?: boolean;
  requestTimeoutMs?: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
  lifecycle?: {
    onTimeout?: "pause" | "kill";
    autoResume?: boolean;
  };
  secure?: boolean;
  allowInternetAccess?: boolean;
}

export interface LocalDockerSandboxOptions extends SandboxOptionsBase {
  provider?: LocalDockerProviderOptions;
}

export interface ModalSandboxOptions extends SandboxOptionsBase {
  provider?: ModalProviderOptions;
}

export interface DaytonaSandboxOptions extends SandboxOptionsBase {
  provider?: DaytonaProviderOptions;
}

export interface E2bSandboxOptions extends SandboxOptionsBase {
  provider?: E2bProviderOptions;
}

export type SandboxOptionsMap = {
  "local-docker": LocalDockerSandboxOptions;
  modal: ModalSandboxOptions;
  daytona: DaytonaSandboxOptions;
  e2b: E2bSandboxOptions;
};

export type SandboxOptions<
  P extends SandboxProviderName = SandboxProviderName,
> = SandboxOptionsMap[P];
