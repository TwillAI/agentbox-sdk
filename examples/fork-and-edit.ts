import { Agent, AgentProvider, Sandbox, SandboxProvider } from "agentbox-sdk";

// Demonstrates the two-step "edit message and rerun" flow:
//   1. Run the agent normally and capture the messageId of a user turn.
//   2. Call `agent.forkAt(...)` to truncate the session at that message.
//   3. Start a new run with `resumeSessionId` set to the forked sessionId
//      and an edited input that effectively replaces the dropped message.

const sandbox = new Sandbox(SandboxProvider.LocalDocker, {
  workingDir: "/workspace",
  image: process.env.IMAGE_ID!,
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
});

await sandbox.findOrProvision();

const agent = new Agent(AgentProvider.ClaudeCode, {
  sandbox,
  cwd: "/workspace",
  approvalMode: "auto",
});

await agent.setup();

// First turn: send a message and remember its messageId.
const firstRun = agent.stream({
  model: "sonnet",
  input:
    "Write a fizzbuzz function in Python and save it to /workspace/fizzbuzz.py",
});

let firstUserMessageId: string | undefined;
for await (const event of firstRun) {
  if (event.type === "message.started" && event.messageId) {
    firstUserMessageId = event.messageId;
  }
  if (event.type === "text.delta") {
    process.stdout.write(event.delta);
  }
}

const firstResult = await firstRun.finished;
console.log(`\n\nOriginal session: ${firstResult.sessionId}`);
console.log(`First user messageId: ${firstUserMessageId}`);

if (!firstUserMessageId) {
  throw new Error("Could not capture initial messageId.");
}

// Fork the session at the user's first message — this drops that user
// message AND the assistant response that followed it.
console.log("\n--- Forking session ---\n");
const forked = await agent.forkAt({
  sessionId: firstResult.sessionId,
  messageId: firstUserMessageId,
});
console.log(`Forked session: ${forked.sessionId}`);

// Resume the forked session with an edited prompt. The forked transcript
// only contains messages BEFORE the dropped one, so this effectively
// replaces the original instruction.
const editedRun = agent.stream({
  model: "sonnet",
  resumeSessionId: forked.sessionId,
  input:
    "Write a function that prints the first 20 prime numbers, save to /workspace/primes.py.",
});

for await (const event of editedRun) {
  if (event.type === "text.delta") {
    process.stdout.write(event.delta);
  }
}

const editedResult = await editedRun.finished;
console.log(`\n\nEdited run completed: ${editedResult.sessionId}`);

await sandbox.delete();
