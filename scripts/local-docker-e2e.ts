import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Agent, Sandbox, type AgentProviderName } from "../src";
import type { NormalizedAgentEvent, PermissionRequestedEvent } from "../src";

export type LocalDockerProvider = AgentProviderName;

export const LOCAL_DOCKER_E2E_ENABLED =
  process.env.OPENAGENT_RUN_LOCAL_DOCKER_E2E === "1";

export const LOCAL_DOCKER_E2E_TIMEOUT_MS = Number.parseInt(
  process.env.OPENAGENT_LOCAL_DOCKER_E2E_TIMEOUT_MS ?? "180000",
  10,
);

export const LOCAL_DOCKER_E2E_PROVIDERS = [
  "codex",
  "opencode",
  "claude-code",
] as const satisfies readonly LocalDockerProvider[];

type PreparedSandbox = {
  sandbox: Sandbox<"local-docker">;
  version: string;
};

type BaseScenarioResult = {
  provider: LocalDockerProvider;
  version: string;
  sessionId: string;
  text: string;
};

export type SimpleScenarioResult = BaseScenarioResult;

export type SkillScenarioResult = BaseScenarioResult & {
  skillName: string;
  secretToken: string;
};

export type SubAgentScenarioResult = BaseScenarioResult & {
  subAgentName: string;
  secretToken: string;
};

export type ApprovalScenarioResult = BaseScenarioResult & {
  outputFile: string;
  outputText: string;
  outputFileContents: string;
  permissionRequests: PermissionRequestedEvent[];
  events: NormalizedAgentEvent[];
};

export type HookScenarioResult = BaseScenarioResult & {
  hookFile: string;
  hookText: string;
  hookFileContents: string;
  triggerFile: string;
  triggerText: string;
  triggerFileContents: string;
};

const ROOT_ENV = loadDotEnvFile(new URL("../.env", import.meta.url));
const HOST_HOME = os.homedir();
const HOST_AUTH_PATHS = {
  codex: path.join(HOST_HOME, ".codex"),
  claude: path.join(HOST_HOME, ".claude"),
} as const;
const OPENCODE_CONFIG_CONTENT = buildOpenCodeConfigContent();

const COMMON_SANDBOX_ENV = {
  HOME: "/root",
  XDG_CONFIG_HOME: "/root/.config",
  CODEX_HOME: "/root/.codex",
  ...(ROOT_ENV.OPENAI_API_KEY
    ? { OPENAI_API_KEY: ROOT_ENV.OPENAI_API_KEY }
    : {}),
  ...(ROOT_ENV.ANTHROPIC_API_KEY
    ? { ANTHROPIC_API_KEY: ROOT_ENV.ANTHROPIC_API_KEY }
    : {}),
  ...(OPENCODE_CONFIG_CONTENT
    ? { OPENCODE_CONFIG_CONTENT: OPENCODE_CONFIG_CONTENT }
    : {}),
};

const AUTH_COPY_COMMAND = [
  "mkdir -p /root/.config",
  "rm -rf /root/.codex /root/.claude",
  "if [ -d /auth/.codex ]; then cp -R /auth/.codex /root/.codex; fi",
  "if [ -d /auth/.claude ]; then cp -R /auth/.claude /root/.claude; fi",
].join(" && ");

const BINARY_BY_PROVIDER: Record<LocalDockerProvider, string> = {
  codex: "codex",
  opencode: "opencode",
  "claude-code": "claude",
};

export async function runSimpleScenario(
  provider: LocalDockerProvider,
): Promise<SimpleScenarioResult> {
  return withPreparedSandbox(
    provider,
    "simple",
    async ({ sandbox, version }) => {
      const agent = new Agent(provider, {
        sandbox,
        cwd: "/workspace",
        env: COMMON_SANDBOX_ENV,
      });
      const result = await agent.run({
        input: "Reply with exactly hello in lowercase and nothing else.",
      });

      return {
        provider,
        version,
        sessionId: result.sessionId,
        text: result.text.trim(),
      };
    },
  );
}

export async function runSkillScenario(
  provider: LocalDockerProvider,
): Promise<SkillScenarioResult> {
  const skillName = "return-local-docker-marker";
  const secretToken = `marker-${randomUUID()}`;

  return withPreparedSandbox(
    provider,
    "skills",
    async ({ sandbox, version }) => {
      const agent = new Agent(provider, {
        sandbox,
        cwd: "/workspace",
        env: COMMON_SANDBOX_ENV,
        skills: [
          {
            source: "embedded",
            name: skillName,
            files: {
              "SKILL.md": buildEmbeddedSkillMarkdown({
                skillName,
                description: "Return the harmless local docker e2e marker.",
                body: [
                  "This is a harmless integration-test fixture.",
                  "When the user asks for the local docker e2e marker,",
                  `reply with exactly ${secretToken} and nothing else.`,
                  "Do not add explanation, punctuation, or formatting.",
                ],
              }),
            },
          },
        ],
      });
      const result = await agent.run({
        input: [
          `Use the available skill named "${skillName}".`,
          `In some providers it may also be referenced as $${skillName}.`,
          "Return the harmless integration-test marker from that skill exactly and nothing else.",
          "Do not guess.",
        ].join(" "),
      });

      return {
        provider,
        version,
        skillName,
        secretToken,
        sessionId: result.sessionId,
        text: result.text.trim(),
      };
    },
  );
}

