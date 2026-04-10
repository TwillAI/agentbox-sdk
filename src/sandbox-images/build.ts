import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Daytona, Image as DaytonaImage } from "@daytonaio/sdk";
import Docker from "dockerode";
import { ModalClient } from "modal";
import tar from "tar-stream";

import type { SandboxProviderName } from "../sandboxes/types";
import { toShellCommand } from "../shared/shell";
import type { BuiltInSandboxImageName, SandboxImageDefinition } from "./types";
import {
  buildDaytonaSnapshotName,
  buildE2bTemplateReference,
  buildSandboxImageReference,
  sandboxImageDefinitionToDockerfile,
  sandboxImageDefinitionToDockerfileCommands,
} from "./utils";

export interface BuildSandboxImageOptions {
  provider: SandboxProviderName;
  preset?: BuiltInSandboxImageName;
  file?: string;
  cwd?: string;
  modalAppName?: string;
  imageName?: string;
  env?: Record<string, string>;
  log?: (chunk: string) => void;
}

let e2bModulePromise: Promise<typeof import("e2b")> | undefined;

async function loadE2bModule(): Promise<typeof import("e2b")> {
  if (!e2bModulePromise) {
    e2bModulePromise = import("e2b");
  }

  return e2bModulePromise;
}

function getBuildEnv(
  options: BuildSandboxImageOptions,
  key: string,
): string | undefined {
  return options.env?.[key] ?? process.env[key];
}

export async function buildSandboxImage(
  options: BuildSandboxImageOptions,
): Promise<string> {
  const definition = await loadSandboxImageDefinition(
    options.preset,
    options.file,
    options.cwd,
  );

  switch (options.provider) {
    case "local-docker":
      return buildLocalDockerImage(definition, options);
    case "modal":
      return buildModalImage(definition, options);
    case "daytona":
      return buildDaytonaSnapshot(definition, options);
    case "e2b":
      return buildE2bTemplate(definition, options);
  }
}

export async function loadSandboxImageDefinition(
  preset?: BuiltInSandboxImageName,
  file?: string,
  cwd = process.cwd(),
): Promise<SandboxImageDefinition> {
  if (!preset && !file) {
    throw new Error("Provide either --preset or --file.");
  }
  if (preset && file) {
    throw new Error("Use either --preset or --file, not both.");
  }

  const target = preset
    ? resolveBuiltInImageUrl(preset)
    : pathToFileURL(path.resolve(cwd, file!));

  const module = await import(target.href);
  const definition = module.default as SandboxImageDefinition | undefined;
  if (!definition?.base) {
    throw new Error(
      "Sandbox image definitions must export a default object with a base image.",
    );
  }

  return definition;
}

