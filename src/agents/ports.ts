import { AgentProvider, type AgentProviderName } from "./types";

/**
 * Ports each agent harness needs exposed on its sandbox in order to reach
 * its app-server (or equivalent local server). These are used to:
 *
 *   1. Drive `sandbox.openPort(...)` at `Agent` construction time so providers
 *      whose `openPort` only mutates options before provisioning (Modal) still
 *      include the port.
 *   2. Pre-declare the ports on Modal sandboxes by default so that a Modal
 *      sandbox created without explicit `unencryptedPorts` still works when
 *      the caller later points an `Agent` at it.
 *
 * Exported so callers can forward the ports to sandbox creation options when
 * they know in advance which harness will be used (e.g.
 * `provider.unencryptedPorts: AGENT_RESERVED_PORTS.codex`).
 */
export const AGENT_RESERVED_PORTS: Record<AgentProviderName, readonly number[]> =
  {
    [AgentProvider.ClaudeCode]: [43180],
    [AgentProvider.Codex]: [43181],
    [AgentProvider.OpenCode]: [4096],
  };

export function collectAllAgentReservedPorts(): number[] {
  const seen = new Set<number>();
  for (const ports of Object.values(AGENT_RESERVED_PORTS)) {
    for (const port of ports) {
      seen.add(port);
    }
  }
  return Array.from(seen);
}
