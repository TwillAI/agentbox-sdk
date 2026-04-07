import type { ClaudeCodeAgentOptions, AgentOptionsBase } from "./types";

export function getApprovalMode(
  options: Pick<AgentOptionsBase, "approvalMode">,
): AgentOptionsBase["approvalMode"] {
  return options.approvalMode ?? "auto";
}

export function isInteractiveApproval(
  options: Pick<AgentOptionsBase, "approvalMode">,
): boolean {
  return getApprovalMode(options) === "interactive";
}

export function shouldAutoApproveClaudeTools(
  options: ClaudeCodeAgentOptions,
): boolean {
  if (options.provider?.autoApproveTools !== undefined) {
    return options.provider.autoApproveTools;
  }

  return !isInteractiveApproval(options);
}
