import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { waitFor } from "../../shared/network";

export interface SpawnCommandOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SpawnedProcess {
  child: ChildProcessWithoutNullStreams;
  wait(): Promise<number>;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

export function spawnCommand(options: SpawnCommandOptions): SpawnedProcess {
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: options.env,
    stdio: "pipe",
    shell: process.platform === "win32",
    windowsHide: true,
  });

  const exitPromise = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });

  return {
    child,
    wait: () => exitPromise,
    kill: async (signal = "SIGTERM") => {
      child.kill(signal);
      await exitPromise.catch(() => undefined);
    },
  };
}

export async function waitForHttpReady(
  url: string,
  options?: { timeoutMs?: number; intervalMs?: number; init?: RequestInit },
): Promise<void> {
  await waitFor(
    async () => {
      try {
        const response = await fetch(url, options?.init);
        return response.ok;
      } catch {
        return false;
      }
    },
    {
      timeoutMs: options?.timeoutMs,
      intervalMs: options?.intervalMs,
    },
  );
}

export async function* linesFromNodeStream(
  stream: NodeJS.ReadableStream,
): AsyncIterable<string> {
  const lineReader = createInterface({ input: stream });

  try {
    for await (const line of lineReader) {
      yield line;
    }
  } finally {
    lineReader.close();
  }
}
