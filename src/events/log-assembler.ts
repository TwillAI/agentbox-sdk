/**
 * Provider-aware log assembler for agentbox runs.
 *
 * Agentbox streams a sequence of raw provider events (deltas of text /
 * reasoning / tool calls) for each `AgentRun` via `run.rawEvents()`. Most UIs
 * ultimately want a stable "snapshot per item" view (one box per assistant
 * message, one box per shell command, etc.) instead of the raw delta stream.
 *
 * This module converts deltas into snapshots while remaining transport- and
 * persistence-agnostic so it can run in any environment that consumes the
 * SDK's raw event stream:
 *
 *   - Server processes (e.g. orchestrators, log persisters) can call
 *     `process()` to derive snapshots they push into a history store, then
 *     persist a deduped view at end of run via the static `dedupeSnapshots`.
 *   - Browser/UI clients can `seedFromSnapshots()` from a replayed history
 *     and re-run `process()` over live deltas to keep state aligned with the
 *     server without duplicating normalization logic.
 *
 * Constraints:
 *   - No Node-only imports; this module must run in the browser. The
 *     `agentbox-sdk/events` entrypoint is therefore safe for client bundles.
 *   - Pure logic; transports (Redis, SSE, websockets, files, …) are entirely
 *     the responsibility of the caller.
 */

import { AgentProvider } from "../enums";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class CodexLogAssembler {
  private readonly byItemId = new Map<string, JsonRecord>();
  private readonly textByItemId = new Map<string, string>();

  process(event: unknown): JsonRecord[] {
    if (!isRecord(event)) {
      return [];
    }

    const method = typeof event.method === "string" ? event.method : undefined;
    const params = isRecord(event.params) ? event.params : {};
    const item = isRecord(params.item) ? clone(params.item) : null;

    if (
      method === "item/started" ||
      method === "item/updated" ||
      method === "item/completed"
    ) {
      if (item && typeof item.id === "string") {
        this.byItemId.set(item.id, clone(event));
        const text = typeof item.text === "string" ? item.text : undefined;
        if (text !== undefined) {
          this.textByItemId.set(item.id, text);
        }
        const aggregated =
          typeof item.aggregated_output === "string"
            ? item.aggregated_output
            : undefined;
        if (aggregated !== undefined) {
          this.textByItemId.set(item.id, aggregated);
        }
      }
      return [clone(event)];
    }

    if (method === "item/agentMessage/delta") {
      const itemId = typeof params.itemId === "string" ? params.itemId : null;
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (!itemId || !delta) return [];
      const text = (this.textByItemId.get(itemId) ?? "") + delta;
      this.textByItemId.set(itemId, text);
      return [this.upsertItem(itemId, "agentMessage", { text })];
    }

    if (
      method === "item/reasoning/summaryTextDelta" ||
      method === "item/reasoning/textDelta"
    ) {
      const itemId = typeof params.itemId === "string" ? params.itemId : null;
      const delta =
        typeof params.delta === "string"
          ? params.delta
          : typeof params.text === "string"
            ? params.text
            : "";
      if (!itemId || !delta) return [];
      const text = (this.textByItemId.get(itemId) ?? "") + delta;
      this.textByItemId.set(itemId, text);
      return [
        this.upsertItem(itemId, "reasoning", {
          summary: text,
          text,
        }),
      ];
    }

    if (method === "item/commandExecution/outputDelta") {
      const itemId = typeof params.itemId === "string" ? params.itemId : null;
      const chunk =
        typeof params.chunk === "string"
          ? params.chunk
          : typeof params.delta === "string"
            ? params.delta
            : typeof params.text === "string"
              ? params.text
              : "";
      if (!itemId || !chunk) return [];
      const text = (this.textByItemId.get(itemId) ?? "") + chunk;
      this.textByItemId.set(itemId, text);
      return [
        this.upsertItem(itemId, "commandExecution", {
          aggregatedOutput: text,
          status: "inProgress",
        }),
      ];
    }

    return [clone(event)];
  }

  /**
   * Repopulate state from a sequence of previously-assembled snapshots so the
   * assembler can resume mid-run (used by reconnecting UI clients).
   */
  seed(snapshots: JsonRecord[]): void {
    this.byItemId.clear();
    this.textByItemId.clear();
    for (const snapshot of snapshots) {
      if (!isRecord(snapshot)) continue;
      const params = isRecord(snapshot.params) ? snapshot.params : {};
      const item = isRecord(params.item) ? params.item : null;
      if (!item || typeof item.id !== "string") continue;
      this.byItemId.set(item.id, clone(snapshot));
      const text = typeof item.text === "string" ? item.text : undefined;
      if (text !== undefined) {
        this.textByItemId.set(item.id, text);
      }
      const aggregated =
        typeof item.aggregated_output === "string"
          ? item.aggregated_output
          : undefined;
      if (aggregated !== undefined) {
        this.textByItemId.set(item.id, aggregated);
      }
    }
  }

  private upsertItem(
    itemId: string,
    itemType: string,
    patch: JsonRecord,
  ): JsonRecord {
    const existing = this.byItemId.get(itemId);
    const existingParams = isRecord(existing?.params) ? existing.params : {};
    const existingItem = isRecord(existingParams.item)
      ? existingParams.item
      : {};
    const next: JsonRecord = {
      method: "item/updated",
      params: {
        ...existingParams,
        item: {
          ...existingItem,
          id: itemId,
          type: itemType,
          ...patch,
        },
      },
    };
    this.byItemId.set(itemId, next);
    return clone(next);
  }

  getSnapshots(): JsonRecord[] {
    return Array.from(this.byItemId.values()).map(clone);
  }
}

