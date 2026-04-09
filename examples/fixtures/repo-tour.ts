export const repoTourFiles = {
  "README.md": `# Customer Portal

Monorepo for a workspace billing product.

## Packages

- apps/web: customer-facing dashboard
- apps/api: internal usage APIs
- packages/billing: metering and reporting helpers
`,
  "package.json": `{
  "name": "customer-portal",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev:web": "next dev apps/web",
    "dev:api": "tsx watch apps/api/src/server.ts",
    "test": "vitest run"
  }
}
`,
  "apps/web/app/page.tsx": `import { getUsageSummary } from "@repo/billing/report-usage";

export default async function DashboardPage() {
  const summary = await getUsageSummary("workspace_123");

  return (
    <main>
      <h1>Workspace overview</h1>
      <p>Plan: {summary.planName}</p>
      <p>Spend: $ {summary.monthlySpendUsd.toFixed(2)}</p>
    </main>
  );
}
`,
  "apps/api/src/routes/usage.ts": `import { Router } from "express";
import { getUsageSummary } from "@repo/billing/report-usage";

export const usageRouter = Router();

usageRouter.get("/summary", async (_request, response) => {
  response.json(await getUsageSummary("workspace_123"));
});
`,
  "packages/billing/report-usage.ts": `type UsageSummary = {
  planName: string;
  monthlySpendUsd: number;
  workspaceId: string;
};

export async function getUsageSummary(
  workspaceId: string,
): Promise<UsageSummary> {
  return {
    workspaceId,
    planName: "Growth",
    monthlySpendUsd: 842.18,
  };
}
`,
} satisfies Record<string, string>;
