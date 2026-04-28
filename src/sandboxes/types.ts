export { SandboxProvider } from "../enums";
import type { SandboxProvider } from "../enums";
import type { SandboxCreateParams } from "modal";
import type {
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
} from "@daytonaio/sdk";

export type SandboxProviderName = SandboxProvider;

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
  /**
   * Escape hatch: extra parameters spread into Modal's
   * `client.sandboxes.create()` call. Lets callers use Modal-specific
   * features that are not surfaced as typed fields here (e.g.
   * `experimentalOptions`, `gpu`, `cloudBucketMounts`, `regions`).
   *
   * Typed fields on `ModalProviderOptions` and `SandboxOptionsBase` take
   * precedence over keys provided via `createParams`.
   */
  createParams?: Partial<SandboxCreateParams>;
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
  /**
   * Escape hatch: extra parameters spread into Daytona's `client.create()`
   * call. Lets callers use Daytona-specific features that are not surfaced
   * as typed fields here (e.g. `volumes`, `networkBlockAll`,
   * `networkAllowList`, `ephemeral`, `autoArchiveInterval`).
   *
   * Typed fields on `DaytonaProviderOptions` and `SandboxOptionsBase` take
   * precedence over keys provided via `createParams`.
   */
  createParams?: Partial<
    CreateSandboxFromSnapshotParams & CreateSandboxFromImageParams
  >;
}

export interface VercelGitSource {
  url: string;
  depth?: number;
  revision?: string;
  username?: string;
  password?: string;
}

export interface VercelProviderOptions {
  token?: string;
  teamId?: string;
  projectId?: string;
  runtime?: string;
  snapshotId?: string;
  timeoutMs?: number;
  gitSource?: VercelGitSource;
  /**
   * Ports to declare at sandbox creation time. The Vercel SDK requires ports
   * to be known upfront; runtime-opened ports are not supported. Max 4.
   */
  ports?: number[];
  /**
   * Vercel Deployment Protection bypass token. When set, every request the
   * agent transports send through the sandbox preview URL will include
   * `x-vercel-protection-bypass: <token>`. Required when the linked Vercel
   * project has Deployment Protection enabled — without it, POST requests
   * to sandbox-exposed ports come back 200 + empty body.
   */
  protectionBypass?: string;
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

export interface VercelSandboxOptions extends SandboxOptionsBase {
  provider?: VercelProviderOptions;
}

export interface E2bSandboxOptions extends SandboxOptionsBase {
  provider?: E2bProviderOptions;
}

export type SandboxOptionsMap = {
  "local-docker": LocalDockerSandboxOptions;
  modal: ModalSandboxOptions;
  daytona: DaytonaSandboxOptions;
  vercel: VercelSandboxOptions;
  e2b: E2bSandboxOptions;
};

export type SandboxOptions<
  P extends SandboxProviderName = SandboxProviderName,
> = SandboxOptionsMap[P];

export type SandboxRawMap = {
  "local-docker": import("./providers/local-docker").DockerRaw;
  modal: import("./providers/modal").ModalRaw;
  daytona: import("./providers/daytona").DaytonaRaw;
  vercel: import("./providers/vercel").VercelRaw;
  e2b: import("./providers/e2b").E2bRaw;
};

export type SandboxRaw<P extends SandboxProviderName = SandboxProviderName> =
  SandboxRawMap[P];