class OpenCodeLogAssembler {
  private readonly userMessageIds = new Set<string>();
  private readonly textByPartId = new Map<string, string>();
  private readonly byPartId = new Map<string, JsonRecord>();
  // Sub-agent (`task` tool) linkage. opencode multiplexes the parent task
  // tool's `state.metadata.sessionId` update and the child session's first
  // stream events onto the same SSE bus with no ordering guarantee, so
  // child events frequently arrive before the parent has published its
  // child sessionID. We bind FIFO instead: every task tool we see goes
  // onto a queue; the first non-main sessionID that lacks an explicit
  // binding gets paired with the queue head. Once a binding is established
  // we stamp every emitted snapshot for that child session with
  // `parentTaskCallId` on the part so consumers don't have to re-derive
  // the linkage from snapshots.
  private mainSessionID: string | null = null;
  private pendingTaskCallIds: string[] = [];
  private readonly childSessionToTaskCallId = new Map<string, string>();
  private readonly childMessageIdToTaskCallId = new Map<string, string>();
  private readonly messageIdToSessionId = new Map<string, string>();

  process(event: unknown): JsonRecord[] {
    if (!isRecord(event)) {
      return [];
    }

    const type = typeof event.type === "string" ? event.type : "";
    const properties = isRecord(event.properties) ? event.properties : {};
    const info = isRecord(properties.info) ? properties.info : null;
    const eventPart = isRecord(properties.part)
      ? properties.part
      : isRecord(event.part)
        ? event.part
        : null;

    // 1. Capture the main sessionID from the first event that carries one.
    if (this.mainSessionID === null) {
      const candidate =
        (typeof info?.sessionID === "string" ? info.sessionID : null) ??
        (eventPart && typeof eventPart.sessionID === "string"
          ? eventPart.sessionID
          : null) ??
        (typeof properties.sessionID === "string"
          ? properties.sessionID
          : null);
      if (candidate) this.mainSessionID = candidate;
    }

    // 2. Index messageID -> sessionID for any event that exposes both.
    if (
      info &&
      typeof info.id === "string" &&
      typeof info.sessionID === "string"
    ) {
      this.messageIdToSessionId.set(info.id, info.sessionID);
    }
    if (
      eventPart &&
      typeof eventPart.id === "string" &&
      typeof eventPart.messageID === "string" &&
      typeof eventPart.sessionID === "string"
    ) {
      this.messageIdToSessionId.set(eventPart.messageID, eventPart.sessionID);
    }

    // 3. Handle task tool emissions — either bind explicitly via
    //    `state.metadata.sessionId` or enqueue for FIFO binding.
    if (eventPart && this.isTaskToolPart(eventPart)) {
      const callId =
        typeof eventPart.callID === "string"
          ? eventPart.callID
          : typeof eventPart.id === "string"
            ? eventPart.id
            : null;
      if (callId) {
        const metaSid = this.extractTaskMetadataSessionId(eventPart);
        if (metaSid && !this.childSessionToTaskCallId.has(metaSid)) {
          this.childSessionToTaskCallId.set(metaSid, callId);
          // Drop the callId from the pending queue if it was enqueued first.
          this.pendingTaskCallIds = this.pendingTaskCallIds.filter(
            (id) => id !== callId,
          );
        } else if (!metaSid) {
          // Enqueue if not already bound and not already queued. Without
          // the dedup we'd push the same callId on every subsequent
          // update (most task parts emit multiple times as the run
          // progresses).
          const alreadyBound = this.taskCallIdAlreadyBound(callId);
          if (!alreadyBound && !this.pendingTaskCallIds.includes(callId)) {
            this.pendingTaskCallIds.push(callId);
          }
        }
      }
    }

    // 4. Bind orphan child sessionID FIFO.
    const effectiveSid = this.extractSessionID(properties, eventPart, info);
    if (
      effectiveSid &&
      effectiveSid !== this.mainSessionID &&
      !this.childSessionToTaskCallId.has(effectiveSid) &&
      this.pendingTaskCallIds.length > 0
    ) {
      const taskCallId = this.pendingTaskCallIds.shift() as string;
      this.childSessionToTaskCallId.set(effectiveSid, taskCallId);
    }

    // 5. User message tracking (existing behavior). User messages don't get
    //    `parentTaskCallId` — they're the root of the conversation.
    if (
      type === "message.updated" &&
      typeof info?.id === "string" &&
      info.role === "user"
    ) {
      this.userMessageIds.add(info.id);
      return [clone(event)];
    }

    // 6. Derive `parentTaskCallId` for the snapshot we're about to emit.
    const parentTaskCallId = this.resolveParentTaskCallId(
      effectiveSid,
      eventPart,
      info,
    );

    if (type === "message.part.delta") {
      const partId =
        typeof properties.partID === "string" ? properties.partID : null;
      const messageId =
        typeof properties.messageID === "string" ? properties.messageID : null;
      const delta =
        typeof properties.delta === "string" ? properties.delta : "";
      if (
        !partId ||
        !delta ||
        properties.field !== "text" ||
        (messageId && this.userMessageIds.has(messageId))
      ) {
        return [];
      }
      // Carry the messageID -> sessionID mapping through so we can resolve
      // parents for later events that only know the messageID.
      if (messageId && effectiveSid) {
        this.messageIdToSessionId.set(messageId, effectiveSid);
      }

      const text = (this.textByPartId.get(partId) ?? "") + delta;
      this.textByPartId.set(partId, text);
      const part: JsonRecord = {
        id: partId,
        messageID: messageId ?? undefined,
        type: "text",
        text,
      };
      if (parentTaskCallId) {
        part.parentTaskCallId = parentTaskCallId;
        if (messageId) {
          this.childMessageIdToTaskCallId.set(messageId, parentTaskCallId);
        }
      }
      return [this.upsertPart(partId, part)];
    }

    if (eventPart && typeof eventPart.id === "string") {
      if (
        eventPart.messageID &&
        this.userMessageIds.has(String(eventPart.messageID))
      ) {
        return [];
      }
      const previous = this.byPartId.get(eventPart.id);
      if (
        eventPart.type === "text" &&
        previous &&
        isRecord((previous.properties as JsonRecord | undefined)?.part)
      ) {
        const previousPart = (previous.properties as JsonRecord)
          .part as JsonRecord;
        const previousText =
          typeof previousPart.text === "string" ? previousPart.text : "";
        const nextText =
          typeof eventPart.text === "string" ? eventPart.text : "";
        if (nextText.length < previousText.length) {
          return [clone(previous)];
        }
      }
      const enriched = clone(event);
      if (parentTaskCallId) {
        this.stampParentTaskCallId(enriched, parentTaskCallId);
        if (typeof eventPart.messageID === "string") {
          this.childMessageIdToTaskCallId.set(
            eventPart.messageID,
            parentTaskCallId,
          );
        }
      }
      this.byPartId.set(eventPart.id, enriched);
      return [clone(enriched)];
    }

    return [clone(event)];
  }

