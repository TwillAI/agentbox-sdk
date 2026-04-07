import { createHash } from "node:crypto";
import type { SandboxImageDefinition } from "./types";

export function sandboxImageDefinitionToDockerfileCommands(
  image: SandboxImageDefinition,
): string[] {
  const commands: string[] = [];

  for (const [name, value] of Object.entries(image.env ?? {})) {
    commands.push(`ENV ${name}=${JSON.stringify(value)}`);
  }

  for (const command of image.run ?? []) {
    commands.push(`RUN ${command}`);
  }

  if (image.workdir) {
    commands.push(`WORKDIR ${image.workdir}`);
  }

  if (image.cmd) {
    commands.push(`CMD ${JSON.stringify(image.cmd)}`);
  }

  return commands;
}

export function sandboxImageDefinitionToDockerfile(
  image: SandboxImageDefinition,
): string {
  return [
    `FROM ${image.base}`,
    ...sandboxImageDefinitionToDockerfileCommands(image),
  ]
    .join("\n")
    .concat("\n");
}

export function buildSandboxImageReference(
  image: SandboxImageDefinition,
  prefix = "openagent",
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(image))
    .digest("hex")
    .slice(0, 12);
  const name = sanitizeName(image.name ?? "sandbox-image");
  return `${prefix}/${name}:${hash}`;
}

export function buildDaytonaSnapshotName(
  image: SandboxImageDefinition,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(image))
    .digest("hex")
    .slice(0, 12);
  const name = sanitizeName(image.name ?? "sandbox-image").replace(/\//g, "-");
  return `${name}-${hash}`;
}

function sanitizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
