import { execFile, spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import crossSpawn from "cross-spawn";

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

const windows = process.platform === "win32";

/** Windows has no process groups or signals: end the child and everything it started. */
function killWindowsTree(pid: number): void {
  const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  execFile(taskkill, ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
}

export function spawnCommand(options: SpawnCommandOptions): SpawnedProcess {
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    stdio: "pipe",
    windowsHide: true,
    detached: options.processGroup === true && !windows,
  };
  // Windows starts package-manager shims (`codex.cmd`) only through cmd.exe,
  // and a shell would re-parse every argument (paths with spaces, prompts).
  // cross-spawn resolves PATHEXT and shebangs and escapes what cmd.exe sees.
  const child = (windows ? crossSpawn : spawn)(options.command, options.args ?? [], spawnOptions) as ChildProcessWithoutNullStreams;

  const exitPromise = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });

  void exitPromise.catch(() => undefined);
  let killPromise: Promise<void> | undefined;
  const signalProcess = (signal: NodeJS.Signals) => {
    try {
      // A shim's cmd.exe exits without its CLI, which keeps our pipes open.
      if (windows && child.pid) killWindowsTree(child.pid);
      else if (options.processGroup && child.pid) process.kill(-child.pid, signal);
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
        if (options.processGroup && !windows) signalProcess("SIGKILL");
        return;
      }
      signalProcess("SIGKILL");
      if (!await waitForExit(3000)) throw new Error("The owned agent process did not stop");
    })(),
  };
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