  seed(snapshots: JsonRecord[]): void {
    this.userMessageIds.clear();
    this.textByPartId.clear();
    this.byPartId.clear();
    this.mainSessionID = null;
    this.pendingTaskCallIds = [];
    this.childSessionToTaskCallId.clear();
    this.childMessageIdToTaskCallId.clear();
    this.messageIdToSessionId.clear();
    for (const snapshot of snapshots) {
      if (!isRecord(snapshot)) continue;
      const type = typeof snapshot.type === "string" ? snapshot.type : "";
      const properties = isRecord(snapshot.properties)
        ? snapshot.properties
        : {};
      const info = isRecord(properties.info) ? properties.info : null;
      // Restore mainSessionID from the first session-bearing snapshot.
      if (this.mainSessionID === null) {
        const candidate =
          (typeof info?.sessionID === "string" ? info.sessionID : null) ??
          (typeof properties.sessionID === "string"
            ? properties.sessionID
            : null);
        if (candidate) this.mainSessionID = candidate;
      }
      if (
        info &&
        typeof info.id === "string" &&
        typeof info.sessionID === "string"
      ) {
        this.messageIdToSessionId.set(info.id, info.sessionID);
      }
      if (
        type === "message.updated" &&
        typeof info?.id === "string" &&
        info.role === "user"
      ) {
        this.userMessageIds.add(info.id);
        continue;
      }
      const part = isRecord(properties.part)
        ? properties.part
        : isRecord(snapshot.part)
          ? snapshot.part
          : null;
      if (part && typeof part.id === "string") {
        this.byPartId.set(part.id, clone(snapshot));
        if (typeof part.text === "string") {
          this.textByPartId.set(part.id, part.text);
        }
        if (
          typeof part.messageID === "string" &&
          typeof part.sessionID === "string"
        ) {
          this.messageIdToSessionId.set(part.messageID, part.sessionID);
        }
        // Restore linkage from already-stamped snapshots (forward
        // compatibility when reseeding from persisted history).
        if (typeof part.parentTaskCallId === "string") {
          if (
            typeof part.sessionID === "string" &&
            !this.childSessionToTaskCallId.has(part.sessionID)
          ) {
            this.childSessionToTaskCallId.set(
              part.sessionID,
              part.parentTaskCallId,
            );
          }
          if (typeof part.messageID === "string") {
            this.childMessageIdToTaskCallId.set(
              part.messageID,
              part.parentTaskCallId,
            );
          }
        }
        // Restore explicit task-tool metadata bindings.
        if (this.isTaskToolPart(part)) {
          const callId =
            typeof part.callID === "string"
              ? part.callID
              : typeof part.id === "string"
                ? part.id
                : null;
          const metaSid = this.extractTaskMetadataSessionId(part);
          if (
            callId &&
            metaSid &&
            !this.childSessionToTaskCallId.has(metaSid)
          ) {
            this.childSessionToTaskCallId.set(metaSid, callId);
          }
        }
      }
    }
  }

