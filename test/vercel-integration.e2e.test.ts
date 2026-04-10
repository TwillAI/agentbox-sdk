import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Sandbox } from "../src";

const creds = {
  token: process.env.VERCEL_TOKEN,
  teamId: process.env.VERCEL_TEAM_ID,
  projectId: process.env.VERCEL_PROJECT_ID,
};

const enabled =
  process.env.AGENTBOX_RUN_VERCEL_E2E === "1" &&
  !!creds.token &&
  !!creds.teamId &&
  !!creds.projectId;

describe.skipIf(!enabled)("Vercel Sandbox E2E", () => {
  let sandbox: Sandbox<"vercel">;

  beforeAll(() => {
    sandbox = new Sandbox("vercel", {
      tags: { suite: "e2e" },
      provider: {
        runtime: "node24",
        timeoutMs: 120_000,
        ...creds,
      },
    });
  });

  afterAll(async () => {
    await sandbox.stop();
  });

  // ── Provisioning & Identity ──────────────────────────────────

  it("provisions a sandbox and exposes an id", async () => {
    const result = await sandbox.run("echo hello");
    expect(result.exitCode).toBe(0);
    expect(sandbox.id).toBeDefined();
    expect(typeof sandbox.id).toBe("string");
  }, 30_000);

  it("exposes provider name", () => {
    expect(sandbox.provider).toBe("vercel");
  });

  it("exposes raw Vercel sandbox object", async () => {
    // Ensure provisioned first
    await sandbox.run("true");
    const raw = sandbox.raw as { sandbox?: unknown };
    expect(raw.sandbox).toBeDefined();
  });

  it("defaults workingDir to /vercel/sandbox", async () => {
    const result = await sandbox.run("pwd");
    expect(result.stdout.trim()).toBe("/vercel/sandbox");
  });

  // ── run() ────────────────────────────────────────────────────

  it("run: returns stdout, stderr, exitCode", async () => {
    const result = await sandbox.run("echo out && echo err >&2");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("out");
    expect(result.stderr).toContain("err");
    expect(result.combinedOutput).toContain("out");
    expect(result.combinedOutput).toContain("err");
  });

  it("run: returns non-zero exit code on failure", async () => {
    const result = await sandbox.run("exit 42");
    expect(result.exitCode).toBe(42);
  });

  it("run: accepts command as array", async () => {
    const result = await sandbox.run(["echo", "array", "args"]);
    expect(result.stdout).toContain("array args");
  });

  it("run: respects custom cwd", async () => {
    const result = await sandbox.run("pwd", { cwd: "/tmp" });
    expect(result.stdout.trim()).toBe("/tmp");
  });

  it("run: passes custom env vars", async () => {
    const result = await sandbox.run("echo $MY_VAR", {
      env: { MY_VAR: "hello_from_env" },
    });
    expect(result.stdout).toContain("hello_from_env");
  });

  // ── setSecret / setSecrets ───────────────────────────────────

  it("setSecret: injects secret into subsequent commands", async () => {
    sandbox.setSecret("SECRET_KEY", "s3cr3t_value");
    const result = await sandbox.run("echo $SECRET_KEY");
    expect(result.stdout).toContain("s3cr3t_value");
  });

  it("setSecrets: injects multiple secrets", async () => {
    sandbox.setSecrets({ A: "alpha", B: "bravo" });
    const result = await sandbox.run("echo $A $B");
    expect(result.stdout).toContain("alpha bravo");
  });

  // ── runAsync() ───────────────────────────────────────────────

  it("runAsync: streams stdout events and resolves via wait()", async () => {
    const handle = await sandbox.runAsync(
      "for i in 1 2 3; do echo line$i; sleep 0.1; done",
    );

    const chunks: string[] = [];
    for await (const event of handle) {
      if (event.type === "stdout" && event.chunk) {
        chunks.push(event.chunk);
      }
      if (event.type === "exit") {
        expect(event.exitCode).toBe(0);
      }
    }

    expect(chunks.join("")).toContain("line1");
    expect(chunks.join("")).toContain("line2");
    expect(chunks.join("")).toContain("line3");

    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("line1");
  });

  it("runAsync: kill terminates the command", async () => {
    const handle = await sandbox.runAsync("sleep 60");
    await handle.kill();
    const result = await handle.wait();
    // Killed commands return non-zero
    expect(result.exitCode).not.toBe(0);
  });

  // ── gitClone() ───────────────────────────────────────────────

  it("gitClone: clones a public repo", async () => {
    const result = await sandbox.gitClone({
      repoUrl: "https://github.com/octocat/Hello-World.git",
      targetDir: "/vercel/sandbox/hello-world",
      depth: 1,
    });
    expect(result.exitCode).toBe(0);

    const ls = await sandbox.run("ls /vercel/sandbox/hello-world/README");
    expect(ls.exitCode).toBe(0);
  });

  // ── uploadFile / downloadFile ────────────────────────────────

  it("uploadFile: writes a string file", async () => {
    await sandbox.uploadFile(
      "hello world\n",
      "/vercel/sandbox/test-upload.txt",
    );

    const result = await sandbox.run("cat /vercel/sandbox/test-upload.txt");
    expect(result.stdout).toContain("hello world");
  });

  it("uploadFile: writes a Buffer file", async () => {
    await sandbox.uploadFile(
      Buffer.from("binary content"),
      "/vercel/sandbox/test-binary.txt",
    );

    const result = await sandbox.run("cat /vercel/sandbox/test-binary.txt");
    expect(result.stdout).toContain("binary content");
  });

  it("downloadFile: reads back a file", async () => {
    await sandbox.run("echo download-test > /vercel/sandbox/dl-test.txt");

    const buffer = await sandbox.downloadFile("/vercel/sandbox/dl-test.txt");
    expect(buffer.toString("utf8")).toContain("download-test");
  });

  it("downloadFile: throws on missing file", async () => {
    await expect(
      sandbox.downloadFile("/vercel/sandbox/does-not-exist.txt"),
    ).rejects.toThrow();
  });

  // ── list() ───────────────────────────────────────────────────

  it("list: returns sandboxes with agentbox.provider tag", async () => {
    const sandboxes = await sandbox.list();
    expect(Array.isArray(sandboxes)).toBe(true);
    expect(sandboxes.length).toBeGreaterThan(0);

    const current = sandboxes.find((s) => s.id === sandbox.id);
    expect(current).toBeDefined();
    expect(current?.state).toBe("running");
    expect(current?.tags["agentbox.provider"]).toBe("vercel");
  });

  it("list: filters by custom tags", async () => {
    const filtered = await sandbox.list({ tags: { suite: "e2e" } });
    expect(filtered.length).toBeGreaterThan(0);
    for (const s of filtered) {
      expect(s.tags["suite"]).toBe("e2e");
    }
  });

  it("list: returns empty for non-matching tags", async () => {
    const filtered = await sandbox.list({
      tags: { nonexistent: "tag" },
    });
    expect(filtered).toEqual([]);
  });

  // ── openPort / getPreviewLink ────────────────────────────────

  it("openPort: is a no-op and does not actually register the port", async () => {
    // Vercel ports must be declared at create time via `provider.ports`.
    // `openPort()` is accepted for API parity but cannot retroactively
    // register a port with the SDK — `getPreviewLink` should still throw.
    await expect(sandbox.openPort(3000)).resolves.toBe(sandbox);
    await expect(sandbox.getPreviewLink(3000)).rejects.toThrow();
  });

  it("getPreviewLink: throws for ports not declared at create time", async () => {
    // Vercel sandboxes require ports to be declared at creation time via
    // `provider.ports`. This sandbox intentionally omits `provider.ports`,
    // so port 8080 is never registered with the SDK — we expect
    // `getPreviewLink(8080)` to throw.
    const portSandbox = new Sandbox("vercel", {
      tags: { suite: "e2e-port" },
      provider: {
        runtime: "node24",
        timeoutMs: 60_000,
        ...creds,
      },
    });

    // Force provisioning via a no-op command.
    const r = await portSandbox.run("echo ok");
    expect(r.exitCode).toBe(0);

    await expect(portSandbox.getPreviewLink(8080)).rejects.toThrow();

    await portSandbox.stop();
  }, 30_000);

  // ── Node.js runtime ──────────────────────────────────────────

  it("runtime: node24 is available", async () => {
    const result = await sandbox.run("node --version");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^v2[4-9]/);
  }, 15_000);

  it("runtime: npm is available", async () => {
    const result = await sandbox.run("npm --version");
    expect(result.exitCode).toBe(0);
  }, 15_000);

  // ── stop() ───────────────────────────────────────────────────

  it("stop: terminates the sandbox", async () => {
    // Create a separate sandbox for stop test
    const tempSandbox = new Sandbox("vercel", {
      tags: { suite: "e2e-stop" },
      provider: {
        runtime: "node24",
        timeoutMs: 60_000,
        ...creds,
      },
    });

    // Provision it
    const r = await tempSandbox.run("echo alive");
    expect(r.exitCode).toBe(0);
    const tempId = tempSandbox.id;
    expect(tempId).toBeDefined();

    // Stop it
    await tempSandbox.stop();

    // Id should be cleared
    expect(tempSandbox.id).toBeUndefined();
  }, 30_000);
});