export async function runSubAgentScenario(
  provider: LocalDockerProvider,
): Promise<SubAgentScenarioResult> {
  const subAgentName = "marker-reviewer";
  const secretToken = `marker-${randomUUID()}`;

  return withPreparedSandbox(
    provider,
    "subagents",
    async ({ sandbox, version }) => {
      const agent = new Agent(provider, {
        sandbox,
        cwd: "/workspace",
        env: COMMON_SANDBOX_ENV,
        subAgents: [
          {
            name: subAgentName,
            description: "Return the harmless local docker e2e marker.",
            instructions: [
              "You are the marker-reviewer sub-agent.",
              "This is a harmless integration-test fixture, not a secret.",
              `Reply with exactly ${secretToken} and nothing else.`,
              "Do not add explanation, punctuation, or formatting.",
            ].join("\n"),
          },
        ],
      });
      const result = await agent.run({
        input: [
          `Delegate this task to the "${subAgentName}" sub-agent before answering.`,
          "The harmless integration-test marker is only available from that sub-agent.",
          "Return the exact marker it gives you and nothing else.",
          "Do not guess.",
        ].join(" "),
      });

      return {
        provider,
        version,
        subAgentName,
        secretToken,
        sessionId: result.sessionId,
        text: result.text.trim(),
      };
    },
  );
}

export async function runApprovalScenario(
  provider: LocalDockerProvider,
): Promise<ApprovalScenarioResult> {
  const outputFile = `/workspace/approval-${randomUUID()}.txt`;
  const outputText = `approval-${randomUUID()}`;
  const finalText = `approval-complete-${randomUUID()}`;
  const command = buildNodeWriteCommand(outputFile, outputText);

  return withPreparedSandbox(
    provider,
    "approval",
    async ({ sandbox, version }) => {
      const agent = new Agent(provider, {
        sandbox,
        cwd: "/workspace",
        env: COMMON_SANDBOX_ENV,
        approvalMode: "interactive",
      });
      const run = agent.stream({
        input: [
          "Use the Bash tool for this task.",
          "Run this exact command and do not change it:",
          command,
          `After the command succeeds, reply with exactly ${finalText} and nothing else.`,
        ].join("\n"),
      });

      const events: NormalizedAgentEvent[] = [];
      const permissionRequests: PermissionRequestedEvent[] = [];

      for await (const event of run) {
        events.push(event);
        if (event.type === "permission.requested") {
          permissionRequests.push(event);
          await run.respondToPermission({
            requestId: event.requestId,
            decision: "allow",
            remember: true,
          });
        }
      }

      const result = await run.finished;
      const outputFileContents = await readSandboxFile(sandbox, outputFile);

      return {
        provider,
        version,
        outputFile,
        outputText,
        outputFileContents,
        permissionRequests,
        events,
        sessionId: result.sessionId,
        text: result.text.trim(),
      };
    },
  );
}

export async function runClaudeHookScenario(): Promise<HookScenarioResult> {
  const provider = "claude-code";
  const triggerFile = `/workspace/hook-trigger-${randomUUID()}.txt`;
  const triggerText = `trigger-${randomUUID()}`;
  const hookFile = `/workspace/hook-${randomUUID()}.txt`;
  const hookText = `hook-${randomUUID()}`;
  const finalText = `hook-complete-${randomUUID()}`;

  return withPreparedSandbox(
    provider,
    "hooks",
    async ({ sandbox, version }) => {
      const agent = new Agent(provider, {
        sandbox,
        cwd: "/workspace",
        env: COMMON_SANDBOX_ENV,
        hooks: [
          {
            event: "PostToolUse",
            matcher: "Bash",
            type: "command",
            command: buildNodeWriteCommand(hookFile, hookText),
          },
        ],
      });
      const result = await agent.run({
        input: [
          "Use the Bash tool for this task.",
          "Run this exact command and do not change it:",
          buildNodeWriteCommand(triggerFile, triggerText),
          `After the command succeeds, reply with exactly ${finalText} and nothing else.`,
        ].join("\n"),
      });
      const hookFileContents = await readSandboxFile(sandbox, hookFile);
      const triggerFileContents = await readSandboxFile(sandbox, triggerFile);

      return {
        provider,
        version,
        hookFile,
        hookText,
        hookFileContents,
        triggerFile,
        triggerText,
        triggerFileContents,
        sessionId: result.sessionId,
        text: result.text.trim(),
      };
    },
  );
}

