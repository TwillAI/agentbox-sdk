import fs from "node:fs";
import { ModalClient } from "modal";

import { Agent, Sandbox, type AgentRun, type RawAgentEvent } from "../src";
import { buildSandboxImage } from "../src/sandbox-images/build";

type CliOptions = {
  image?: string;
  appName?: string;
  keepAlive: boolean;
};

const DOT_ENV_FILE_URL = new URL("../.env", import.meta.url);
const ROOT_ENV = loadDotEnvFile(DOT_ENV_FILE_URL);
const MODAL_IMAGE_ENV_KEY = "OPENAGENT_MODAL_IMAGE";
const MODAL_BROWSER_AGENT_PRESET = "browser-agent";
const DEFAULT_MODAL_BROWSER_AGENT_IMAGE = "im-n7BJWt8uQVY94AlC6wi0Ia";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  syncProcessEnv(ROOT_ENV);

  const modalTokenId = ROOT_ENV.MODAL_TOKEN_ID;
  const modalTokenSecret = ROOT_ENV.MODAL_TOKEN_SECRET;
  if (!modalTokenId || !modalTokenSecret) {
    throw new Error(
      "Missing Modal credentials. Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET.",
    );
  }

  const modalAppName =
    options.appName ??
    ROOT_ENV.MODAL_APP_NAME ??
    ROOT_ENV.OPENAGENT_MODAL_APP_NAME ??
    "openagent";
  const image = await ensureModalBrowserAgentImage({
    requestedImage:
      options.image ??
      ROOT_ENV[MODAL_IMAGE_ENV_KEY] ??
      ROOT_ENV.IMAGE_ID ??
      DEFAULT_MODAL_BROWSER_AGENT_IMAGE,
    appName: modalAppName,
    tokenId: modalTokenId,
    tokenSecret: modalTokenSecret,
    environment: ROOT_ENV.MODAL_ENVIRONMENT,
    endpoint: ROOT_ENV.MODAL_ENDPOINT,
  });
  const model = pickModel(ROOT_ENV);
  const sandboxEnv = buildSandboxEnv(ROOT_ENV);
  const sandbox = new Sandbox("modal", {
    workingDir: "/workspace",
    image,
    idleTimeoutMs: 15 * 60_000,
    autoStopMs: 60 * 60_000,
    resources: {
      cpu: 2,
      memoryMiB: 4096,
    },
    env: sandboxEnv,
    tags: {
      example: "opencode-modal-hello-world",
    },
    provider: {
      tokenId: modalTokenId,
      tokenSecret: modalTokenSecret,
      appName: modalAppName,
      environment: ROOT_ENV.MODAL_ENVIRONMENT,
      endpoint: ROOT_ENV.MODAL_ENDPOINT,
    },
  });

  try {
    const agent = new Agent("opencode", {
      sandbox,
      cwd: "/workspace",
      env: sandboxEnv,
      approvalMode: "auto",
    });

    const run = agent.stream({
      input: "Reply with exactly hello world in lowercase and nothing else.",
      model,
    });
    const rawEventsTask = logRawEvents(run.rawEvents());
    const textTask = logStreamText(run);

    console.error(`Modal image: ${image}`);
    console.error(`Model: ${model}`);
    console.error(`Session: ${await run.sessionIdReady}`);

    const result = await run.finished;
    await Promise.all([rawEventsTask, textTask]);
    process.stdout.write("\n");

    console.log(
      JSON.stringify(
        {
          provider: "opencode",
          sandboxProvider: "modal",
          sandboxId: sandbox.id,
          sessionId: result.sessionId,
          model,
          text: result.text.trim(),
        },
        null,
        2,
      ),
    );
  } finally {
    if (!options.keepAlive) {
      await sandbox.delete().catch(() => undefined);
    }
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    keepAlive: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    const next = args[index + 1];

    if (current === "--image") {
      if (!next) {
        throw new Error("Expected a value after --image.");
      }
      options.image = next;
      index += 1;
      continue;
    }

    if (current === "--app-name") {
      if (!next) {
        throw new Error("Expected a value after --app-name.");
      }
      options.appName = next;
      index += 1;
      continue;
    }

    if (current === "--keep-alive") {
      options.keepAlive = true;
      continue;
    }

    throw new Error(`Unknown argument: ${current}`);
  }

  return options;
}

function buildSandboxEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const sandboxEnv: Record<string, string> = {};

  if (env.OPENAI_API_KEY) {
    sandboxEnv.OPENAI_API_KEY = env.OPENAI_API_KEY;
  }

  if (env.ANTHROPIC_API_KEY) {
    sandboxEnv.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  }

  const inlineConfig = buildOpenCodeConfigContent(env);
  if (inlineConfig) {
    sandboxEnv.OPENCODE_CONFIG_CONTENT = inlineConfig;
  }

  return sandboxEnv;
}

function pickModel(env: Record<string, string | undefined>): string {
  if (env.ANTHROPIC_API_KEY) {
    return "anthropic/claude-sonnet-4-6";
  }

  if (env.OPENAI_API_KEY) {
    return "openai/gpt-4.1";
  }

  throw new Error(
    "Missing LLM credentials. Set ANTHROPIC_API_KEY or OPENAI_API_KEY for OpenCode.",
  );
}

function buildOpenCodeConfigContent(
  env: Record<string, string | undefined>,
): string | undefined {
  const providerConfig = {
    ...(env.OPENAI_API_KEY
      ? {
          openai: {
            options: {
              apiKey: "{env:OPENAI_API_KEY}",
            },
          },
        }
      : {}),
    ...(env.ANTHROPIC_API_KEY
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

function loadDotEnvFile(fileUrl: URL): Record<string, string | undefined> {
  if (!fs.existsSync(fileUrl)) {
    return { ...(process.env as Record<string, string | undefined>) };
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
  };
}

await main();

async function logRawEvents(events: AsyncIterable<RawAgentEvent>) {
  for await (const event of events) {
    console.error(`[opencode raw] ${JSON.stringify(event)}`);
  }
}

async function logStreamText(agentRun: AgentRun) {
  for await (const event of agentRun.toAISDKEvents()) {
    if (event.type === "text-delta") {
      process.stdout.write(event.textDelta);
      continue;
    }

    console.error(`[opencode stream] ${JSON.stringify(event)}`);
  }
}

async function ensureModalBrowserAgentImage(input: {
  requestedImage?: string;
  appName: string;
  tokenId: string;
  tokenSecret: string;
  environment?: string;
  endpoint?: string;
}): Promise<string> {
  const candidate = input.requestedImage?.trim();
  if (candidate) {
    const exists = await modalImageExists(candidate, input);
    if (exists) {
      return candidate;
    }

    console.error(
      `Modal image ${candidate} is missing or invalid; building ${MODAL_BROWSER_AGENT_PRESET} instead.`,
    );
  } else {
    console.error(
      `No Modal image configured; building ${MODAL_BROWSER_AGENT_PRESET}.`,
    );
  }

  const builtImage = await buildSandboxImage({
    provider: "modal",
    preset: MODAL_BROWSER_AGENT_PRESET,
    modalAppName: input.appName,
    log: (chunk) => {
      process.stderr.write(chunk.endsWith("\n") ? chunk : `${chunk}\n`);
    },
  });

  upsertEnvValue(DOT_ENV_FILE_URL, MODAL_IMAGE_ENV_KEY, builtImage);
  ROOT_ENV[MODAL_IMAGE_ENV_KEY] = builtImage;
  process.env[MODAL_IMAGE_ENV_KEY] = builtImage;
  console.error(
    `Saved ${MODAL_IMAGE_ENV_KEY}=${builtImage} to ${DOT_ENV_FILE_URL.pathname}.`,
  );

  return builtImage;
}

async function modalImageExists(
  image: string,
  input: {
    tokenId: string;
    tokenSecret: string;
    environment?: string;
    endpoint?: string;
  },
): Promise<boolean> {
  const client = new ModalClient({
    tokenId: input.tokenId,
    tokenSecret: input.tokenSecret,
    environment: input.environment,
    endpoint: input.endpoint,
  });

  try {
    await client.images.fromId(image);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingModalImageError(message)) {
      return false;
    }
    throw error;
  }
}

function isMissingModalImageError(message: string): boolean {
  return (
    message.includes("/modal.client.ModalClient/ImageFromId") ||
    message.includes("Image ID") ||
    message.includes("image id") ||
    message.includes("not found")
  );
}

function upsertEnvValue(fileUrl: URL, key: string, value: string): void {
  const existing = fs.existsSync(fileUrl)
    ? fs.readFileSync(fileUrl, "utf8")
    : "";
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!replaced) {
    while (nextLines.length > 0 && nextLines[nextLines.length - 1] === "") {
      nextLines.pop();
    }
    if (nextLines.length > 0) {
      nextLines.push("");
    }
    nextLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(fileUrl, `${nextLines.join("\n")}\n`);
}

function syncProcessEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