  private isTaskToolPart(part: JsonRecord): boolean {
    if (part.type !== "tool") return false;
    const tool = typeof part.tool === "string" ? part.tool.toLowerCase() : "";
    return tool === "task";
  }

  private taskCallIdAlreadyBound(callId: string): boolean {
    for (const v of this.childSessionToTaskCallId.values()) {
      if (v === callId) return true;
    }
    return false;
  }

  private extractTaskMetadataSessionId(part: JsonRecord): string | null {
    const state = isRecord(part.state) ? part.state : null;
    const metadata =
      state && isRecord(state.metadata) ? (state.metadata as JsonRecord) : null;
    if (!metadata) return null;
    if (typeof metadata.sessionId === "string") return metadata.sessionId;
    if (typeof metadata.sessionID === "string") return metadata.sessionID;
    return null;
  }

  private extractSessionID(
    properties: JsonRecord,
    part: JsonRecord | null,
    info: JsonRecord | null,
  ): string | null {
    if (typeof properties.sessionID === "string") return properties.sessionID;
    if (part && typeof part.sessionID === "string") return part.sessionID;
    if (info && typeof info.sessionID === "string") return info.sessionID;
    return null;
  }

  private resolveParentTaskCallId(
    sessionID: string | null,
    part: JsonRecord | null,
    info: JsonRecord | null,
  ): string | null {
    if (sessionID && this.childSessionToTaskCallId.has(sessionID)) {
      return this.childSessionToTaskCallId.get(sessionID) ?? null;
    }
    const candidateMessageIds: string[] = [];
    if (part && typeof part.messageID === "string") {
      candidateMessageIds.push(part.messageID);
    }
    if (info && typeof info.id === "string") {
      candidateMessageIds.push(info.id);
    }
    for (const messageId of candidateMessageIds) {
      const cached = this.childMessageIdToTaskCallId.get(messageId);
      if (cached) return cached;
      const mappedSid = this.messageIdToSessionId.get(messageId);
      if (mappedSid && this.childSessionToTaskCallId.has(mappedSid)) {
        const tcid = this.childSessionToTaskCallId.get(mappedSid) as string;
        this.childMessageIdToTaskCallId.set(messageId, tcid);
        return tcid;
      }
    }
    return null;
  }

