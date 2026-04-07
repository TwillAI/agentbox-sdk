# OpenAgent

`openagent` is a Bun-friendly TypeScript package for running coding agents and sandboxes through a single readable API.

It focuses on two things:

- swapping between `codex`, `opencode`, and `claude-code` without rewriting your app
- swapping between `local-docker`, `modal`, and `daytona` without rewriting your app

You still get escape hatches when you need them:

- `agentRun.rawEvents()` exposes provider-native agent events
- `sandbox.raw` exposes the provider SDK object or process handle
- normalized events are available in an AI SDK-style format

## Status

This package is a clean greenfield starting point for an open-source runtime. The abstractions are stable and typechecked, but the provider integrations are intentionally thin and readable rather than deeply optimized or fully production-hardened.

## Install

```bash
bun add openagent
```

## Local dev

For local development in this repo:

```bash
npm install
npm run build
npm run typecheck
npm test
```

`npm run build` generates the published entrypoints in `dist/`. Run it before testing the package locally, since both the package exports and the CLI point at built files under `dist/`.

While developing inside this repo, prefer the built CLI directly:

```bash
node ./dist/cli.js image build --provider local-docker --preset browser-agent
```

If you want to consume your local checkout from another project, build and pack it first:

```bash
npm run build
npm pack
```

Then install the generated tarball from the other project:

```bash
npm install /absolute/path/to/openagent/openagent-<version>.tgz
```

Runtime expectations:

- Bun `>=1.1`
- Node `>=20` for local host-side tooling
- provider CLIs installed where you plan to run them

## Get Started

Pick a sandbox provider first:

- `local-docker` if you want the easiest local setup and already have Docker running
- `modal` if you want managed sandboxes with preview URLs
- `daytona` if you want managed sandboxes and are comfortable prebuilding snapshots

If you are not using `local-docker`, make sure you already have provider credentials ready before you start:

- `modal` needs `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`
- `daytona` needs `DAYTONA_API_KEY` or `DAYTONA_JWT_TOKEN`

Build the built-in `browser-agent` image for your provider. The command prints a single image reference string you will pass to `Sandbox`.

```bash
npx openagent image build --provider local-docker|modal|daytona --preset browser-agent
```

Then use the printed image id as `IMAGE_ID`, choose your provider as `OPENAGENT_PROVIDER`, and instantiate a sandbox plus an OpenCode agent that visits a common website and saves a screenshot as proof.

```ts
import { Agent, Sandbox } from "openagent";

const imageId = YOUR_IMAGE_ID;
const anthropicApiKey = YOUR_ANTHROPIC_API_KEY;

const sandbox = new Sandbox("local-docker", {
  workingDir: "/workspace",
  image: imageId,
  env: {
    ANTHROPIC_API_KEY: anthropicApiKey,
  },
  provider: {
    publishedPorts: [4096],
  },
});

const agent = new Agent("opencode", {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
  skills: [
    {
      name: "agent-browser",
      repo: "https://github.com/vercel-labs/agent-browser",
    },
  ],
});

const run = agent.stream({
  input:
    "Browse https://example.com, save a screenshot to /workspace/example-home.png, and tell me where you saved it and what you saw.",
  model: "anthropic/claude-sonnet-4-6",
});

const sessionId = await run.sessionIdReady;

for await (const event of run) {
  process.stdout.write(event.delta);
}

const result = await run.finished;
console.log("\nFinal text:", result.text);
```

## Main API

### `Sandbox`

```ts
const sandbox = new Sandbox("daytona", {
  tags: { repo: "demo" },
  workingDir: "/workspace",
  image: "daytona-browser-agent-snapshot",
  provider: {
    apiKey: process.env.DAYTONA_API_KEY,
    target: "us",
  },
});
```

Common methods:

- `gitClone()`
- `run()`
- `runAsync()`
- `setSecret()` and `setSecrets()`
- `list({ tags })`
- `snapshot()`
- `stop()`
- `delete()`
- `getPreviewLink()`

### `Agent`

