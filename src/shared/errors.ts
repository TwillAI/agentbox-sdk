export class AgentBoxError extends Error {
  readonly code?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    options?: { code?: string; cause?: unknown; details?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "AgentBoxError";
    this.code = options?.code;
    this.details = options?.details;
  }
}

export class UnsupportedProviderError extends AgentBoxError {
  constructor(kind: "agent" | "sandbox", provider: string) {
    super(`Unsupported ${kind} provider "${provider}".`, {
      code: "UNSUPPORTED_PROVIDER",
      details: { kind, provider },
    });
    this.name = "UnsupportedProviderError";
  }
}

export function invariant(
  condition: unknown,
  message: string,
  options?: { code?: string; details?: unknown },
): asserts condition {
  if (!condition) {
    throw new AgentBoxError(message, {
      code: options?.code ?? "INVARIANT_VIOLATION",
      details: options?.details,
    });
  }
}

export function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : JSON.stringify(error));
}

/**
 * Attach a no-op rejection handler to `promise` so a later rejection does not
 * surface as an "unhandledRejection" when callers happen to not await the
 * promise. The original `promise` is returned unchanged — consumers who do
 * await it still observe the error as usual.
 */
export function suppressUnhandledRejection<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}
