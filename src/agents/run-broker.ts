import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

import type { AgentRun, UserContent } from "./types";

export interface RunRegistryEntry {
  run: AgentRun;
}

export class RunRegistry {
  private readonly runs = new Map<string, RunRegistryEntry>();

  register(runId: string, entry: RunRegistryEntry): void {
    this.runs.set(runId, entry);
  }

  unregister(runId: string): void {
    this.runs.delete(runId);
  }

  get(runId: string): RunRegistryEntry | undefined {
    return this.runs.get(runId);
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }
}

/**
 * Subset of the {@link Redis} client surface required by the broker.
 *
 * The broker is typed against ioredis (the most common Node Redis client) but
 * only relies on a small set of stream/string commands. Any client that exposes
 * the same shape (e.g. a pipeline or wrapper) can be passed in directly.
 */
export type RedisRunBrokerClient = Pick<
  Redis,
  "xadd" | "xread" | "set" | "get" | "del"
>;

export interface RedisRunCommandBrokerOptions {
  redis: RedisRunBrokerClient;
  registry: RunRegistry;
  streamKey?: string;
  ackKeyPrefix?: string;
  ackTtlSeconds?: number;
  pollIntervalMs?: number;
  commandTimeoutMs?: number;
}

export interface RunCommandOptions {
  commandId?: string;
  timeoutMs?: number;
}

type RunCommand =
  | {
      type: "sendMessage";
      runId: string;
      commandId: string;
      input: UserContent;
    }
  | {
      type: "abort";
      runId: string;
      commandId: string;
    };

type CommandAck = { ok: true } | { ok: false; error: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeFields(fields: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key !== undefined && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export class RedisRunCommandBroker {
  private readonly redis: RedisRunBrokerClient;
  private readonly registry: RunRegistry;
  private readonly streamKey: string;
  private readonly ackKeyPrefix: string;
  private readonly ackTtlSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly commandTimeoutMs: number;
  private readonly processedCommandIds = new Set<string>();
  private running = false;
  private listenPromise?: Promise<void>;
  private lastStreamId = "$";

  constructor(options: RedisRunCommandBrokerOptions) {
    this.redis = options.redis;
    this.registry = options.registry;
    this.streamKey = options.streamKey ?? "agentbox:runs:commands";
    this.ackKeyPrefix = options.ackKeyPrefix ?? "agentbox:runs:ack:";
    this.ackTtlSeconds = options.ackTtlSeconds ?? 60;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.listenPromise = this.listen();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.listenPromise?.catch(() => undefined);
  }

  async sendMessage(
    runId: string,
    input: UserContent,
    options?: RunCommandOptions,
  ): Promise<void> {
    await this.dispatchAndWait(
      {
        type: "sendMessage",
        runId,
        commandId: options?.commandId ?? randomUUID(),
        input,
      },
      options,
    );
  }

  async abort(runId: string, options?: RunCommandOptions): Promise<void> {
    await this.dispatchAndWait(
      {
        type: "abort",
        runId,
        commandId: options?.commandId ?? randomUUID(),
      },
      options,
    );
  }

  private ackKey(commandId: string): string {
    return `${this.ackKeyPrefix}${commandId}`;
  }

  private async dispatchAndWait(
    command: RunCommand,
    options?: RunCommandOptions,
  ): Promise<void> {
    const ackKey = this.ackKey(command.commandId);
    await this.redis.del(ackKey);
    await this.redis.xadd(
      this.streamKey,
      "*",
      "command",
      JSON.stringify(command),
    );

    const timeoutMs = options?.timeoutMs ?? this.commandTimeoutMs;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const ack = await this.redis.get(ackKey);
      if (ack) {
        await this.redis.del(ackKey);
        const parsed = JSON.parse(ack) as CommandAck;
        if (parsed.ok) {
          return;
        }
        throw new Error(parsed.error);
      }
      await sleep(this.pollIntervalMs);
    }

    throw new Error(`Timed out waiting for run command ${command.commandId}.`);
  }

  private async listen(): Promise<void> {
    while (this.running) {
      const response = await this.redis.xread(
        "BLOCK",
        5_000,
        "STREAMS",
        this.streamKey,
        this.lastStreamId,
      );
      if (!response) {
        continue;
      }

      for (const [, messages] of response) {
        for (const [id, fields] of messages) {
          this.lastStreamId = id;
          const decoded = decodeFields(fields);
          if (!decoded.command) {
            continue;
          }
          await this.handleCommand(decoded.command).catch(() => undefined);
        }
      }
    }
  }

  private async handleCommand(serialized: string): Promise<void> {
    const command = JSON.parse(serialized) as RunCommand;
    if (this.processedCommandIds.has(command.commandId)) {
      return;
    }
    const entry = this.registry.get(command.runId);
    if (!entry) {
      return;
    }

    this.processedCommandIds.add(command.commandId);
    try {
      if (command.type === "sendMessage") {
        await entry.run.sendMessage(command.input);
      } else if (command.type === "abort") {
        await entry.run.abort();
      }
      await this.writeAck(command.commandId, { ok: true });
    } catch (error) {
      await this.writeAck(command.commandId, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async writeAck(commandId: string, ack: CommandAck): Promise<void> {
    await this.redis.set(
      this.ackKey(commandId),
      JSON.stringify(ack),
      "EX",
      this.ackTtlSeconds,
    );
  }
}
