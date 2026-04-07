import net from "node:net";
import { setTimeout as sleepTimeout } from "node:timers/promises";

export async function sleep(ms: number): Promise<void> {
  await sleepTimeout(ms);
}

export async function getAvailablePort(host = "127.0.0.1"): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine an available port."));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const intervalMs = options?.intervalMs ?? 250;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms.`);
}
