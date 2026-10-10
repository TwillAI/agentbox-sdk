import { describe, it } from "vitest";
import { verifySmolOpenCodePrompt } from "./helpers/smol-open-code-prompt";

const live = process.env.AGENTBOX_RUN_SMOL_LOCAL_PROMPT_E2E === "1" ? describe : describe.skip;

live("OpenCode prompt inside a local Smol VM", () => {
  it("returns an answer from a guest-local test model through AgentBox", async () => {
    await verifySmolOpenCodePrompt();
  }, 180_000);
});