  private stampParentTaskCallId(
    snapshot: JsonRecord,
    parentTaskCallId: string,
  ): void {
    const properties = isRecord(snapshot.properties)
      ? (snapshot.properties as JsonRecord)
      : null;
    const part =
      properties && isRecord(properties.part)
        ? (properties.part as JsonRecord)
        : isRecord(snapshot.part)
          ? (snapshot.part as JsonRecord)
          : null;
    if (part) {
      part.parentTaskCallId = parentTaskCallId;
    }
  }

  private upsertPart(partId: string, part: JsonRecord): JsonRecord {
    const next: JsonRecord = {
      type: "message.part.updated",
      properties: {
        partID: partId,
        part,
      },
    };
    this.byPartId.set(partId, next);
    return clone(next);
  }

  getSnapshots(): JsonRecord[] {
    return Array.from(this.byPartId.values()).map(clone);
  }
}

class ClaudeCodeLogAssembler {
  private currentMessageId: string | null = null;
  private readonly textByMessageId = new Map<string, string>();
  private readonly thinkingByMessageId = new Map<string, string>();
  private readonly byMessageId = new Map<string, JsonRecord>();
  // Per-message tool_use / image / other non-text-non-thinking content blocks.
  // Tracked persistently so any `upsertMessage` call (including those from a
  // post-assistant `message_start` re-anchor) still renders them — otherwise
  // a later stream_event for the same messageId would emit a snapshot without
  // tool_use blocks, and the UI's dedup-by-messageId would wipe the running
  // command from the trace.
  private readonly extraBlocksByMessageId = new Map<
    string,
    Map<string, JsonRecord>
  >();

