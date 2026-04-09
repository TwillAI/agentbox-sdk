export const browserQaFiles = {
  "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Twill Launch Week</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
      body { margin: 0; background: #08111f; color: #f5f7fb; }
      .page { max-width: 960px; margin: 0 auto; padding: 96px 24px; }
      .eyebrow { color: #87a7ff; text-transform: uppercase; letter-spacing: 0.16em; font-size: 12px; }
      h1 { font-size: clamp(40px, 8vw, 72px); line-height: 1; margin: 12px 0 16px; max-width: 12ch; }
      .lede { max-width: 56ch; color: #cbd5e1; line-height: 1.6; }
      .cta { display: inline-block; margin-top: 24px; padding: 14px 20px; border-radius: 999px; background: #7c3aed; color: white; text-decoration: none; font-weight: 600; }
      .card { margin-top: 40px; padding: 24px; border: 1px solid rgba(148, 163, 184, 0.25); border-radius: 24px; background: rgba(15, 23, 42, 0.75); }
      .price { font-size: 32px; font-weight: 700; }
      .price span { color: #94a3b8; font-size: 16px; }
    </style>
  </head>
  <body>
    <main class="page">
      <p class="eyebrow">Launch week</p>
      <h1>Ship agent-powered pull requests in one place.</h1>
      <p class="lede">
        Spin up isolated sandboxes, run your coding agents, and review the output before merging.
      </p>
      <a class="cta" href="#waitlist">Join the waitlist</a>

      <section class="card">
        <h2>Team</h2>
        <p class="price">$49<span>/seat</span></p>
        <p>Includes shared workspaces, agent logs, and preview links.</p>
      </section>
    </main>
  </body>
</html>
`,
} satisfies Record<string, string>;