```ts
const agent = new Agent("claude-code", {
  sandbox,
  cwd: "/workspace/repo",
  approvalMode: "interactive",
  skills: [{ name: "frontend-design" }],
  commands: [
    {
      name: "review",
      description: "Review the current worktree",
      template:
        "Review the current changes and list bugs, regressions, and missing tests.",
    },
  ],
});

const run = agent.stream({
  input: "Summarize the repository structure.",
  model: "claude-opus-4-1",
  systemPrompt: "Be concise and prioritize architectural signal over detail.",
});
```

Common methods:

- `stream({ input, model?, systemPrompt?, resumeSessionId? })` returns an async iterable run handle
- `run({ input, model?, systemPrompt?, resumeSessionId? })` collects the full result
- `rawEvents({ input, model?, systemPrompt?, resumeSessionId? })` is a convenience wrapper when you only want raw events

Run-handle methods:

- async iteration over normalized events
- `sessionId`
- `sessionIdReady`
- `rawEvents()`
- `toAISDKEvents()`
- `respondToPermission({ requestId, decision, remember? })`
- `abort()`
- `finished`

## Normalized Events

OpenAgent keeps the original provider payloads and also maps them into a smaller event vocabulary:

- `run.started`
- `message.started`
- `text.delta`
- `reasoning.delta`
- `tool.call.started`
- `tool.call.delta`
- `tool.call.completed`
- `permission.requested`
- `permission.resolved`
- `message.completed`
- `run.completed`
- `run.error`

This makes it easy to build a UI once while still keeping access to the underlying protocol details.

When `approvalMode: "interactive"` is set, permission prompts pause the run and arrive as `permission.requested` events. Reply with `run.respondToPermission(...)` to continue.

## Provider Notes

### Agents

| Provider      | Transport shape              | Notes                                                                                                                        |
| ------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `codex`       | Codex app-server JSON-RPC    | Supports MCPs, skills, and sub-agents. `model` and `system` are run-scoped. Custom commands and hooks are not yet supported. |
| `opencode`    | HTTP + SSE app server        | Supports MCPs, skills, sub-agents, and commands through generated OpenCode config. Hooks are not yet supported.              |
| `claude-code` | WebSocket `--sdk-url` bridge | Supports MCPs, skills, sub-agents, hooks, and commands. `model` and `system` are applied per run.                            |

### Sandboxes

| Provider       | Strengths                                 | Snapshot support        |
| -------------- | ----------------------------------------- | ----------------------- |
| `local-docker` | Best local dev story, easy inspection     | `null`                  |
| `modal`        | Strong command execution and preview URLs | Returns Modal image ids |
| `daytona`      | Good managed workspace model and labels   | `null` in this package  |

Common sandbox config lives at the top level:

- `image: string` is the only image input
- for `local-docker`, `image` is a local Docker image name/tag
- for `modal`, `image` is an existing Modal image id
- for `daytona`, `image` is a prebuilt Daytona snapshot name with sizing baked in
- `resources: { cpu, memoryMiB }` applies only to `local-docker` and `modal`

Provider-specific escape hatches still live under `provider`, for example:

- `local-docker.provider.publishedPorts`
- `daytona.provider.target`

## Built-In Images

OpenAgent ships two built-in image definitions under `images/`:

- `browser-agent` installs `codex`, `claude-code`, `opencode`, and the browser-agent stack
- `computer-use` extends `browser-agent` with the Linux/X11 tooling needed for computer-use flows

Build one for a provider with:

```bash
npx openagent image build --provider modal --preset browser-agent
```

or:

```bash
npx openagent image build --provider daytona --preset computer-use
```

The command prints a single reference string to stdout:

- local Docker: a Docker tag you can pass directly as `image`
- Modal: a Modal image id
- Daytona: a Daytona snapshot name you can pass directly as `image`

You can also build your own definition in the same format:

