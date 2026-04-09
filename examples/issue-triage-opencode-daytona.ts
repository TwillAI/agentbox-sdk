import { Agent, Sandbox } from "openagent";

import { issueTriageFiles } from "./fixtures/issue-triage";
import {
  WORKSPACE_DIR,
  daytonaOptions,
  openCodeEnv,
  pickOpenCodeModel,
} from "./options";
import { cleanupSandbox, runExample, streamRun, writeFiles } from "./runtime";

const PROJECT_DIR = `${WORKSPACE_DIR}/notifications-dashboard`;

async function main() {
  const sandbox = new Sandbox(
    "daytona",
    daytonaOptions("issue-triage-opencode-daytona"),
  );

  await runExample("Issue Triage: OpenCode + Daytona", async () => {
    try {
      await writeFiles(sandbox, PROJECT_DIR, issueTriageFiles);

      const agent = new Agent("opencode", {
        sandbox,
        cwd: PROJECT_DIR,
        approvalMode: "auto",
        env: openCodeEnv(),
        commands: [
          {
            name: "triage",
            description:
              "Turn a bug report into a root-cause analysis and plan",
            template:
              "Triage the current issue report. Return: probable root cause, files to touch, implementation plan, and tests to add.",
          },
        ],
      });

      const run = agent.stream({
        model: pickOpenCodeModel(),
        systemPrompt:
          "Be decisive. Favor likely root cause analysis and an actionable next step.",
        input: [
          "Use the /triage command for the bug report in issue-report.md.",
          "Focus on why the loading state never clears after a 401 from /api/inbox.",
          "Write the triage output to triage.md before you answer.",
        ].join(" "),
      });

      await streamRun("Triage summary", run);
      console.log(`\nSaved triage notes to ${PROJECT_DIR}/triage.md`);
    } finally {
      await cleanupSandbox(sandbox);
    }
  });
}

void main();
