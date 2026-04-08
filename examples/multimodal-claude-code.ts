import { pathToFileURL } from "node:url";

import { Agent, Sandbox } from "../src";

async function main() {
  const sandbox = new Sandbox("local-docker", {
    workingDir: "/workspace",
    tags: { example: "multimodal-claude-code" },
    image: "node:20-bookworm",
  });

  const agent = new Agent("claude-code", {
    sandbox,
    cwd: "/workspace",
    provider: {
      autoApproveTools: true,
    },
  });

  const run = agent.stream({
    input: [
      {
        type: "text",
        text: [
          "Summarize the design reference and the attached product brief.",
          "Call out any obvious inconsistencies between them.",
        ].join(" "),
      },
      {
        type: "image",
        image: pathToFileURL("/workspace/reference/mockup.png"),
      },
      {
        type: "file",
        data: pathToFileURL("/workspace/reference/brief.pdf"),
        mediaType: "application/pdf",
        filename: "brief.pdf",
      },
    ],
    model: "claude-sonnet-4-6",
    systemPrompt: "Be concise and focus on the highest-signal observations.",
  });

  console.log("Session:", await run.sessionIdReady);

  for await (const event of run) {
    if (event.type === "text.delta") {
      process.stdout.write(event.delta);
    }
  }

  const result = await run.finished;
  console.log("\nDone:", result.text);
}

void main();
