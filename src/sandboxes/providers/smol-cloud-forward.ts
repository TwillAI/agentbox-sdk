import { createServer, type Socket } from "node:net";
import type { Machine } from "smolmachines";
import WebSocket from "ws";

/** The Cloud API authenticates its TCP tunnel separately from the guest HTTP
 * request. Raw forwarding keeps the agent server's Authorization header intact. */
export interface CloudForward {
  url: string;
  close(): Promise<void>;
}

export async function openCloudForward(machine: Machine, port: number): Promise<CloudForward> {
  const endpoint = machine.endpoint(port);
  const tunnelUrl = endpoint.wsUrl.replace(
    new RegExp(`/connect/${port}$`), `/tunnel/${port}`,
  );
  if (tunnelUrl === endpoint.wsUrl) throw new Error("Invalid Smol Cloud tunnel URL.");
  const sockets = new Set<Socket>();
  const tunnels = new Set<WebSocket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.pause();
    const tunnel = new WebSocket(tunnelUrl, { headers: endpoint.headers });
    tunnels.add(tunnel);
    const close = () => { socket.destroy(); tunnel.terminate(); };
    socket.on("error", close);
    socket.on("close", () => { sockets.delete(socket); tunnel.terminate(); });
    tunnel.on("error", close);
    tunnel.on("close", () => { tunnels.delete(tunnel); socket.destroy(); });
    tunnel.on("open", () => socket.resume());
    socket.on("data", (data) => {
      socket.pause();
      tunnel.send(data, { binary: true }, (error) => {
        if (error) close();
        else socket.resume();
      });
    });
    tunnel.on("message", (data, isBinary) => {
      if (!isBinary) { close(); return; }
      if (!socket.write(data as Buffer)) {
        tunnel.pause();
        socket.once("drain", () => tunnel.resume());
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    server.close();
    throw error;
  }
  // An unused preview should not keep the host process alive by itself.
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a Smol Cloud tunnel port.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      for (const tunnel of tunnels) tunnel.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
