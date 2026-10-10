import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { Sandbox } from "../src/sandboxes/Sandbox";

const live = process.env.AGENTBOX_RUN_SMOL_CLOUD_E2E === "1" ? describe : describe.skip;

live("Smol Cloud agent port forwarding", () => {
  it("boots before the listener, preserves HTTP and WebSocket agent credentials, and reattaches", async () => {
    const port = 18090;
    const options = {
      image: "node:24-alpine",
      tags: { "agentbox.test": randomUUID() },
      provider: { target: "cloud" as const, network: false, publishedPorts: [port] },
    };
    const sandbox = new Sandbox("smol", options);
    try {
      await sandbox.findOrProvision();
      expect(sandbox.isWarm).toBe(false);
      expect(sandbox.id).toMatch(/^mach-/);
      const script = `const http = require("http");
const crypto = require("crypto");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(req.headers.authorization + " " + req.url);
});
server.on("upgrade", (req, socket) => {
  const accept = crypto.createHash("sha1")
    .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
  const text = Buffer.from(req.headers.authorization);
  socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));
});
server.listen(${port}, "0.0.0.0");`;
      await sandbox.uploadFile(script, "/workspace/agent-server.js");
      const launch = await sandbox.run("nohup node /workspace/agent-server.js >/workspace/agent-server.log 2>&1 </dev/null &");
      expect(launch.exitCode).toBe(0);
      expect((await sandbox.downloadFile("/workspace/agent-server.js")).toString()).toContain("createServer");
      const stream = await sandbox.runAsync("printf cloud-out; printf cloud-err >&2");
      const events = [];
      for await (const event of stream) events.push(event.type);
      expect(events).toEqual(["stdout", "stderr", "exit"]);
      expect(await stream.wait()).toMatchObject({ exitCode: 0, stdout: "cloud-out", stderr: "cloud-err" });
      const url = await sandbox.getPreviewLink(port);
      const authorization = "Basic agentbox-secret";
      let result: Response | undefined;
      for (let i = 0; i < 40; i++) {
        try {
          result = await fetch(`${url}/health`, {
            headers: { authorization },
            signal: AbortSignal.timeout(2_000),
          });
          if (result.ok) break;
        } catch { /* The listener may still be starting. */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(result?.status).toBe(200);
      expect(await result?.text()).toBe(`${authorization} /health`);

      const message = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(url.replace(/^http/, "ws") + "/socket", {
          headers: { authorization },
          handshakeTimeout: 10_000,
        });
        ws.once("message", (data) => { resolve(data.toString()); ws.close(); });
        ws.once("error", reject);
      });
      expect(message).toBe(authorization);

      const other = new Sandbox("smol", options);
      await other.findOrProvision();
      expect(other.isWarm).toBe(true);
      expect(other.id).toBe(sandbox.id);
      expect((await other.run("cat /workspace/agent-server.js")).stdout).toContain("createServer");
      await other.stop();
      const restarted = new Sandbox("smol", options);
      await restarted.findOrProvision();
      expect(restarted.isWarm).toBe(true);
      expect(restarted.id).toBe(sandbox.id);
      expect((await restarted.run("test -f /workspace/agent-server.js")).exitCode).toBe(0);
      expect((await restarted.run(
        "nohup node /workspace/agent-server.js >/workspace/agent-server.log 2>&1 </dev/null &",
      )).exitCode).toBe(0);
      // The first sandbox still owns this preview listener. Each new client
      // connection must establish a fresh Cloud tunnel after another adapter
      // stopped and restarted the underlying VM.
      let recovered: Response | undefined;
      for (let i = 0; i < 40; i++) {
        try {
          recovered = await fetch(`${url}/after-restart`, {
            headers: { authorization },
            signal: AbortSignal.timeout(2_000),
          });
          if (recovered.ok) break;
        } catch { /* The guest listener may still be starting. */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(await recovered?.text()).toBe(`${authorization} /after-restart`);
      await sandbox.delete();
      await expect(fetch(`${url}/after-delete`, {
        signal: AbortSignal.timeout(2_000),
      })).rejects.toThrow();
    } finally {
      await sandbox.delete().catch(() => undefined);
    }
  }, 180_000);
});
