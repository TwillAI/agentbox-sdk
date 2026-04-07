# OpenAgent

`openagent` is a TypeScript package for running coding agents inside sandboxes with one consistent API.

It is mainly useful when you want to:

- switch between `codex`, `opencode`, and `claude-code`
- switch between `local-docker`, `modal`, and `daytona`
- keep the same high-level app code while changing providers underneath

## Install

```bash
bun add openagent
```

Requirements:

- Bun `>=1.1`
- Node `>=20` for local host-side tooling
- provider CLIs installed where you plan to run them

## Local dev

For local development in this repo:

```bash
npm install
npm run build
npm run typecheck
npm test
```

`npm run build` is required before using the package locally because the published entrypoints and CLI are generated into `dist/`.

To use the local CLI while developing in this repo:

```bash
node ./dist/cli.js image build --provider local-docker --preset browser-agent
```

To try your local build from another project:

```bash
npm run build
npm pack
npm install /absolute/path/to/openagent/openagent-<version>.tgz
```

## Quickstart

Pick a sandbox provider:

- `local-docker` for the easiest local setup
- `modal` for managed sandboxes and preview URLs
- `daytona` for managed sandboxes with prebuilt snapshots

Provider credentials:

- `modal` needs `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`
- `daytona` needs `DAYTONA_API_KEY` or `DAYTONA_JWT_TOKEN`

Build the built-in `browser-agent` image for your provider. The command prints a single image reference string you can pass as `image`.

```bash
npx openagent image build --provider local-docker --preset browser-agent
```

Then run an agent:

```ts
import { Agent, Sandbox } from "openagent";

const sandbox = new Sandbox("local-docker", {
  workingDir: "/workspace",
  image: process.env.IMAGE_ID!,
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
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

const result = await agent.run({
  input:
    "Browse https://example.com, save a screenshot to /workspace/example-home.png, and tell me what you saw.",
  model: "anthropic/claude-sonnet-4-6",
});

console.log(result.text);
```

## Built-in images

OpenAgent ships with two presets:

- `browser-agent` for browser automation and common coding-agent workflows
- `computer-use` for computer-use flows that need extra Linux/X11 tooling

Examples:

```bash
npx openagent image build --provider modal --preset browser-agent
npx openagent image build --provider daytona --preset computer-use
```

The printed value is:

- a Docker image tag for `local-docker`
- a Modal image id for `modal`
- a Daytona snapshot name for `daytona`

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

## Tests

The default test suite is fast and does not hit real providers:

```bash
npm test
```

Optional live smoke tests:

```bash
OPENAGENT_RUN_SMOKE_TESTS=1 npm run test:smoke
```

Full local Docker E2E suite:

```bash
OPENAGENT_RUN_LOCAL_DOCKER_E2E=1 npm run test:e2e:local-docker
```

The live suites are opt-in because they may provision real infrastructure.
