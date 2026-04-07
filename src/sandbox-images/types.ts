import type { SandboxResourceSpec } from "../sandboxes/types";

export interface SandboxImageDefinition {
  name?: string;
  base: string;
  env?: Record<string, string>;
  run?: string[];
  workdir?: string;
  cmd?: string[];
  resources?: SandboxResourceSpec;
}

export type BuiltInSandboxImageName = "browser-agent" | "computer-use";
