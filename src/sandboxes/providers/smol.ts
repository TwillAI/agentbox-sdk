import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { posix } from "node:path";
import { Machine, type ConnectOptions, type MachineSummary } from "smolmachines";

import { SandboxAdapter } from "../base";
import {
  SandboxProvider,
  type AsyncCommandHandle,
  type CommandEvent,
  type CommandOptions,
  type CommandResult,
  type SandboxDescriptor,
  type SandboxListOptions,
  type SmolSandboxOptions,
} from "../types";
import { collectAllAgentReservedPorts } from "../../agents/ports";
import { AsyncQueue } from "../../shared/async-queue";
import { suppressUnhandledRejection } from "../../shared/errors";
import { toShellCommand } from "../../shared/shell";
import { openCloudForward, type CloudForward } from "./smol-cloud-forward";

export type SmolRaw = { machine?: Machine };
const ownerLabel = { "agentbox.provider": "smol" };

// Smol requires explicit host ports; zero does not allocate an ephemeral one.
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close(() => {
        if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("Could not allocate a local Smol port."));
      });
    });
  });
}

export class SmolSandboxAdapter extends SandboxAdapter<
  "smol",
  SmolSandboxOptions,
  SmolRaw
> {
  private machine?: Machine;
  private readonly declaredPorts = new Set<number>();
  private readonly cloudForwards = new Map<number, Promise<CloudForward>>();
  private publishedPorts = new Set<number>();

  private get isCloud(): boolean {
    return this.options.provider?.target === "cloud";
  }

  private get connection(): ConnectOptions {
    if (this.isCloud) {
      return {
        target: "cloud",
        waitForPorts: false,
        ...(this.options.provider?.apiKey ? { apiKey: this.options.provider.apiKey } : {}),
        ...(this.options.provider?.baseUrl ? { baseUrl: this.options.provider.baseUrl } : {}),
      };
    }
    return { target: "local", handleSignals: false, waitForPorts: false };
  }

  get provider(): "smol" {
    return SandboxProvider.Smol;
  }
  get raw(): SmolRaw {
    return { machine: this.machine };
  }
  get id(): string | undefined {
    return this.machine && (this.isCloud ? this.machine.id : this.machine.name);
  }

  protected async provision(): Promise<void> {
    if (this.options.idleTimeoutMs !== undefined || this.options.autoStopMs !== undefined) {
      throw new Error(
        "Smol sandboxes do not support idleTimeoutMs or autoStopMs.",
      );
    }
    if (!this.options.image) {
      throw new Error(
        "Smol requires options.image with the agent CLI installed.",
      );
    }
    const ports = new Set([
      ...collectAllAgentReservedPorts(),
      ...(this.options.provider?.publishedPorts ?? []),
      ...this.declaredPorts,
    ]);
    const configLabel = this.configLabel(ports);
    const connection = this.connection;
    // Without an explicit identity, a process must never attach to an
    // unrelated agent's VM. A matching tag alone does not prove that the
    // image, credentials, ports, or network policy are still the same.
    if (Object.keys(this.options.tags ?? {}).length > 0) {
      const existing = (await this.ownedMachines({
        ...this.options.tags,
        ...configLabel,
      })).find((candidate) => candidate.state !== "frozen");
      if (existing) {
        // Cloud attach waits for agent readiness only on a running VM; a
        // stopped or paused VM needs start/resume first.
        const machine = await Machine.connect(
          existing.id,
          this.isCloud && existing.state !== "started" && existing.state !== "running"
            ? { ...connection, waitForPorts: undefined }
            : connection,
        );
        // Reconnecting a paused VM preserves its saved execution. It must be
        // resumed before agent setup or commands can use it; published agent
        // ports may not be listening until AgentBox starts the server.
        if (existing.state === "paused") {
          await machine.resume({ waitUntilReady: false });
        } else if (this.isCloud && existing.state === "stopped") {
          await machine.start({ waitUntilReady: false });
        }
        if (this.isCloud && (existing.state === "paused" || existing.state === "stopped")) {
          await this.waitForCloudAgent(machine);
        }
        this.machine = machine;
        this.publishedPorts = ports;
        this.isWarmFlag = true;
        return;
      }
    }
    const mappings = [];
    const allocated = new Set<number>();
    for (const guest of ports) {
      if (!Number.isInteger(guest) || guest < 1 || guest > 65535) {
        throw new Error(`Invalid Smol guest port: ${guest}`);
      }
      if (this.isCloud) {
        mappings.push({ guest, host: 0 });
      } else {
        let host = await freePort();
        while (allocated.has(host)) host = await freePort();
        allocated.add(host);
        mappings.push({ host, guest });
      }
    }
    // Each machine must survive the process that created it for tagged warm reattach.
    // Smol's default local lifetime would otherwise reap the VM on host exit.
    this.machine = await Machine.create(
      {
        name: `agentbox-${randomUUID()}`,
        image: this.options.image,
        labels: { ...this.options.tags, ...ownerLabel, ...configLabel },
        env: this.getMergedEnv(),
        workdir: this.workingDir,
        ...(!this.isCloud ? { detach: true } : {}),
        waitForPorts: false,
        ports: mappings,
        resources: {
          ...(this.options.resources?.cpu
            ? { cpus: this.options.resources.cpu }
            : {}),
          ...(this.options.resources?.memoryMiB
            ? { memoryMb: this.options.resources.memoryMiB }
            : {}),
          ...(this.options.provider?.allowHosts
            ? { allowHosts: this.options.provider.allowHosts }
            : { network: this.options.provider?.network ?? true }),
        },
      },
      connection,
    );
    this.publishedPorts = ports;
  }

  private async waitForCloudAgent(machine: Machine): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        if ((await machine.exec(["/bin/sh", "-c", "true"], { timeout: 5 })).exitCode === 0) return;
      } catch {
        // The guest agent may still be starting after a Cloud resume or start.
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`Smol Cloud machine ${machine.id} did not start its guest agent.`);
  }

  private configLabel(ports: Set<number>): Record<string, string> {
    const config = {
      image: this.options.image,
      workdir: this.workingDir,
      env: Object.entries(this.getMergedEnv()).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
      ports: [...ports].sort((a, b) => a - b),
      resources: {
        cpus: this.options.resources?.cpu ?? null,
        memoryMb: this.options.resources?.memoryMiB ?? null,
      },
      policy: this.options.provider?.allowHosts
        ? { allowHosts: [...new Set(this.options.provider.allowHosts)].sort() }
        : { network: this.options.provider?.network ?? true },
    };
    return {
      "agentbox.config": createHash("sha256")
        .update(JSON.stringify(config))
        .digest("hex"),
    };
  }

  private async ownedMachines(
    tags?: Record<string, string>,
  ): Promise<MachineSummary[]> {
    return Machine.list(this.connection, { labels: { ...tags, ...ownerLabel } });
  }

  async list(options?: SandboxListOptions): Promise<SandboxDescriptor[]> {
    return (await this.ownedMachines(options?.tags)).map((machine) => ({
      provider: this.provider,
      id: machine.id,
      state: machine.state,
      tags: machine.labels,
      createdAt: machine.createdAt,
      raw: machine,
    }));
  }

  private get readyMachine(): Machine {
    this.requireProvisioned();
    if (!this.machine) throw new Error("Smol machine is not provisioned.");
    return this.machine;
  }

  async run(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    const result = await this.readyMachine.exec(
      ["/bin/sh", "-c", toShellCommand(command)],
      {
        workdir: options?.cwd ?? this.workingDir,
        env: this.getMergedEnv(options?.env),
        ...(options?.timeoutMs
          ? { timeout: Math.ceil(options.timeoutMs / 1000) }
          : {}),
      },
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      combinedOutput: result.stdout + result.stderr,
      raw: result,
    };
  }

  async runAsync(
    command: string | string[],
    options?: CommandOptions,
  ): Promise<AsyncCommandHandle> {
    const machine = this.readyMachine;
    const abort = new AbortController();
    const queue = new AsyncQueue<CommandEvent>();
    const chunks = { stdout: "", stderr: "" };
    const completion = (async (): Promise<CommandResult> => {
      let exitCode: number | undefined;
      for await (const event of machine.execStream(
        ["/bin/sh", "-c", toShellCommand(command)],
        {
          workdir: options?.cwd ?? this.workingDir,
          env: this.getMergedEnv(options?.env),
          signal: abort.signal,
          ...(options?.timeoutMs
            ? { timeout: Math.ceil(options.timeoutMs / 1000) }
            : {}),
        },
      )) {
        if (event.kind === "error") throw new Error(event.message);
        if (event.kind === "exit") {
          exitCode = event.exitCode;
          queue.push({
            type: "exit",
            exitCode,
            timestamp: new Date().toISOString(),
          });
        } else {
          chunks[event.kind] += event.data;
          queue.push({
            type: event.kind,
            chunk: event.data,
            timestamp: new Date().toISOString(),
          });
        }
      }
      if (exitCode === undefined)
        throw new Error("Smol command stream ended without an exit status.");
      queue.finish();
      return {
        exitCode,
        ...chunks,
        combinedOutput: chunks.stdout + chunks.stderr,
      };
    })().catch((error: unknown) => {
      queue.fail(error);
      throw error;
    });
    suppressUnhandledRejection(completion);
    return {
      id: randomUUID(),
      wait: () => completion,
      kill: async () => {
        abort.abort(new Error("Smol command cancelled."));
        await completion.catch(() => undefined);
      },
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    };
  }

  async snapshot(): Promise<string | null> {
    this.requireProvisioned();
    return null;
  }
  private async closeCloudForwards(): Promise<void> {
    const forwards = [...this.cloudForwards.values()];
    this.cloudForwards.clear();
    await Promise.all(forwards.map(async (pending) => {
      const forward = await pending.catch(() => undefined);
      if (forward) await forward.close();
    }));
  }
  async stop(): Promise<void> {
    await this.closeCloudForwards();
    if (this.machine) await this.machine.stop();
  }
  async delete(): Promise<void> {
    await this.closeCloudForwards();
    if (this.machine) await this.machine.delete();
    this.machine = undefined;
  }
  async openPort(port: number): Promise<void> {
    if (this.machine && !this.publishedPorts.has(port)) {
      throw new Error(
        `Smol port ${port} must be opened before findOrProvision().`,
      );
    }
    this.declaredPorts.add(port);
  }
  async getPreviewLink(port: number): Promise<string> {
    const machine = this.readyMachine;
    if (!this.isCloud) return machine.endpoint(port).httpUrl;
    if (!this.publishedPorts.has(port)) {
      throw new Error(`Smol port ${port} must be opened before findOrProvision().`);
    }
    let pending = this.cloudForwards.get(port);
    if (!pending) {
      pending = openCloudForward(machine, port);
      this.cloudForwards.set(port, pending);
      void pending.catch(() => { this.cloudForwards.delete(port); });
    }
    return (await pending).url;
  }
  get previewHeaders(): Record<string, string> {
    return {};
  }
  async uploadFile(
    content: Buffer | string,
    targetPath: string,
  ): Promise<void> {
    const machine = this.readyMachine;
    const directory = posix.dirname(targetPath);
    const mkdir = await machine.exec(["mkdir", "-p", directory]);
    if (mkdir.exitCode !== 0)
      throw new Error(`Smol mkdir failed: ${mkdir.stderr}`);
    await machine.writeFile(targetPath, content);
  }
  async downloadFile(sourcePath: string): Promise<Buffer> {
    return this.readyMachine.readFile(sourcePath);
  }
}
