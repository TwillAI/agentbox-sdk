import type { AgentCostData } from "./types";

type UsageTotals = NonNullable<AgentCostData["usage"]>;

function addIfNumber(
  target: Record<string, number | undefined>,
  key: string,
  value: unknown,
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return;
  }
  target[key] = (target[key] ?? 0) + value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mergeUsage(
  target: UsageTotals,
  source: Record<string, unknown> | null,
): void {
  if (!source) {
    return;
  }

  addIfNumber(target, "input_tokens", source.input_tokens);
  addIfNumber(target, "input_tokens", source.inputTokens);
  addIfNumber(target, "input_tokens", source.input);
  addIfNumber(target, "output_tokens", source.output_tokens);
  addIfNumber(target, "output_tokens", source.outputTokens);
  addIfNumber(target, "output_tokens", source.output);
  addIfNumber(
    target,
    "cache_read_input_tokens",
    source.cache_read_input_tokens,
  );
  addIfNumber(target, "cache_read_input_tokens", source.cached_input_tokens);
  addIfNumber(target, "cache_read_input_tokens", source.cachedInputTokens);
  addIfNumber(
    target,
    "cache_creation_input_tokens",
    source.cache_creation_input_tokens,
  );
  addIfNumber(target, "cache_creation_input_tokens", source.cacheWrite);

  const cache = asRecord(source.cache);
  if (cache) {
    addIfNumber(target, "cache_read_input_tokens", cache.read);
    addIfNumber(target, "cache_creation_input_tokens", cache.write);
  }
}

function compactCostData(costData: AgentCostData): AgentCostData | null {
  const usage = costData.usage
    ? Object.fromEntries(
        Object.entries(costData.usage).filter(([, value]) => value !== 0),
      )
    : undefined;

  const compacted: AgentCostData = {
    ...(costData.total_cost_usd !== undefined
      ? { total_cost_usd: costData.total_cost_usd }
      : {}),
    ...(costData.duration_ms !== undefined
      ? { duration_ms: costData.duration_ms }
      : {}),
    ...(costData.duration_api_ms !== undefined
      ? { duration_api_ms: costData.duration_api_ms }
      : {}),
    ...(costData.num_turns !== undefined
      ? { num_turns: costData.num_turns }
      : {}),
    ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
  };

  return Object.keys(compacted).length > 0 ? compacted : null;
}

export function extractClaudeCostData(
  events: Array<Record<string, unknown>>,
): AgentCostData | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) {
      continue;
    }
    if (event.type !== "result") {
      continue;
    }

    const totalCost =
      typeof event.total_cost_usd === "number"
        ? event.total_cost_usd
        : undefined;
    const usage: UsageTotals = {};
    const modelUsage = asRecord(event.modelUsage);
    if (modelUsage) {
      for (const value of Object.values(modelUsage)) {
        mergeUsage(usage, asRecord(value));
      }
    }

    return compactCostData({
      ...(totalCost !== undefined ? { total_cost_usd: totalCost } : {}),
      duration_ms:
        typeof event.duration_ms === "number" ? event.duration_ms : undefined,
      duration_api_ms:
        typeof event.duration_api_ms === "number"
          ? event.duration_api_ms
          : undefined,
      num_turns:
        typeof event.num_turns === "number" ? event.num_turns : undefined,
      usage,
    });
  }

  return null;
}

export function extractCodexCostData(
  events: Array<Record<string, unknown>>,
): AgentCostData | null {
  const usage: UsageTotals = {};
  let sawUsage = false;

  for (const event of events) {
    const params = asRecord(event.params);
    const usageCandidate =
      asRecord(event.usage) ??
      asRecord(params?.usage) ??
      asRecord(params?.tokenUsage) ??
      asRecord(asRecord(params?.turn)?.usage) ??
      asRecord(asRecord(params?.turn)?.tokenUsage);

    if (usageCandidate) {
      sawUsage = true;
      mergeUsage(usage, usageCandidate);
    }
  }

  return sawUsage ? compactCostData({ usage }) : null;
}

export function extractOpenCodeCostData(
  events: Array<Record<string, unknown>>,
): AgentCostData | null {
  const usage: UsageTotals = {};
  let totalCost = 0;
  let sawCostData = false;

  for (const event of events) {
    const properties = asRecord(event.properties);
    const part = asRecord(properties?.part) ?? asRecord(event.part);
    if (part?.type !== "step-finish") {
      continue;
    }

    if (typeof part.cost === "number") {
      totalCost += part.cost;
      sawCostData = true;
    }

    const tokens = asRecord(part.tokens);
    if (tokens) {
      sawCostData = true;
      mergeUsage(usage, tokens);
    }
  }

  return sawCostData
    ? compactCostData({
        ...(totalCost > 0 ? { total_cost_usd: totalCost } : {}),
        usage,
      })
    : null;
}
