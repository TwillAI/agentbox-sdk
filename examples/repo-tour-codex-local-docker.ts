import { Agent, Sandbox } from "openagent";

import { repoTourFiles } from "./fixtures/repo-tour";
import { WORKSPACE_DIR, codexEnv, localDockerOptions } from "./options";
import { cleanupSandbox, runExample, streamRun, writeFiles } from "./runtime";

const PROJECT_DIR = `${WORKSPACE_DIR}/customer-portal`;

async function main() {
  const sandbox = new Sandbox(
    "local-docker",
    localDockerOptions("repo-tour-codex-local-docker"),
  );

  await runExample("Repo Tour: Codex + local-docker", async () => {
    try {
      await writeFiles(sandbox, PROJECT_DIR, repoTourFiles);

      const agent = new Agent("codex", {
        sandbox,
        cwd: PROJECT_DIR,
        approvalMode: "auto",
        env: codexEnv(),
      });
      const run = agent.stream({
        model: "gpt-5-codex",
        input: [
          "You just joined this team.",
          "Map the repository for a new engineer.",
          "Focus on package boundaries, the billing data flow, and the first commands to run locally.",
          "Write onboarding notes to ONBOARDING.md in the current directory.",
          "Then give me a concise summary in bullets.",
        ].join(" "),
      });

      await streamRun("Generated onboarding notes", run);
      console.log(`\nSaved notes to ${PROJECT_DIR}/ONBOARDING.md`);
    } finally {
      await cleanupSandbox(sandbox);
    }
  });
}

void main();
