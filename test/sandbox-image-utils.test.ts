import { describe, expect, it } from "vitest";

import {
  resolveSandboxImage,
  resolveSandboxResources,
} from "../src/sandboxes/image-utils";

describe("sandbox image utils", () => {
  it("returns the top-level image unchanged", () => {
    expect(resolveSandboxImage("node:20-bookworm")).toBe("node:20-bookworm");
  });

  it("returns undefined for empty resource specs", () => {
    expect(resolveSandboxResources(undefined)).toBeUndefined();
  });

  it("returns normalized cpu and memory resources", () => {
    expect(
      resolveSandboxResources({
        cpu: 2,
        memoryMiB: 4096,
      }),
    ).toEqual({
      cpu: 2,
      memoryMiB: 4096,
    });
  });
});
