/**
 * Pure value-level provider enums.
 *
 * This file MUST NOT import anything from the rest of the SDK. It is used as
 * a standalone tsup entry (`agentbox-sdk/enums`) so that client-side bundles
 * in Next.js/browser contexts can reference `AgentProvider`/`SandboxProvider`
 * without pulling in server-only modules like `net`, `crypto`, or the sandbox
 * provider adapters.
 */

export const AgentProvider = {
  ClaudeCode: "claude-code",
  OpenCode: "open-code",
  Codex: "codex",
} as const;
export type AgentProvider = (typeof AgentProvider)[keyof typeof AgentProvider];

export const SandboxProvider = {
  LocalDocker: "local-docker",
  Modal: "modal",
  Daytona: "daytona",
  Vercel: "vercel",
  E2B: "e2b",
} as const;
export type SandboxProvider =
  (typeof SandboxProvider)[keyof typeof SandboxProvider];
