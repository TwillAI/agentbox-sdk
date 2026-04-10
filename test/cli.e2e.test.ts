import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = ["npx", ["tsx", "src/cli.ts"]] as const;

function exec(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(cli[0], [...cli[1], ...args], {
    cwd: process.cwd(),
    timeout: 10_000,
    env: { ...process.env },
  }).then(
    ({ stdout, stderr }) => ({ stdout, stderr, exitCode: 0 }),
    (error: { stdout?: string; stderr?: string; code?: number }) => ({
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      exitCode: error.code ?? 1,
    }),
  );
}

describe("CLI E2E", () => {
  // ── Help & usage ─────────────────────────────────────────────

  it("prints help with no arguments (exit 0)", async () => {
    const { stdout, exitCode } = await exec([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("agentbox");
    expect(stdout).toContain("Usage:");
  });

  it("prints help with --help flag", async () => {
    const { stdout, exitCode } = await exec(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("prints help with -h flag", async () => {
    const { stdout, exitCode } = await exec(["-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  // ── Provider names in help ───────────────────────────────────

  it("help text lists all five providers", async () => {
    const { stdout } = await exec(["--help"]);
    expect(stdout).toContain("local-docker");
    expect(stdout).toContain("modal");
    expect(stdout).toContain("daytona");
    expect(stdout).toContain("vercel");
    expect(stdout).toContain("e2b");
  });

  it("help text lists presets", async () => {
    const { stdout } = await exec(["--help"]);
    expect(stdout).toContain("browser-agent");
    expect(stdout).toContain("computer-use");
  });

  it("help text documents Vercel env vars", async () => {
    const { stdout } = await exec(["--help"]);
    expect(stdout).toContain("VERCEL_TOKEN");
    expect(stdout).toContain("VERCEL_TEAM_ID");
    expect(stdout).toContain("VERCEL_PROJECT_ID");
  });

  // ── Invalid commands ─────────────────────────────────────────

  it("rejects unknown commands with help + non-zero exit", async () => {
    const { stdout, exitCode } = await exec(["bogus"]);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("rejects image build without --provider", async () => {
    const { stdout, exitCode } = await exec([
      "image",
      "build",
      "--preset",
      "browser-agent",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("rejects image build without --preset or --file", async () => {
    const { stdout, exitCode } = await exec([
      "image",
      "build",
      "--provider",
      "local-docker",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("Usage:");
  });

  // ── Provider validation ──────────────────────────────────────

  it("accepts vercel as a valid provider name", async () => {
    // vercel + preset triggers buildSandboxImage which will throw
    // "Image building is not supported" — but that proves parsing worked.
    const { stderr, exitCode } = await exec([
      "image",
      "build",
      "--provider",
      "vercel",
      "--preset",
      "browser-agent",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Image building is not supported");
    expect(stderr).toContain("snapshots");
  });

  it("rejects unknown provider names", async () => {
    const { stderr, exitCode } = await exec([
      "image",
      "build",
      "--provider",
      "aws",
      "--preset",
      "browser-agent",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unsupported sandbox provider");
  });

  // ── Preset validation ────────────────────────────────────────

  it("rejects unknown preset names", async () => {
    const { stderr, exitCode } = await exec([
      "image",
      "build",
      "--provider",
      "local-docker",
      "--preset",
      "nonexistent",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown built-in image preset");
  });

  // ── Option parsing ───────────────────────────────────────────

  it("rejects unknown flags", async () => {
    const { stderr, exitCode } = await exec([
      "image",
      "build",
      "--provider",
      "local-docker",
      "--preset",
      "browser-agent",
      "--unknown-flag",
      "value",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown option");
  });

  it("rejects flags without values", async () => {
    const { stderr, exitCode } = await exec([
      "image",
      "build",
      "--provider",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Missing value");
  });

  // ── sandbox-image alias ──────────────────────────────────────

  it("accepts sandbox-image as alias for image", async () => {
    const { stderr, exitCode } = await exec([
      "sandbox-image",
      "build",
      "--provider",
      "vercel",
      "--preset",
      "browser-agent",
    ]);
    expect(exitCode).not.toBe(0);
    // Should reach buildSandboxImage (not print help), proving alias works
    expect(stderr).toContain("Image building is not supported");
  });
});