function resolveBuiltInImageUrl(preset: BuiltInSandboxImageName): URL {
  const candidates = [
    new URL(`../../images/${preset}.mjs`, import.meta.url),
    new URL(`../images/${preset}.mjs`, import.meta.url),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return new URL(`../../images/${preset}.mjs`, import.meta.url);
}

async function buildLocalDockerImage(
  definition: SandboxImageDefinition,
  options: BuildSandboxImageOptions,
): Promise<string> {
  const client = new Docker();
  const tag =
    options.imageName ?? buildSandboxImageReference(definition, "agentbox");
  const pack = tar.pack();
  pack.entry(
    { name: "Dockerfile" },
    sandboxImageDefinitionToDockerfile(definition),
  );
  pack.finalize();

  const stream = await client.buildImage(pack, {
    t: tag,
    dockerfile: "Dockerfile",
    pull: true,
  });

  await new Promise<void>((resolve, reject) => {
    client.modem.followProgress(
      stream,
      (error: Error | null, output: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        const messages = Array.isArray(output)
          ? (output as Array<Record<string, unknown>>)
          : [];
        for (const message of messages) {
          if (typeof message.stream === "string") {
            options.log?.(message.stream.trimEnd());
          }
          if (typeof message.error === "string") {
            reject(new Error(message.error));
            return;
          }
        }
        resolve();
      },
      (event: Record<string, unknown>) => {
        if (typeof event.stream === "string") {
          options.log?.(event.stream.trimEnd());
        }
      },
    );
  });

  options.log?.(`Built local-docker image ${tag}`);
  return tag;
}

async function buildModalImage(
  definition: SandboxImageDefinition,
  options: BuildSandboxImageOptions,
): Promise<string> {
  const tokenId = getBuildEnv(options, "MODAL_TOKEN_ID");
  const tokenSecret = getBuildEnv(options, "MODAL_TOKEN_SECRET");
  if (!tokenId || !tokenSecret) {
    throw new Error("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required.");
  }

  const client = new ModalClient({
    tokenId,
    tokenSecret,
    environment: getBuildEnv(options, "MODAL_ENVIRONMENT"),
    endpoint: getBuildEnv(options, "MODAL_ENDPOINT"),
  });
  try {
    const appName =
      options.modalAppName ??
      getBuildEnv(options, "AGENTBOX_MODAL_APP_NAME") ??
      "agentbox-images";
    const app = await client.apps.fromName(appName, {
      createIfMissing: true,
      environment: getBuildEnv(options, "MODAL_ENVIRONMENT"),
    });

    let image = client.images.fromRegistry(definition.base);
    const commands = sandboxImageDefinitionToDockerfileCommands(definition);
    if (commands.length > 0) {
      image = image.dockerfileCommands(commands);
    }

    const builtImage = await image.build(app);
    options.log?.(`Built Modal image ${builtImage.imageId}`);
    return builtImage.imageId;
  } finally {
    try {
      client.close();
    } catch {
      // Ignore client shutdown errors during cleanup.
    }
  }
}

async function buildDaytonaSnapshot(
  definition: SandboxImageDefinition,
  options: BuildSandboxImageOptions,
): Promise<string> {
  if (!definition.resources?.cpu || !definition.resources?.memoryMiB) {
    throw new Error(
      "Daytona image definitions must include resources.cpu and resources.memoryMiB.",
    );
  }
  if (
    !getBuildEnv(options, "DAYTONA_API_KEY") &&
    !getBuildEnv(options, "DAYTONA_JWT_TOKEN")
  ) {
    throw new Error("DAYTONA_API_KEY or DAYTONA_JWT_TOKEN is required.");
  }

  const client = new Daytona({
    apiKey: getBuildEnv(options, "DAYTONA_API_KEY"),
    jwtToken: getBuildEnv(options, "DAYTONA_JWT_TOKEN"),
    organizationId: getBuildEnv(options, "DAYTONA_ORGANIZATION_ID"),
    apiUrl: getBuildEnv(options, "DAYTONA_API_URL"),
    target: getBuildEnv(options, "DAYTONA_TARGET"),
  });

  let image = DaytonaImage.base(definition.base);
  if (definition.env) {
    image = image.env(definition.env);
  }
  for (const command of definition.run ?? []) {
    image = image.runCommands(command);
  }
  if (definition.workdir) {
    image = image.workdir(definition.workdir);
  }
  if (definition.cmd) {
    image = image.cmd(definition.cmd);
  }

  const snapshotName =
    options.imageName ?? buildDaytonaSnapshotName(definition);

  try {
    const existing = await client.snapshot.get(snapshotName);
    if (existing.state === "active") {
      options.log?.(`Reusing existing Daytona snapshot ${existing.name}`);
      return existing.name;
    }
  } catch {
    // Snapshot does not exist yet — fall through to create.
  }

  const snapshot = await client.snapshot.create(
    {
      name: snapshotName,
      image,
      resources: {
        cpu: definition.resources.cpu,
        memory: definition.resources.memoryMiB / 1024,
      },
    },
    {
      onLogs: (chunk) => options.log?.(chunk),
      timeout: 0,
    },
  );

  try {
    const activated = await client.snapshot.activate(snapshot);
    options.log?.(`Built Daytona snapshot ${activated.name}`);
    return activated.name;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("already active")) {
      options.log?.(`Built Daytona snapshot ${snapshot.name}`);
      return snapshot.name;
    }
    throw error;
  }
}

async function buildE2bTemplate(
  definition: SandboxImageDefinition,
  options: BuildSandboxImageOptions,
): Promise<string> {
  if (
    !getBuildEnv(options, "E2B_API_KEY") &&
    !getBuildEnv(options, "E2B_ACCESS_TOKEN")
  ) {
    throw new Error("E2B_API_KEY or E2B_ACCESS_TOKEN is required.");
  }

  const { Template, waitForTimeout } = await loadE2bModule();
  let template = Template().fromImage(definition.base).setUser("root");

  if (definition.env) {
    template = template.setEnvs(definition.env);
  }

  if (definition.run?.length) {
    template = template.runCmd(definition.run);
  }

  if (definition.workdir) {
    template = template.setWorkdir(definition.workdir);
  }

  const finalTemplate = definition.cmd?.length
    ? template.setStartCmd(toShellCommand(definition.cmd), waitForTimeout(1000))
    : template;

  const builtTemplate = await Template.build(
    finalTemplate,
    options.imageName ?? buildE2bTemplateReference(definition),
    {
      apiKey: getBuildEnv(options, "E2B_API_KEY"),
      accessToken: getBuildEnv(options, "E2B_ACCESS_TOKEN"),
      domain: getBuildEnv(options, "E2B_DOMAIN"),
      cpuCount: definition.resources?.cpu,
      memoryMB: definition.resources?.memoryMiB,
      onBuildLogs: (entry) => {
        options.log?.(`[${entry.level}] ${entry.message}`);
      },
    },
  );

  const reference = builtTemplate.name;
  options.log?.(`Built E2B template ${reference}`);
  return reference;
}
