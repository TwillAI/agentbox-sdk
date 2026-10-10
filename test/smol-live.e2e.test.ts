import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Sandbox } from "../src/sandboxes/Sandbox";

const live =
  process.env.AGENTBOX_RUN_SMOL_E2E === "1" ? describe : describe.skip;
// Paused reconnect needs the Smol SDK change pending in smol#263.
const pausedLive =
  process.env.AGENTBOX_RUN_SMOL_PAUSED_E2E === "1" ? it : it.skip;

live("Smol local microVM provider", () => {
  it("does not reuse a tagged VM with a different network policy", async () => {
    const tags = { "agentbox.test": randomUUID() };
    const first = new Sandbox("smol", {
      image: "node:24-alpine",
      tags,
      provider: { network: true },
    });
    const second = new Sandbox("smol", {
      image: "node:24-alpine",
      tags,
      provider: { network: false },
    });
    const untagged = new Sandbox("smol", { image: "node:24-alpine" });
    try {
      await first.findOrProvision();
      await second.findOrProvision();
      expect(second.isWarm).toBe(false);
      expect(second.id).not.toBe(first.id);
      await untagged.findOrProvision();
      expect(untagged.isWarm).toBe(false);
      expect(untagged.id).not.toBe(first.id);
      expect(untagged.id).not.toBe(second.id);
    } finally {
      await untagged.delete().catch(() => undefined);
      await second.delete().catch(() => undefined);
      await first.delete().catch(() => undefined);
    }
  }, 120_000);

  pausedLive("resumes a tagged VM that was paused before warm reattachment", async () => {
    const tags = { "agentbox.test": randomUUID() };
    const options = { image: "node:24-alpine", tags };
    const first = new Sandbox("smol", options);
    try {
      await first.findOrProvision();
      expect((await first.run("printf saved >/workspace/marker")).exitCode).toBe(0);
      const machine = first.raw?.machine;
      expect(machine).toBeDefined();
      await machine!.pause();
      expect((await first.list({ tags })).find((m) => m.id === first.id)?.state).toBe("paused");

      const second = new Sandbox("smol", options);
      await second.findOrProvision();
      expect(second.isWarm).toBe(true);
      expect(second.id).toBe(first.id);
      expect((await second.run("cat /workspace/marker")).stdout).toBe("saved");
    } finally {
      await first.delete().catch(() => undefined);
    }
  }, 120_000);

  it("reattaches, streams commands, transfers files and exposes an agent port", async () => {
    const tags = { "agentbox.test": randomUUID() };
    const options = {
      image: "node:24-alpine",
      tags,
      workingDir: "/workspace",
      provider: { publishedPorts: [18090] },
    };
    const sandbox = new Sandbox("smol", options);
    try {
      await sandbox.openPort(18090);
      await sandbox.findOrProvision();
      expect(sandbox.isWarm).toBe(false);
      expect((await sandbox.list({ tags })).map((x) => x.id)).toContain(
        sandbox.id,
      );
      await sandbox.uploadFile(
        Buffer.from([0, 1, 255, 2]),
        "/workspace/data/file.bin",
      );
      expect(await sandbox.downloadFile("/workspace/data/file.bin")).toEqual(
        Buffer.from([0, 1, 255, 2]),
      );
      const result = await sandbox.run("pwd && echo hello", {
        cwd: "/workspace",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("/workspace\nhello");
      const handle = await sandbox.runAsync(
        "printf hello; printf error >&2; exit 3",
      );
      const events = [];
      for await (const event of handle) events.push(event);
      expect(events.map((event) => event.type)).toEqual([
        "stdout",
        "stderr",
        "exit",
      ]);
      expect(await handle.wait()).toMatchObject({
        exitCode: 3,
        stdout: "hello",
        stderr: "error",
      });
      const slow = await sandbox.runAsync("sleep 30");
      await slow.kill();
      await expect(slow.wait()).rejects.toThrow("Smol command cancelled");
      expect((await sandbox.run("echo still-alive")).stdout.trim()).toBe("still-alive");
      const server = await sandbox.run(
        'nohup node -e \'require("http").createServer((_, res) => res.end("smol-ready")).listen(18090, "0.0.0.0")\' >/workspace/server.log 2>&1 </dev/null &',
      );
      expect(server.exitCode).toBe(0);
      let response: Response | undefined;
      for (let i = 0; i < 50; i++) {
        try {
          response = await fetch(await sandbox.getPreviewLink(18090));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      expect(await response?.text()).toBe("smol-ready");
      const other = new Sandbox("smol", options);
      await other.findOrProvision();
      expect(other.isWarm).toBe(true);
      expect(other.id).toBe(sandbox.id);
      expect(
        (await other.run("cat /workspace/data/file.bin | wc -c")).stdout.trim(),
      ).toBe("4");
    } finally {
      await sandbox.delete();
    }
  }, 120_000);
});
