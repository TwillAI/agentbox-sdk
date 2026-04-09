export const issueTriageFiles = {
  "README.md": `# Notifications Dashboard

Support dashboard for triaging customer inbox items.
`,
  "src/api.ts": `export async function fetchInbox() {
  const response = await fetch("/api/inbox");
  if (response.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (!response.ok) {
    throw new Error("INBOX_REQUEST_FAILED");
  }

  return response.json();
}
`,
  "src/useInbox.ts": `import { useEffect, useState } from "react";
import { fetchInbox } from "./api";

export function useInbox() {
  const [items, setItems] = useState<Array<{ id: string; subject: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [needsLogin, setNeedsLogin] = useState(false);

  useEffect(() => {
    fetchInbox()
      .then((data) => {
        setItems(data.items);
        setIsLoading(false);
      })
      .catch((error) => {
        if (error instanceof Error && error.message === "UNAUTHORIZED") {
          setNeedsLogin(true);
          return;
        }

        setIsLoading(false);
      });
  }, []);

  return { items, isLoading, needsLogin };
}
`,
  "issue-report.md": `Users with expired sessions sometimes see an infinite loading state instead of getting sent back to login.

What we know:
- Sentry mostly shows 401 responses from /api/inbox
- Support says it happens after the app has been open for a while
- We want the root cause, likely files to touch, and tests to add
`,
} satisfies Record<string, string>;
