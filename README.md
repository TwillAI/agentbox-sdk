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
- `modal`
- `daytona`

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

## Hooks

Hooks are not part of the shared cross-provider `Agent` surface because the runtimes do not share the same hook lifecycle semantics.

Current support:

- `claude-code`: configure native hook settings under `provider.hooks`
- `codex`: configure native hook settings under `provider.hooks` (experimental in Codex)
- `opencode`: configure native plugin hooks under `provider.plugins`

Claude Code example:

```ts
const agent = new Agent("claude-code", {
  sandbox,
  cwd: "/workspace",
  provider: {
    hooks: {
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: "echo done",
            },
          ],
        },
      ],
    },
  },
});
```

Codex example:

```ts
const agent = new Agent("codex", {
  sandbox,
  cwd: "/workspace",
  provider: {
    hooks: {
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: "echo done",
              statusMessage: "Reviewing Bash output",
            },
          ],
        },
      ],
    },
  },
});
```

OpenCode example:

```ts
const agent = new Agent("opencode", {
  sandbox,
  cwd: "/workspace",
  provider: {
    plugins: [
      {
        name: "session-notifier",
        hooks: [
          {
            event: "session.idle",
            body: 'return "session-idle";',
          },
        ],
      },
    ],
  },
});
```

## Multimodal input

`Agent.run()` and `Agent.stream()` accept either a plain string or an AI SDK-style array of user parts:

- `text`
- `image`
- `file`

Example:

```ts
import { pathToFileURL } from "node:url";
import { Agent } from "openagent";

const result = await agent.run({
  input: [
    {
      type: "text",
      text: "Compare the design mockup and the attached brief.",
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
});
```

Current provider support:

- `opencode`: text, images, and files
- `claude-code`: text, images, PDFs, and text-like files
- `codex`: text and images; generic `file` parts still fail fast

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

## Custom images

You can also build your own sandbox image definition instead of using a built-in preset.

Example `images/playwright-sandbox.mjs`:

```js
export default {
  name: "playwright-sandbox",
  base: "node:20-bookworm",
  env: {
    DEBIAN_FRONTEND: "noninteractive",
    PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
  },
  run: [
    "apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates && rm -rf /var/lib/apt/lists/*",
    "npm install -g pnpm @openai/codex",
    "npx playwright install --with-deps chromium",
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
npx openagent image build \
  --provider local-docker \
  --file ./images/playwright-sandbox.mjs \
  --image-name openagent/playwright-sandbox:dev
```

The command prints the image reference you should pass to `Sandbox`:

```ts
import { Sandbox } from "openagent";

const sandbox = new Sandbox("local-docker", {
  workingDir: "/workspace",
  image: "openagent/playwright-sandbox:dev",
  env: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
  },
});
```

`--file` works with all providers. For `modal` and `daytona`, the printed value will be that provider's image id or snapshot name instead of a Docker tag.

## Examples

Example scripts live in `examples/`:

- `examples/basic-codex.ts`
- `examples/basic-opencode.ts`
- `examples/basic-claude-code.ts`
- `examples/multimodal-claude-code.ts`
- `examples/basic-modal.ts`

Run them with:

```bash
npm run examples:codex
npm run examples:opencode
npm run examples:claude
npm run examples:multimodal
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