  process(event: unknown): JsonRecord[] {
    if (!isRecord(event)) return [];

    const type = typeof event.type === "string" ? event.type : "";

    if (type === "stream_event") {
      const stream = isRecord(event.event) ? event.event : null;
      if (!stream) return [];
      const streamType = typeof stream.type === "string" ? stream.type : "";

      if (streamType === "message_start") {
        const message = isRecord(stream.message) ? stream.message : null;
        const id =
          message && typeof message.id === "string" ? message.id : null;
        if (!id) return [];
        this.currentMessageId = id;
        if (!this.textByMessageId.has(id)) this.textByMessageId.set(id, "");
        if (!this.thinkingByMessageId.has(id))
          this.thinkingByMessageId.set(id, "");
        return [this.upsertMessage(id)];
      }

      if (streamType === "content_block_delta") {
        const id = this.currentMessageId;
        if (!id) return [];
        const delta = isRecord(stream.delta) ? stream.delta : null;
        if (!delta) return [];
        if (
          delta.type === "text_delta" &&
          typeof delta.text === "string" &&
          delta.text
        ) {
          const text = (this.textByMessageId.get(id) ?? "") + delta.text;
          this.textByMessageId.set(id, text);
          return [this.upsertMessage(id)];
        }
        if (
          delta.type === "thinking_delta" &&
          typeof delta.thinking === "string" &&
          delta.thinking
        ) {
          const thinking =
            (this.thinkingByMessageId.get(id) ?? "") + delta.thinking;
          this.thinkingByMessageId.set(id, thinking);
          return [this.upsertMessage(id)];
        }
        return [];
      }

      // content_block_start/stop, message_delta, message_stop are intentionally
      // dropped — their per-event uuids would pollute the assembled stream and
      // their state is captured via deltas / the final assistant message.
      return [];
    }

    if (type === "assistant") {
      const message = isRecord(event.message) ? event.message : null;
      const id = message && typeof message.id === "string" ? message.id : null;
      if (!id || !message) {
        return [clone(event)];
      }

      const final = extractClaudeAssistantContent(message);
      this.textByMessageId.set(id, final.text);
      // Don't clobber streamed thinking with an empty final.thinking. With
      // `thinking: { display: "summarized" }` (what claude-code currently
      // configures), the SDK ships thinking only via `thinking_delta` stream
      // events — the final assistant SDKMessage has no thinking block, so
      // overwriting would erase the accumulated stream and the persisted
      // snapshot would lose all reasoning.
      if (final.thinking) {
        this.thinkingByMessageId.set(id, final.thinking);
      }
      this.mergeExtraBlocks(id, final.extraBlocks);
      const snapshot = this.upsertMessage(id);
      this.currentMessageId = null;
      return [snapshot];
    }

    return [clone(event)];
  }

  seed(snapshots: JsonRecord[]): void {
    this.currentMessageId = null;
    this.textByMessageId.clear();
    this.thinkingByMessageId.clear();
    this.byMessageId.clear();
    this.extraBlocksByMessageId.clear();

    for (const snapshot of snapshots) {
      if (!isRecord(snapshot)) continue;
      if (snapshot.type !== "message.updated") continue;
      const messageId =
        typeof snapshot.messageId === "string" ? snapshot.messageId : null;
      if (!messageId) continue;
      this.byMessageId.set(messageId, clone(snapshot));
      const message = isRecord(snapshot.message) ? snapshot.message : null;
      const content =
        message && Array.isArray(message.content) ? message.content : [];
      let text = "";
      let thinking = "";
      const extraBlocks: JsonRecord[] = [];
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          text += block.text;
        } else if (
          block.type === "thinking" &&
          typeof block.thinking === "string"
        ) {
          thinking += block.thinking;
        } else {
          extraBlocks.push(block);
        }
      }
      this.textByMessageId.set(messageId, text);
      this.thinkingByMessageId.set(messageId, thinking);
      if (extraBlocks.length > 0) {
        this.mergeExtraBlocks(messageId, extraBlocks);
      }
    }
  }

  private mergeExtraBlocks(messageId: string, blocks: JsonRecord[]): void {
    if (blocks.length === 0) return;
    let map = this.extraBlocksByMessageId.get(messageId);
    if (!map) {
      map = new Map<string, JsonRecord>();
      this.extraBlocksByMessageId.set(messageId, map);
    }
    for (const block of blocks) {
      // Prefer block.id (tool_use, server_tool_use, etc. all carry one) so
      // repeated emissions of the same logical block update in-place. Fall
      // back to a synthetic key based on insertion order so blocks without
      // ids still de-duplicate across repeated assistant emissions.
      const key =
        typeof block.id === "string" && block.id
          ? `id:${block.id}`
          : `idx:${map.size}`;
      map.set(key, clone(block));
    }
  }

  private upsertMessage(messageId: string): JsonRecord {
    const text = this.textByMessageId.get(messageId) ?? "";
    const thinking = this.thinkingByMessageId.get(messageId) ?? "";
    const content: JsonRecord[] = [];
    // Thinking precedes text in the model's actual output order; keep that
    // order in the snapshot so consumers render reasoning before the answer.
    if (thinking) content.push({ type: "thinking", thinking });
    if (text) content.push({ type: "text", text });
    const extras = this.extraBlocksByMessageId.get(messageId);
    if (extras) {
      for (const block of extras.values()) content.push(clone(block));
    }

    const next: JsonRecord = {
      type: "message.updated",
      messageId,
      message: {
        id: messageId,
        role: "assistant",
        content,
      },
    };
    this.byMessageId.set(messageId, next);
    return clone(next);
  }

  getSnapshots(): JsonRecord[] {
    return Array.from(this.byMessageId.values()).map(clone);
  }
}