```js
export default {
  name: "my-browser-image",
  base: "node:20-bookworm",
  env: {
    DEBIAN_FRONTEND: "noninteractive",
  },
  run: [
    "apt-get update && apt-get install -y --no-install-recommends git curl",
    "npm install -g @openai/codex @anthropic-ai/claude-code opencode-ai",
  ],
  workdir: "/workspace",
  cmd: ["sleep", "infinity"],
  resources: {
    cpu: 4,
    memoryMiB: 8192,
  },
};
```

Build it with:

```bash
npx openagent image build --provider local-docker --file ./my-image.mjs
```

## Raw vs Normalized Access

Use normalized events for product code:

```ts
for await (const event of run) {
  if (event.type === "tool.call.started") {
    console.log("tool:", event.toolName);
  }
}
```

Use raw access when you need a provider-specific escape hatch:

```ts
for await (const raw of run.rawEvents()) {
  console.dir(raw, { depth: null });
}

console.dir(sandbox.raw, { depth: null });
```

## Agent Options vs Run Options

`Agent` now separates reusable runtime setup from per-run prompt controls.

Construction-time config:

- `sandbox`
- `cwd`
- `env`
- `approvalMode`
- `mcps`
- `skills`
- `subAgents`
- `hooks`
- `commands`
- provider-specific escape hatches under `provider`

Run-time config:

- `input`
- `model`
- `systemPrompt`
- `resumeSessionId`

Example:

```ts
const agent = new Agent("codex", {
  sandbox,
  cwd: "/workspace/repo",
  approvalMode: "interactive",
  skills: [
    { name: "frontend-design" },
    {
      source: "embedded",
      name: "release-helper",
      files: {
        "SKILL.md":
          "# Release helper\n\nUse this skill for release-note formatting.",
      },
    },
  ],
  subAgents: [
    {
      name: "reviewer",
      description: "Review for bugs and regressions",
      instructions:
        "Review the current changes and flag likely bugs and missing tests.",
      tools: ["bash"],
    },
  ],
});

const result = await agent.run({
  input: "Inspect the latest changes.",
  model: "gpt-5.4",
  systemPrompt: "Prioritize correctness and test gaps.",
});

const followUp = await agent.run({
  input: "Continue from the previous conversation and finish the fix.",
  model: "gpt-5.4",
  resumeSessionId: result.sessionId,
});
```

## Examples

Example scripts live in `examples/`:

- `examples/basic-codex.ts`
- `examples/basic-opencode.ts`
- `examples/basic-claude-code.ts`
- `examples/basic-modal.ts`

Run them with:

```bash
npm run examples:codex
npm run examples:opencode
npm run examples:claude
npm run examples:modal
```

## Smoke Tests

The regular test suite is fast and does not hit real providers.

For optional live smoke tests, export the provider credentials or server URLs you want to exercise and then run:

```bash
OPENAGENT_RUN_SMOKE_TESTS=1 npm run test:smoke
```

The smoke tests are intentionally opt-in because they may provision real infrastructure.

For the full local Docker agent E2E suite, run:

```bash
OPENAGENT_RUN_LOCAL_DOCKER_E2E=1 npm run test:e2e:local-docker
```

This suite exercises all three agent providers with local Docker and covers a simple prompt plus shared runtime features like embedded skills, sub-agents, and interactive approvals. Claude Code also gets hook coverage because hooks are only supported there today.

A GitHub Actions workflow is included at `.github/workflows/local-docker-e2e.yml`. It builds `docker/e2e/Dockerfile` and runs the same Vitest suite in CI. Configure these repository secrets before enabling it:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

## Adding Providers

The repo is organized so new providers stay easy to read:

- `src/agents/providers/*` for coding agents
- `src/agents/transports/*` for reusable process, SSE, JSON-RPC, and WebSocket plumbing
- `src/sandboxes/providers/*` for sandbox backends
- `src/events/*` for raw and normalized event models

When adding a provider:

1. Define the provider-specific options in `src/agents/types.ts` or `src/sandboxes/types.ts`.
2. Add a small adapter class in the matching `providers/` folder.
3. Keep provider-native payloads available through `raw`.
4. Add at least one focused unit test and one example if the API shape is new.
