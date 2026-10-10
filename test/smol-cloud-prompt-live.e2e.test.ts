import { describe, it } from "vitest";
import { verifySmolOpenCodePrompt } from "./helpers/smol-open-code-prompt";

const live = process.env.AGENTBOX_RUN_SMOL_CLOUD_PROMPT_E2E === "1" ? describe : describe.skip;

live("OpenCode prompt inside Smol Cloud", () => {
  it("returns an answer from a guest-local test model through AgentBox", async () => {
    await verifySmolOpenCodePrompt("cloud");
  }, 180_000);
});
