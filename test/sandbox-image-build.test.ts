import { describe, expect, it } from "vitest";

import { loadSandboxImageDefinition } from "../src/sandbox-images/build";
import {
  buildDaytonaSnapshotName,
  buildE2bTemplateReference,
  buildSandboxImageReference,
  sandboxImageDefinitionToDockerfile,
} from "../src/sandbox-images/utils";

describe("sandbox image builds", () => {
  it("loads the built-in browser-agent preset", async () => {
    const definition = await loadSandboxImageDefinition("browser-agent");

    expect(definition.name).toBe("browser-agent");
    expect(definition.base).toBe("node:20-bookworm");
    expect(
      definition.run?.some(
        (command) =>
          command.includes("npm install -g") &&
          command.includes("agent-browser"),
      ),
    ).toBe(true);
  });

  it("loads the computer-use preset with X11 dependencies", async () => {
    const definition = await loadSandboxImageDefinition("computer-use");

    expect(definition.name).toBe("computer-use");
    expect(definition.env?.DISPLAY).toBe(":1");
    expect(definition.run?.some((command) => command.includes("xdotool"))).toBe(
      true,
    );
  });

  it("renders Dockerfiles and deterministic references", () => {
    const definition = {
      name: "demo-image",
      base: "node:20-bookworm",
      env: { HOME: "/root" },
      run: ["echo ready"],
      workdir: "/workspace",
      cmd: ["sleep", "infinity"],
    };

    expect(sandboxImageDefinitionToDockerfile(definition)).toContain(
      "FROM node:20-bookworm",
    );
    expect(buildSandboxImageReference(definition)).toBe(
      buildSandboxImageReference(definition),
    );
    expect(buildDaytonaSnapshotName(definition)).toBe(
      buildDaytonaSnapshotName(definition),
    );
    expect(buildE2bTemplateReference(definition)).toBe(
      buildE2bTemplateReference(definition),
    );
  });
});
