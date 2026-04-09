import {
  LOCAL_DOCKER_E2E_PROVIDERS,
  runApprovalScenario,
  runHookScenario,
  runSimpleScenario,
  runSkillScenario,
  runSubAgentScenario,
} from "./local-docker-e2e";

async function main() {
  const results: Array<Record<string, unknown>> = [];

  for (const provider of LOCAL_DOCKER_E2E_PROVIDERS) {
    const providerResult: Record<string, unknown> = { provider };

    try {
      providerResult.simple = await runSimpleScenario(provider);
      providerResult.skills = await runSkillScenario(provider);
      providerResult.subAgents = await runSubAgentScenario(provider);
      providerResult.approval = await runApprovalScenario(provider);
      providerResult.hooks = await runHookScenario(provider);
    } catch (error) {
      providerResult.error =
        error instanceof Error ? error.stack || error.message : String(error);
    }

    results.push(providerResult);
  }

  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

await main();
