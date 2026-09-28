import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyDifferentialSetup } from "../src/agents/config/setup-manifest";
import type { SetupTarget } from "../src/agents/config/types";
import type { TarballEntry } from "../src/sandboxes/tarball";

const run = promisify(execFile);

// Runs the generated install.sh for real, the way a sandbox would.
function localTarget(rootDir: string): SetupTarget {
  return {
    provider: "claude-code",
    layout: { rootDir },
    async uploadAndRun(files: TarballEntry[], command: string) {
      for (const entry of files) {
        await mkdir(path.dirname(entry.path), { recursive: true });
        await writeFile(entry.path, entry.content);
        if (entry.mode) await chmod(entry.path, entry.mode);
      }
      try {
        const { stdout, stderr } = await run("bash", ["-c", command]);
        return { exitCode: 0, stdout, stderr, combinedOutput: stdout + stderr };
      } catch (error) {
        const e = error as { code: number; stdout: string; stderr: string };
        return {
          exitCode: e.code,
          stdout: e.stdout,
          stderr: e.stderr,
          combinedOutput: e.stdout + e.stderr,
        };
      }
    },
  } as unknown as SetupTarget;
}

describe("applyDifferentialSetup install commands", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agentbox-setup-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const mark = (name: string) => `echo x >> ${path.join(dir, name)}`;
  const count = async (name: string) =>
    (await readFile(path.join(dir, name), "utf8")).split("\n").filter(Boolean)
      .length;

  it("runs every stale command, including the last one", async () => {
    const target = localTarget(path.join(dir, "root"));
    const commands = [mark("a"), mark("b"), mark("c")];

    await expect(applyDifferentialSetup(target, [], commands)).resolves.toBe(
      true,
    );
    expect([await count("a"), await count("b"), await count("c")]).toEqual([
      1, 1, 1,
    ]);

    // Nothing is stale on the next run.
    await expect(applyDifferentialSetup(target, [], commands)).resolves.toBe(
      true,
    );
    expect(await count("c")).toBe(1);
  });

  it("lets concurrent setups share a root dir", async () => {
    const rootDir = path.join(dir, "root");
    const commands = [mark("a"), mark("b")];

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        applyDifferentialSetup(localTarget(rootDir), [], commands),
      ),
    );
    expect(results).toEqual([true, true, true, true]);
    expect(await count("b")).toBeGreaterThanOrEqual(1);
    expect((await readdir(rootDir)).sort()).toEqual(["setup-manifest.json"]);
  });

  it("retries a failed command and keeps it stale when it still fails", async () => {
    const target = localTarget(path.join(dir, "root"));
    const flaky = `${mark("flaky")}; [ "$(wc -l < ${path.join(dir, "flaky")})" -ge 2 ]`;
    const broken = `${mark("broken")}; exit 7`;

    await expect(
      applyDifferentialSetup(target, [], [mark("ok"), flaky]),
    ).resolves.toBe(true);
    expect(await count("flaky")).toBe(2);

    await expect(
      applyDifferentialSetup(target, [], [mark("ok"), broken]),
    ).resolves.toBe(false);
    expect(await count("broken")).toBe(2);

    // The failed command was not recorded, so the next setup runs it again.
    await applyDifferentialSetup(target, [], [mark("ok"), broken]);
    expect(await count("broken")).toBe(4);
    expect(await count("ok")).toBe(1);
    expect(existsSync(path.join(dir, "root", "setup-manifest.json"))).toBe(
      true,
    );
  });
});
