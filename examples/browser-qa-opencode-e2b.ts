import { Agent, Sandbox } from "openagent";

import { browserQaFiles } from "./fixtures/browser-qa";
import {
  WORKSPACE_DIR,
  e2bOptions,
  openCodeEnv,
  pickOpenCodeModel,
} from "./options";
import {
  cleanupSandbox,
  runExample,
  startHttpServer,
  streamRun,
  writeFiles,
} from "./runtime";

const PROJECT_DIR = `${WORKSPACE_DIR}/launch-site`;
const PORT = 3000;

async function main() {
  const sandbox = new Sandbox("e2b", e2bOptions("browser-qa-opencode-e2b"));

  await runExample("Browser QA: OpenCode + E2B", async () => {
    try {
      await writeFiles(sandbox, PROJECT_DIR, browserQaFiles);
      const server = await startHttpServer(sandbox, PROJECT_DIR, PORT);

      try {
        const previewUrl = await sandbox.getPreviewLink(PORT);
        console.log(`Preview URL: ${previewUrl}`);

        const agent = new Agent("opencode", {
          sandbox,
          cwd: PROJECT_DIR,
          approvalMode: "auto",
          env: openCodeEnv(),
          skills: [
            {
              name: "agent-browser",
              repo: "https://github.com/vercel-labs/agent-browser",
            },
          ],
        });

        const run = agent.stream({
          model: pickOpenCodeModel(),
          input: [
            `Browse ${previewUrl}.`,
            "Confirm the hero headline and the Team pricing card copy.",
            "Take a screenshot and save it to /workspace/launch-site/qa-home.png.",
            "Tell me if anything is visually broken or misleading.",
          ].join(" "),
        });

        await streamRun("QA notes", run);
        console.log(`\nSaved screenshot to ${PROJECT_DIR}/qa-home.png`);
      } finally {
        await server.kill().catch(() => undefined);
      }
    } finally {
      await cleanupSandbox(sandbox);
    }
  });
}

void main();