function extractClaudeAssistantContent(message: JsonRecord): {
  text: string;
  thinking: string;
  extraBlocks: JsonRecord[];
} {
  const content = Array.isArray(message.content) ? message.content : [];
  let text = "";
  let thinking = "";
  const extraBlocks: JsonRecord[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (
      block.type === "thinking" &&
      typeof block.thinking === "string"
    ) {
      thinking += block.thinking;
    } else {
      extraBlocks.push(clone(block));
    }
  }
  return { text, thinking, extraBlocks };
}

/**
 * Provider-aware assembler that routes raw events through the right
 * per-provider implementation. Stateful: holds dedup/text maps so it can
 * incrementally combine deltas into snapshots.
 *
 * @example Server-side use during an `AgentRun`:
 * ```ts
 * const assembler = new ProviderLogAssembler();
 * for await (const raw of run.rawEvents()) {
 *   const snapshots = assembler.process(raw.provider, raw.payload);
 *   for (const snapshot of snapshots) historyStore.append(snapshot);
 * }
 * ```
 *
 * @example Reconnecting UI client:
 * ```ts
 * const assembler = new ProviderLogAssembler();
 * const history = await fetchHistorySnapshots();
 * assembler.seedFromSnapshots(provider, history);
 * subscribeRawDeltas((event) => {
 *   const snapshots = assembler.process(provider, event);
 *   render(snapshots);
 * });
 * ```
 */
export class ProviderLogAssembler {
  private readonly codex = new CodexLogAssembler();
  private readonly openCode = new OpenCodeLogAssembler();
  private readonly claudeCode = new ClaudeCodeLogAssembler();

  /**
   * Process a raw provider event and return any newly-produced assembled
   * snapshots. May return an empty array when the event is non-stateful (e.g.
   * a delta with no payload) or already represented by a previous snapshot.
   */
  process(
    provider: AgentProvider | string | null | undefined,
    event: unknown,
  ): JsonRecord[] {
    if (provider === AgentProvider.Codex || provider === "codex") {
      return this.codex.process(event);
    }
    if (provider === AgentProvider.OpenCode || provider === "opencode") {
      return this.openCode.process(event);
    }
    if (provider === AgentProvider.ClaudeCode || provider === "claude-code") {
      return this.claudeCode.process(event);
    }
    if (isRecord(event)) {
      return [clone(event)];
    }
    return [];
  }

