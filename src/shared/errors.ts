export class OpenAgentError extends Error {
  readonly code?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    options?: { code?: string; cause?: unknown; details?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "OpenAgentError";
    this.code = options?.code;
    this.details = options?.details;
  }
}

export class UnsupportedProviderError extends OpenAgentError {
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
    throw new OpenAgentError(message, {
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
