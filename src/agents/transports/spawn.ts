import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { waitFor } from "../../shared/network";

export interface SpawnCommandOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Own the POSIX process group, including tool subprocesses. */
  processGroup?: boolean;
  terminationTimeoutMs?: number;
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
    detached: options.processGroup === true && process.platform !== "win32",
  });

  const exitPromise = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });

  void exitPromise.catch(() => undefined);
  let killPromise: Promise<void> | undefined;
  const signalProcess = (signal: NodeJS.Signals) => {
    try {
      if (options.processGroup && process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exitPromise.then(() => true, () => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };

  return {
    child,
    wait: () => exitPromise,
    kill: (signal = "SIGTERM") => killPromise ??= (async () => {
      signalProcess(signal);
      if (await waitForExit(options.terminationTimeoutMs ?? 3000)) {
        // A tool can ignore SIGTERM and close its inherited stdio before the
        // CLI exits. Terminate any remaining members of our own group too.
        if (options.processGroup && process.platform !== "win32") signalProcess("SIGKILL");
        return;
      }
      signalProcess("SIGKILL");
      if (!await waitForExit(3000)) throw new Error("The owned agent process did not stop");
    })(),
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