  /**
   * Return the current deduped snapshot set held by the active per-provider
   * assembler. Equivalent to running `dedupeSnapshots` over the full sequence
   * of snapshots emitted by `process()` since construction (or last seed), but
   * read directly from in-memory state — no transport or persistence layer
   * involved. Used end-of-run to persist the full trace without paying a
   * Redis LRANGE + parse roundtrip.
   *
   * Snapshots are returned in first-seen order (Map insertion order). Entries
   * are cloned, so the caller can serialize them freely.
   */
  getSnapshots(
    provider: AgentProvider | string | null | undefined,
  ): JsonRecord[] {
    if (provider === AgentProvider.Codex || provider === "codex") {
      return this.codex.getSnapshots();
    }
    if (provider === AgentProvider.OpenCode || provider === "opencode") {
      return this.openCode.getSnapshots();
    }
    if (provider === AgentProvider.ClaudeCode || provider === "claude-code") {
      return this.claudeCode.getSnapshots();
    }
    return [];
  }

  /**
   * Re-seed the assembler from a sequence of previously-assembled snapshots
   * so that subsequent `process()` calls produce snapshots consistent with
   * the server-side state. Used by reconnecting UI clients after they replay
   * the persisted history.
   */
  seedFromSnapshots(
    provider: AgentProvider | string | null | undefined,
    snapshots: JsonRecord[],
  ): void {
    if (provider === AgentProvider.Codex || provider === "codex") {
      this.codex.seed(snapshots);
      return;
    }
    if (provider === AgentProvider.OpenCode || provider === "opencode") {
      this.openCode.seed(snapshots);
      return;
    }
    if (provider === AgentProvider.ClaudeCode || provider === "claude-code") {
      this.claudeCode.seed(snapshots);
      return;
    }
  }

  /**
   * Given a sequence of assembled snapshots (typically the persisted history
   * for a run), return one entry per item / part with the latest snapshot
   * winning, preserving first-seen order.
   *
   * For unrecognized snapshot shapes, entries are returned in original order
   * with no dedup.
   */
  static dedupeSnapshots(
    provider: AgentProvider | string | null | undefined,
    snapshots: JsonRecord[],
  ): JsonRecord[] {
    if (provider === AgentProvider.Codex || provider === "codex") {
      return dedupeByKey(snapshots, (snapshot) => {
        const params = isRecord(snapshot.params) ? snapshot.params : null;
        const item = params && isRecord(params.item) ? params.item : null;
        return item && typeof item.id === "string" ? `item:${item.id}` : null;
      });
    }
    if (provider === AgentProvider.ClaudeCode || provider === "claude-code") {
      return dedupeByKey(snapshots, (snapshot) => {
        const messageId =
          typeof snapshot.messageId === "string" ? snapshot.messageId : null;
        return messageId ? `message:${messageId}` : null;
      });
    }
    if (provider === AgentProvider.OpenCode || provider === "opencode") {
      return dedupeByKey(snapshots, (snapshot) => {
        const properties = isRecord(snapshot.properties)
          ? snapshot.properties
          : null;
        const part =
          properties && isRecord(properties.part)
            ? properties.part
            : isRecord(snapshot.part)
              ? (snapshot.part as JsonRecord)
              : null;
        if (part && typeof part.id === "string") {
          return `part:${part.id}`;
        }
        const info =
          properties && isRecord(properties.info) ? properties.info : null;
        if (info && typeof info.id === "string") {
          return `message:${info.id}`;
        }
        return null;
      });
    }
    return snapshots.map(clone);
  }
}

function dedupeByKey(
  snapshots: JsonRecord[],
  keyOf: (snapshot: JsonRecord) => string | null,
): JsonRecord[] {
  const order: string[] = [];
  const latestByKey = new Map<string, JsonRecord>();
  const passthrough: JsonRecord[] = [];

  snapshots.forEach((snapshot, index) => {
    if (!isRecord(snapshot)) return;
    const key = keyOf(snapshot);
    if (!key) {
      passthrough.push(clone(snapshot));
      order.push(`pt:${index}`);
      latestByKey.set(`pt:${index}`, clone(snapshot));
      return;
    }
    if (!latestByKey.has(key)) {
      order.push(key);
    }
    latestByKey.set(key, clone(snapshot));
  });

  return order.map((key) => latestByKey.get(key)!).filter(Boolean);
}
