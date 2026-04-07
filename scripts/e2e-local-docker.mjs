import fs from "node:fs";
import { Agent, Sandbox } from "../dist/index.js";

function loadDotEnv(filePath) {
  const values = {};
  const content = fs.readFileSync(filePath, "utf8");

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

  return values;
}

const rootEnv = loadDotEnv(new URL("../.env", import.meta.url));
const AUTH_PREP_COMMAND =
  "mkdir -p /root/.config /root/.codex /root/.claude /root/.config/opencode";

const COMMON_SANDBOX_OPTIONS = {
  workingDir: "/workspace",
  env: {
    HOME: "/root",
    XDG_CONFIG_HOME: "/root/.config",
    CODEX_HOME: "/root/.codex",
    ...(rootEnv.OPENAI_API_KEY
      ? { OPENAI_API_KEY: rootEnv.OPENAI_API_KEY }
      : {}),
    ...(rootEnv.ANTHROPIC_API_KEY
      ? { ANTHROPIC_API_KEY: rootEnv.ANTHROPIC_API_KEY }
      : {}),
  },
  provider: {
    image: "openagent-e2e",
  },
};

const BINARY_BY_PROVIDER = {
  codex: "codex",
  opencode: "opencode",
  "claude-code": "claude",
};

async function runProvider(provider) {
  const sandbox = new Sandbox("local-docker", {
    ...COMMON_SANDBOX_OPTIONS,
    tags: { scope: "e2e", provider, run: String(Date.now()) },
    ...(provider === "opencode"
      ? {
          provider: {
            ...COMMON_SANDBOX_OPTIONS.provider,
            publishedPorts: [4096],
          },
        }
      : {}),
  });

  try {
    console.log(`[${provider}] prep`);
    const prep = await sandbox.run(AUTH_PREP_COMMAND);
    console.log(`[${provider}] prep_exit=${prep.exitCode}`);
    const version = await sandbox.run(
      `${BINARY_BY_PROVIDER[provider]} --version`,
    );
    console.log(
      `[${provider}] version=${JSON.stringify(version.stdout.trim() || version.combinedOutput.trim())}`,
    );

    const agent = new Agent(provider, {
      sandbox,
      cwd: "/workspace",
      env: COMMON_SANDBOX_OPTIONS.env,
      ...(provider === "claude-code"
        ? {
            provider: {
              autoApproveTools: true,
            },
          }
        : {}),
    });

    console.log(`[${provider}] agent_run`);
    const result = await agent.run({
      input: "Reply with exactly hello in lowercase and nothing else.",
    });

    return {
      provider,
      prepExitCode: prep.exitCode,
      version: version.stdout.trim() || version.combinedOutput.trim(),
      sessionId: result.sessionId,
      text: result.text.trim(),
    };
  } finally {
    await sandbox.delete();
  }
}

const providers = ["codex", "opencode", "claude-code"];
const results = [];

for (const provider of providers) {
  try {
    results.push(await runProvider(provider));
  } catch (error) {
    results.push({
      provider,
      error:
        error instanceof Error ? error.stack || error.message : String(error),
    });
  }
}

console.log(JSON.stringify(results, null, 2));
