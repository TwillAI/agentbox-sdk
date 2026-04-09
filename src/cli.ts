#!/usr/bin/env node

import { buildSandboxImage } from "./sandbox-images/build";
import type { BuiltInSandboxImageName } from "./sandbox-images/types";
import type { SandboxProviderName } from "./sandboxes/types";

type CliOptions = {
  provider?: SandboxProviderName;
  preset?: BuiltInSandboxImageName;
  file?: string;
  imageName?: string;
  modalAppName?: string;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const [command, subcommand, ...rest] = args;
  if (
    !(
      (command === "image" || command === "sandbox-image") &&
      subcommand === "build"
    )
  ) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const options = parseOptions(rest);
  if (!options.provider || (!options.preset && !options.file)) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const reference = await buildSandboxImage({
    provider: options.provider,
    preset: options.preset,
    file: options.file,
    imageName: options.imageName,
    modalAppName: options.modalAppName,
    log: (chunk) => {
      process.stderr.write(chunk.endsWith("\n") ? chunk : `${chunk}\n`);
    },
  });

  process.stdout.write(`${reference}\n`);
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (!arg || !arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    if (!next) {
      throw new Error(`Missing value for ${arg}`);
    }

    switch (arg) {
      case "--provider":
        if (!isSandboxProviderName(next)) {
          throw new Error(`Unsupported sandbox provider: ${next}`);
        }
        options.provider = next;
        i += 1;
        break;
      case "--preset":
        if (!isBuiltInImageName(next)) {
          throw new Error(`Unknown built-in image preset: ${next}`);
        }
        options.preset = next;
        i += 1;
        break;
      case "--file":
        options.file = next;
        i += 1;
        break;
      case "--image-name":
        options.imageName = next;
        i += 1;
        break;
      case "--modal-app-name":
        options.modalAppName = next;
        i += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function isSandboxProviderName(value: string): value is SandboxProviderName {
  return (
    value === "local-docker" ||
    value === "modal" ||
    value === "daytona" ||
    value === "e2b"
  );
}

function isBuiltInImageName(value: string): value is BuiltInSandboxImageName {
  return value === "browser-agent" || value === "computer-use";
}

function printHelp(): void {
  process.stdout.write(`openagent

Usage:
  openagent image build --provider <local-docker|modal|daytona|e2b> --preset <browser-agent|computer-use>
  openagent image build --provider <local-docker|modal|daytona|e2b> --file <path>

Options:
  --image-name <name>        Override the built artifact name
  --modal-app-name <name>    Modal app used for image builds

Environment:
  Modal: MODAL_TOKEN_ID, MODAL_TOKEN_SECRET, MODAL_ENVIRONMENT?, MODAL_ENDPOINT?
  Daytona: DAYTONA_API_KEY or DAYTONA_JWT_TOKEN, DAYTONA_ORGANIZATION_ID?, DAYTONA_API_URL?, DAYTONA_TARGET?
  E2B: E2B_API_KEY, E2B_DOMAIN?, E2B_ACCESS_TOKEN?
`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
