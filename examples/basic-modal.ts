import { Sandbox } from "../src";

async function main() {
  const sandbox = new Sandbox("modal", {
    workingDir: "/workspace",
    tags: { example: "modal" },
    idleTimeoutMs: 15 * 60_000,
    autoStopMs: 60 * 60_000,
    image: "im-your-modal-image-id",
    resources: {
      cpu: 1,
      memoryMiB: 2048,
    },
    provider: {
      appName: "openagent-example",
    },
  });

  await sandbox.gitClone({
    repoUrl: "https://github.com/octocat/Hello-World.git",
    targetDir: "/workspace/hello-world",
  });

  const result = await sandbox.run("ls -la /workspace/hello-world");
  console.log(result.stdout);
}

void main();
