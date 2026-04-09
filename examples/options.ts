import { randomUUID } from "node:crypto";

import type {
  DaytonaSandboxOptions,
  E2bSandboxOptions,
  LocalDockerSandboxOptions,
  ModalSandboxOptions,
} from "openagent/sandboxes";

export const WORKSPACE_DIR = "/workspace";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

function exampleTags(exampleName: string): Record<string, string> {
  return {
    example: exampleName,
    "openagent.example-run": randomUUID().slice(0, 8),
  };
}

function openCodeConfigContent(): string {
  const providerConfig = {
    ...(process.env.OPENAI_API_KEY
      ? {
          openai: {
            options: {
              apiKey: "{env:OPENAI_API_KEY}",
            },
          },
        }
      : {}),
    ...(process.env.ANTHROPIC_API_KEY
      ? {
          anthropic: {
            options: {
              apiKey: "{env:ANTHROPIC_API_KEY}",
            },
          },
        }
      : {}),
  };

  if (Object.keys(providerConfig).length === 0) {
    throw new Error(
      "OpenCode examples require ANTHROPIC_API_KEY or OPENAI_API_KEY.",
    );
  }

  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: providerConfig,
  });
}

export function localDockerOptions(
  exampleName: string,
): LocalDockerSandboxOptions {
  return {
    workingDir: WORKSPACE_DIR,
    image: requireEnv("IMAGE_ID"),
    tags: exampleTags(exampleName),
  };
}

export function modalOptions(exampleName: string): ModalSandboxOptions {
  return {
    workingDir: WORKSPACE_DIR,
    image: requireEnv("IMAGE_ID"),
    tags: exampleTags(exampleName),
    idleTimeoutMs: 15 * 60_000,
    autoStopMs: 60 * 60_000,
    resources: {
      cpu: 2,
      memoryMiB: 4096,
    },
    provider: {
      appName: "openagent-examples",
      ...(optionalEnv("MODAL_TOKEN_ID")
        ? { tokenId: optionalEnv("MODAL_TOKEN_ID") }
        : {}),
      ...(optionalEnv("MODAL_TOKEN_SECRET")
        ? { tokenSecret: optionalEnv("MODAL_TOKEN_SECRET") }
        : {}),
    },
  };
}

export function daytonaOptions(exampleName: string): DaytonaSandboxOptions {
  return {
    workingDir: WORKSPACE_DIR,
    image: requireEnv("IMAGE_ID"),
    tags: exampleTags(exampleName),
    idleTimeoutMs: 30 * 60_000,
    provider: {
      name: `openagent-${exampleName}-${randomUUID().slice(0, 8)}`,
      language: "typescript",
      ...(optionalEnv("DAYTONA_API_KEY")
        ? { apiKey: optionalEnv("DAYTONA_API_KEY") }
        : {}),
      ...(optionalEnv("DAYTONA_JWT_TOKEN")
        ? { jwtToken: optionalEnv("DAYTONA_JWT_TOKEN") }
        : {}),
    },
  };
}

export function e2bOptions(exampleName: string): E2bSandboxOptions {
  return {
    workingDir: WORKSPACE_DIR,
    image: requireEnv("IMAGE_ID"),
    tags: exampleTags(exampleName),
    provider: {
      ...(optionalEnv("E2B_API_KEY")
        ? { apiKey: optionalEnv("E2B_API_KEY") }
        : {}),
      timeoutMs: 30 * 60_000,
      lifecycle: {
        onTimeout: "pause",
      },
      allowInternetAccess: true,
    },
  };
}

export function codexEnv(): Record<string, string> {
  return {
    OPENAI_API_KEY: requireEnv("OPENAI_API_KEY"),
  };
}

export function claudeEnv(): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: requireEnv("ANTHROPIC_API_KEY"),
  };
}

export function openCodeEnv(): Record<string, string> {
  return {
    ...(process.env.OPENAI_API_KEY
      ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY }
      : {}),
    ...(process.env.ANTHROPIC_API_KEY
      ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
      : {}),
    OPENCODE_CONFIG_CONTENT: openCodeConfigContent(),
  };
}

export function pickOpenCodeModel(): string {
  if (process.env.ANTHROPIC_API_KEY) {
    return "anthropic/claude-sonnet-4-6";
  }

  if (process.env.OPENAI_API_KEY) {
    return "openai/gpt-4.1";
  }

  throw new Error(
    "OpenCode examples require ANTHROPIC_API_KEY or OPENAI_API_KEY.",
  );
}
