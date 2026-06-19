import crypto from "node:crypto";

import type { Sandbox } from "../../sandboxes";
import { shellQuote } from "../../shared/shell";

/**
 * Per-sandbox capability token shared by providers whose in-sandbox server is
 * reachable over the (public) Daytona preview URL.
 *
 * Daytona sandboxes are created `public: true` so the user-facing app preview
 * stays publicly accessible — but that same flag also exposes the agent CLI
 * server ports. The token closes that hole at the application layer: it is
 * minted once at setup, written to a 0600 file inside the sandbox, and
 * required by the server on every request. The host reads the same file to
 * attach `Authorization: Bearer <token>`.
 *
 * The sandbox file is the cross-instance rendezvous: Twill spans many Cloud
 * Run instances, and a follow-up job or a stateless cross-instance attach may
 * land on a different instance than the one that ran setup. That instance
 * reads the token off the sandbox file (cold cache) to authenticate — no
 * shared store, mirroring the "any instance can reach any sandbox by id"
 * property of the public-URL model. This mirrors the codex app-server's
 * `--ws-auth capability-token` model (which the codex binary enforces
 * natively) for the providers whose server we own (claude-code daemon) or
 * front with native auth (opencode).
 */

// Resolved tokens are memoized per (sandbox, tokenFilePath). A run that lands
// on a different Twill instance starts with a cold cache and reads the file.
const tokenCache = new WeakMap<Sandbox, Map<string, Promise<string>>>();

export async function readCapabilityTokenFile(
  sandbox: Sandbox,
  tokenFilePath: string,
): Promise<string | undefined> {
  const result = await sandbox.run(
    `if [ -f ${shellQuote(tokenFilePath)} ]; then cat ${shellQuote(tokenFilePath)}; fi`,
  );
  if (result.exitCode !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}

/**
 * Resolve the capability token for `tokenFilePath`, memoized per sandbox.
 * With `create: true` (setup path) a fresh 32-byte token is minted when the
 * file is absent; otherwise (connect/attach path) a missing file is a hard
 * error — setup() must have run first. On failure the cache entry is evicted
 * so a transient `sandbox.run` error doesn't permanently poison later reads.
 */
export function resolveCapabilityToken(
  sandbox: Sandbox,
  tokenFilePath: string,
  create: boolean,
): Promise<string> {
  let byPath = tokenCache.get(sandbox);
  if (!byPath) {
    byPath = new Map();
    tokenCache.set(sandbox, byPath);
  }
  const map = byPath;
  let cached = map.get(tokenFilePath);
  if (!cached) {
    const pending = (async () => {
      const existing = await readCapabilityTokenFile(sandbox, tokenFilePath);
      if (existing) return existing;
      if (create) return crypto.randomBytes(32).toString("hex");
      throw new Error(
        `Capability token file is missing at ${tokenFilePath}. ` +
          `setup() must run before connecting to this sandbox server.`,
      );
    })().catch((error) => {
      map.delete(tokenFilePath);
      throw error;
    });
    map.set(tokenFilePath, pending);
    cached = pending;
  }
  return cached;
}

export function withBearerToken(
  base: Record<string, string>,
  token: string,
): Record<string, string> {
  return { ...base, Authorization: `Bearer ${token}` };
}
