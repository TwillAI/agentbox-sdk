import type { SandboxResourceSpec } from "./types";

export function resolveSandboxImage(
  image: string | undefined,
): string | undefined {
  return image;
}

export function resolveSandboxResources(
  resources?: SandboxResourceSpec,
): SandboxResourceSpec | undefined {
  return resources &&
    Object.values(resources).some((value) => value !== undefined)
    ? resources
    : undefined;
}
