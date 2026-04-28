# AgentBox

[Live demo](https://agentbox-demo-175164121374.us-west1.run.app/)

Run coding agents inside sandboxes. One API, any provider.

Unlike wrappers that shell out to CLIs in non-interactive mode (e.g. `claude --print`), AgentBox launches each agent as a **server process** inside the sandbox and communicates over WebSocket or HTTP. This preserves the full interactive capabilities of each agent — approval flows, tool-use control, streaming events.

```ts
import { Agent, Sandbox } from "agentbox-sdk";

const sandbox = new Sandbox("local-docker", {
  workingDir: "/workspace",
  image: process.env.IMAGE_ID!,
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
});

await sandbox.findOrProvision();

const run = new Agent("claude-code", {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
}).stream({
  model: "sonnet",
  input: "Create a hello world Express server in /workspace/server.ts",
});

for await (const event of run) {
  if (event.type === "text.delta") process.stdout.write(event.delta);
}

await sandbox.delete();
```

Providers are mix-and-match:

- **Agents** — [`claude-code`](./src/agents/providers/claude-code.ts), [`opencode`](./src/agents/providers/opencode.ts), [`codex`](./src/agents/providers/codex.ts)
- **Sandboxes** — [`local-docker`](./src/sandboxes/providers/local-docker.ts), [`e2b`](./src/sandboxes/providers/e2b.ts), [`modal`](./src/sandboxes/providers/modal.ts), [`daytona`](./src/sandboxes/providers/daytona.ts), [`vercel`](./src/sandboxes/providers/vercel.ts)

Swap either one and your app code stays the same.

## Install

```bash
npm install agentbox-sdk
```

Requires Node >= 20. The agent CLI you want to use (`claude`, `opencode`, `codex`) should be installed inside your sandbox image.

## Getting started

### 1. Build a sandbox image

AgentBox ships with built-in image presets. Build one for your sandbox provider:

```bash
npx agentbox image build --provider local-docker --preset browser-agent
```

This prints an image reference (a Docker tag, Modal image ID, E2B template, or Daytona snapshot depending on the provider). Set it as `IMAGE_ID`:

```bash
export IMAGE_ID=<printed value>
```

### 2. Run an agent

```ts
import { Agent, Sandbox } from "agentbox-sdk";

const sandbox = new Sandbox("local-docker", {
  workingDir: "/workspace",
  image: process.env.IMAGE_ID!,
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
});

// Explicitly attach to / create the sandbox before running anything.
// Subsequent `sandbox.run`, `sandbox.gitClone`, agent runs, etc. all
// require this to have happened first.
await sandbox.findOrProvision();

const agent = new Agent("claude-code", {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
});

const result = await agent.run({
  model: "sonnet",
  input:
    "Explain the project structure and write a summary to /workspace/OVERVIEW.md",
});

console.log(result.text);
await sandbox.delete();
```

### 3. Stream events

`agent.stream()` returns an async iterable of normalized events:

```ts
const run = agent.stream({
  model: "sonnet",
  input: "Write a fizzbuzz in Python",
});

for await (const event of run) {
  if (event.type === "text.delta") {
    process.stdout.write(event.delta);
  }
}

const result = await run.finished;
```

## Agents

Three agent providers are supported. Each wraps a CLI that runs inside the sandbox:

| Provider      | CLI        | Model format                                    |
| ------------- | ---------- | ----------------------------------------------- |
| `claude-code` | `claude`   | `sonnet`, `opus`, `haiku`                       |
| `opencode`    | `opencode` | `anthropic/claude-sonnet-4-6`, `openai/gpt-4.1` |
| `codex`       | `codex`    | `gpt-5.3-codex`, `gpt-5.4`                      |

```ts
new Agent("claude-code", { sandbox, cwd: "/workspace", approvalMode: "auto" });
new Agent("open-code", { sandbox, cwd: "/workspace", approvalMode: "auto" });
new Agent("codex", { sandbox, cwd: "/workspace", approvalMode: "auto" });
```

### Reasoning effort

Pass an optional `reasoning` level alongside `model` on any run. It maps to each provider's native reasoning control: Codex's `effort` on `turn/start`, Claude Code's `--effort` flag, and OpenCode's `reasoningEffort` agent variant.

```ts
await agent.run({
  model: "sonnet",
  reasoning: "high", // "low" | "medium" | "high" | "xhigh"
  input: "Refactor this module and explain your reasoning.",
});
```

`xhigh` requires a model that supports it (e.g. Claude Opus 4.7+, Codex `gpt-5.4`).

## Sandboxes

Five sandbox providers are supported. Each gives you an isolated environment with the same interface:

| Provider       | What it is             | Auth                                                    |
| -------------- | ---------------------- | ------------------------------------------------------- |
| `local-docker` | Local Docker container | Docker daemon                                           |
| `e2b`          | Cloud micro-VM         | `E2B_API_KEY`                                           |
| `modal`        | Cloud container        | `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET`                 |
| `daytona`      | Cloud dev environment  | `DAYTONA_API_KEY`                                       |
| `vercel`       | Ephemeral cloud VM     | `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` |

Every sandbox supports: `findOrProvision()`, `run()`, `runAsync()`, `gitClone()`, `uploadAndRun()`, `openPort()`, `getPreviewLink()`, `snapshot()`, `stop()`, `delete()`.

### Provisioning lifecycle

`new Sandbox(...)` only stores configuration — it does **not** create or attach to a real sandbox. Call `findOrProvision()` once when you're ready to start using it, and every subsequent operation (`run`, `gitClone`, `uploadAndRun`, agent runs, …) reuses that sandbox:

```ts
const sandbox = new Sandbox("modal", {
  /* … */
});

await sandbox.findOrProvision(); // attach to existing tagged sandbox or create a fresh one
await sandbox.gitClone({ repoUrl: "…" });
const result = await sandbox.run("pnpm install");
```

Calling a method that needs a live sandbox before `findOrProvision()` throws a clear error. This makes the (potentially slow) attach / create step explicit and lets you control exactly when it happens.

Vercel sandboxes use runtime snapshots instead of pre-built images — call `sandbox.snapshot()` to capture state and pass the returned id via `provider.snapshotId` on the next run.

Vercel also requires ports to be declared at create time via `provider.ports` — `openPort()` is a no-op at runtime, so any port the agent (or your own code) will listen on must be listed up front:

```ts
const sandbox = new Sandbox("vercel", {
  provider: {
    snapshotId: process.env.VERCEL_SNAPSHOT_ID!,
    ports: [4096], // e.g. opencode; codex/claude-code use 43180
  },
});
```

## Skills

Attach GitHub repos as agent skills. They're cloned into the sandbox and surfaced to the agent:

```ts
const agent = new Agent("claude-code", {
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
```

You can also embed skills inline:

```ts
skills: [
  {
    source: "embedded",
    name: "lint-fix",
    files: {
      "SKILL.md": "Run `npm run lint:fix` and verify the output is clean.",
    },
  },
],
```

## Sub-agents

Delegate tasks to specialized sub-agents:

```ts
const agent = new Agent("claude-code", {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
  subAgents: [
    {
      name: "reviewer",
      description: "Reviews code for bugs and security issues",
      instructions:
        "Flag bugs, security issues, and missing edge cases. Be concise.",
      tools: ["bash", "read"],
    },
  ],
});
```

## MCP servers

Connect MCP servers to give agents access to external tools:

```ts
const agent = new Agent("claude-code", {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
  mcps: [
    {
      name: "filesystem",
      type: "local",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    },
    {
      name: "my-api",
      type: "remote",
      url: "https://mcp.example.com/sse",
    },
  ],
});
```

## Custom commands

Register slash commands the agent can use:

```ts
const agent = new Agent("open-code", {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
  commands: [
    {
      name: "triage",
      description: "Triage a bug report into root cause + fix plan",
      template:
        "Analyze the bug report. Return: root cause, files to change, and tests to add.",
    },
  ],
});
```

## Multimodal input

Pass images and files alongside text:

```ts
import { pathToFileURL } from "node:url";

const result = await agent.run({
  model: "sonnet",
  input: [
    { type: "text", text: "Describe this mockup and suggest improvements." },
    { type: "image", image: pathToFileURL("/workspace/mockup.png") },
  ],
});
```

Provider support: `opencode` (text, images, files), `claude-code` (text, images, PDFs), `codex` (text, images).

## Custom sandbox images

Define your own image when the built-in presets don't cover your needs.

Create `my-image.mjs`:

```js
export default {
  name: "playwright-sandbox",
  base: "node:20-bookworm",
  env: { PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright" },
  run: [
    "apt-get update && apt-get install -y git python3 ca-certificates",
    "npm install -g pnpm @anthropic-ai/claude-code",
    "npx playwright install --with-deps chromium",
  ],
  workdir: "/workspace",
  cmd: ["sleep", "infinity"],
};
```

Build it:

```bash
npx agentbox image build --provider local-docker --file ./my-image.mjs
```

This works with all providers. For cloud providers, the printed value will be that provider's native image reference.

## Hooks

Hooks let you run code at specific points in the agent lifecycle. Each provider has its own hook format:

**Claude Code** — native hook settings:

```ts
new Agent("claude-code", {
  sandbox,
  cwd: "/workspace",
  provider: {
    hooks: {
      PostToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] },
      ],
    },
  },
});
```

**Codex** — similar to Claude Code:

```ts
new Agent("codex", {
  sandbox,
  cwd: "/workspace",
  provider: {
    hooks: {
      PostToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo done" }] },
      ],
    },
  },
});
```

**OpenCode** — plugin-based hooks:

```ts
new Agent("open-code", {
  sandbox,
  cwd: "/workspace",
  provider: {
    plugins: [
      {
        name: "session-notifier",
        hooks: [{ event: "session.idle", body: 'return "session-idle";' }],
      },
    ],
  },
});
```

## Examples

The [`examples/`](./examples) directory has short, runnable scripts that each demonstrate one feature:

| Example                                                         | What it shows                 |
| --------------------------------------------------------------- | ----------------------------- |
| [`basic.ts`](./examples/basic.ts)                               | Minimal agent + sandbox       |
| [`streaming.ts`](./examples/streaming.ts)                       | Stream and handle events      |
| [`interactive-approval.ts`](./examples/interactive-approval.ts) | Approve tool calls from stdin |
| [`skills.ts`](./examples/skills.ts)                             | Attach a GitHub skill         |
| [`sub-agents.ts`](./examples/sub-agents.ts)                     | Delegate to sub-agents        |
| [`mcp-server.ts`](./examples/mcp-server.ts)                     | Connect an MCP server         |
| [`multimodal.ts`](./examples/multimodal.ts)                     | Send images to the agent      |
| [`custom-image.ts`](./examples/custom-image.ts)                 | Build a custom sandbox image  |
| [`cloud-sandbox.ts`](./examples/cloud-sandbox.ts)               | Use E2B, Modal, or Daytona    |
| [`basic-vercel.ts`](./examples/basic-vercel.ts)                 | Use a Vercel sandbox          |
| [`git-clone.ts`](./examples/git-clone.ts)                       | Clone a repo into the sandbox |

All examples import from `"agentbox-sdk"` like a normal dependency. Run them with:

```bash
npx tsx examples/basic.ts
```

## Package exports

```ts
import { Agent, Sandbox } from "agentbox-sdk"; // main entrypoint
import type { AgentRun } from "agentbox-sdk/agents"; // agent types
import type { CommandResult } from "agentbox-sdk/sandboxes"; // sandbox types
import type { NormalizedAgentEvent } from "agentbox-sdk/events"; // event types
```

## Contributing

```bash
npm install
npm run build
npm run typecheck
npm test
```

`npm run build` generates the `dist/` directory. You need to build before the examples or CLI work locally.

To test your local build from another project:

```bash
npm run build && npm pack
# then in your project:
npm install /path/to/agentbox-sdk-0.1.0.tgz
```

### Tests

```bash
npm test                                              # fast, no real providers
AGENTBOX_RUN_SMOKE_TESTS=1 npm run test:smoke         # live smoke tests
AGENTBOX_RUN_MATRIX_E2E=1 npm run test:e2e:matrix     # provider matrix
```

Live test suites are opt-in because they provision real infrastructure.

## License

MIT