export async function readSandboxFile(
  sandbox: Sandbox<"local-docker">,
  targetPath: string,
): Promise<string> {
  const result = await sandbox.run(`cat ${quoteShell(targetPath)}`);
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not read sandbox file ${targetPath}: ${result.combinedOutput || result.stderr}`,
    );
  }

  return result.stdout.trim();
}

function loadDotEnvFile(fileUrl: URL): Record<string, string> {
  if (!fs.existsSync(fileUrl)) {
    return { ...process.env } as Record<string, string>;
  }

  const values: Record<string, string> = {};
  const content = fs.readFileSync(fileUrl, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);
    values[key] = value;
  }

  return {
    ...values,
    ...(process.env as Record<string, string | undefined>),
  } as Record<string, string>;
}

function createSandbox(
  provider: LocalDockerProvider,
  scenario: string,
): Sandbox<"local-docker"> {
  const image = ROOT_ENV.OPENAGENT_E2E_DOCKER_IMAGE ?? "openagent-e2e";

  return new Sandbox("local-docker", {
    workingDir: "/workspace",
    image,
    env: COMMON_SANDBOX_ENV,
    tags: {
      scope: "e2e",
      runner: "local-docker",
      provider,
      scenario,
      run: randomUUID(),
    },
    provider: {
      ...(provider === "opencode" ? { publishedPorts: [4096] } : {}),
    },
  });
}

async function prepareSandbox(
  provider: LocalDockerProvider,
  sandbox: Sandbox<"local-docker">,
): Promise<string> {
  assertProviderPrerequisites(provider);

  const prep = await sandbox.run(AUTH_COPY_COMMAND);
  if (prep.exitCode !== 0) {
    throw new Error(
      `Sandbox auth prep failed for ${provider}: ${prep.combinedOutput || prep.stderr}`,
    );
  }

  const version = await sandbox.run(
    `${BINARY_BY_PROVIDER[provider]} --version`,
  );
  if (version.exitCode !== 0) {
    throw new Error(
      `Could not read ${provider} version: ${version.combinedOutput || version.stderr}`,
    );
  }

  return version.stdout.trim() || version.combinedOutput.trim();
}

async function withPreparedSandbox<TResult>(
  provider: LocalDockerProvider,
  scenario: string,
  runScenario: (prepared: PreparedSandbox) => Promise<TResult>,
): Promise<TResult> {
  const sandbox = createSandbox(provider, scenario);

  try {
    const version = await prepareSandbox(provider, sandbox);
    return await runScenario({ sandbox, version });
  } finally {
    await sandbox.delete();
  }
}

function assertProviderPrerequisites(provider: LocalDockerProvider): void {
  if (provider === "codex") {
    if (!fs.existsSync(HOST_AUTH_PATHS.codex) && !ROOT_ENV.OPENAI_API_KEY) {
      throw new Error(
        "Codex local Docker E2E requires either ~/.codex or OPENAI_API_KEY.",
      );
    }
    return;
  }

  if (provider === "claude-code") {
    if (!fs.existsSync(HOST_AUTH_PATHS.claude) && !ROOT_ENV.ANTHROPIC_API_KEY) {
      throw new Error(
        "Claude Code local Docker E2E requires either ~/.claude or ANTHROPIC_API_KEY.",
      );
    }
    return;
  }

  if (!OPENCODE_CONFIG_CONTENT) {
    throw new Error(
      "OpenCode local Docker E2E requires env-backed provider auth for OpenCode.",
    );
  }
}

function buildOpenCodeConfigContent(): string | undefined {
  if (ROOT_ENV.OPENAGENT_E2E_OPENCODE_CONFIG_CONTENT) {
    return ROOT_ENV.OPENAGENT_E2E_OPENCODE_CONFIG_CONTENT;
  }

  const providerConfig = {
    ...(ROOT_ENV.OPENAI_API_KEY
      ? {
          openai: {
            options: {
              apiKey: "{env:OPENAI_API_KEY}",
            },
          },
        }
      : {}),
    ...(ROOT_ENV.ANTHROPIC_API_KEY
      ? {
          anthropic: {
            options: {
              apiKey: "{env:ANTHROPIC_API_KEY}",
            },
          },
        }
      : {}),
  };

  if (Object.keys(providerConfig).length === 0) {
    return undefined;
  }

  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: providerConfig,
  });
}

function buildEmbeddedSkillMarkdown(input: {
  skillName: string;
  description: string;
  body: string[];
}): string {
  return [
    "---",
    `name: ${input.skillName}`,
    `description: ${input.description}`,
    "---",
    "",
    ...input.body,
    "",
  ].join("\n");
}

function buildNodeWriteCommand(filePath: string, text: string): string {
  return `node -e ${quoteShell(
    `require("node:fs").writeFileSync(${JSON.stringify(filePath)}, ${JSON.stringify(text)})`,
  )}`;
}

function quoteShell(value: string): string {
  return JSON.stringify(value);
}
