import { Agent, Sandbox } from "openagent";

import {
  prReviewBaselineFiles,
  prReviewModifiedFiles,
} from "./fixtures/pr-review";
import { WORKSPACE_DIR, claudeEnv, modalOptions } from "./options";
import {
  cleanupSandbox,
  runExample,
  stageGitBaseline,
  streamRun,
  writeFiles,
} from "./runtime";

const PROJECT_DIR = `${WORKSPACE_DIR}/checkout-service`;

async function main() {
  const sandbox = new Sandbox(
    "modal",
    modalOptions("pr-review-claude-code-modal"),
  );

  await runExample("PR Review: Claude Code + Modal", async () => {
    try {
      await writeFiles(sandbox, PROJECT_DIR, prReviewBaselineFiles);
      await stageGitBaseline(sandbox, PROJECT_DIR);
      await writeFiles(sandbox, PROJECT_DIR, prReviewModifiedFiles);

      const agent = new Agent("claude-code", {
        sandbox,
        cwd: PROJECT_DIR,
        approvalMode: "auto",
        env: claudeEnv(),
        subAgents: [
          {
            name: "reviewer",
            description: "Review diffs for correctness and regression risk",
            instructions:
              "Review the current changes for bugs, pricing regressions, and missing tests.",
            tools: ["bash"],
          },
        ],
        provider: {
          autoApproveTools: true,
          verbose: true,
        },
      });

      const run = agent.stream({
        model: "claude-sonnet-4-6",
        systemPrompt:
          "Review like a strong code reviewer. Prioritize correctness and billing risk over style.",
        input: [
          "Review the current uncommitted changes like a PR reviewer.",
          "Flag likely bugs, regressions, and missing tests.",
          "Reference file paths when you cite issues.",
          "Keep the final recommendation concise.",
        ].join(" "),
      });

      await streamRun("Review findings", run);
      console.log(`\nWorking tree lives in ${PROJECT_DIR}`);
    } finally {
      await cleanupSandbox(sandbox);
    }
  });
}

void main();
