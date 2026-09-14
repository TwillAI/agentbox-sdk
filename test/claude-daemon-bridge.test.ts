import { describe, expect, it } from "vitest";
import { createClaudeCodeDaemonScript } from "../src/agents/providers/claude-code";
import { spawnSync } from "node:child_process";

describe("cloud Claude daemon", () => {
  it("generates valid JavaScript with an authenticated response route and pending cleanup", () => {
    const source = createClaudeCodeDaemonScript();
    const syntax = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: source, encoding: "utf8" });
    expect(syntax.stderr).toBe("");
    expect(syntax.status).toBe(0);
    expect(source.indexOf("if (!isAuthorized(req))")).toBeLessThan(source.indexOf("const permissionRoute"));
    expect(source).toContain("clearPermissions()");
    expect(source).toContain("_permission:");
  });
});
