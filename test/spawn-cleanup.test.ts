
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { spawnCommand } from "../src/agents/transports/spawn";

describe("owned process cleanup", () => {
  it("escalates an ignored termination signal and leaves unrelated processes alive", async () => {
    const stubborn = spawnCommand({ command: process.execPath, args: ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);'], processGroup: true, terminationTimeoutMs: 30 });
    const unrelated = spawnCommand({ command: process.execPath, args: ["-e", 'process.stdout.write("ready"); setInterval(() => {}, 1000);'], processGroup: true, terminationTimeoutMs: 30 });
    try {
      await Promise.all([once(stubborn.child.stdout, "data"), once(unrelated.child.stdout, "data")]);
      await Promise.all([stubborn.kill(), stubborn.kill()]);
      expect(stubborn.child.signalCode).toBe("SIGKILL");
      expect(unrelated.child.exitCode).toBeNull();
      expect(unrelated.child.signalCode).toBeNull();
    } finally { await Promise.all([stubborn.kill(), unrelated.kill()]); }
  });
});
