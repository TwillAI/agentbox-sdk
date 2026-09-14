
import { mkdtemp, readFile, rm, writeFile, access, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpenCodeAgentAdapter } from "../src/agents/providers/opencode";
import type { AgentSetupRequest } from "../src/agents/types";

describe("local OpenCode server ownership", () => {
  it("uses different private servers for different Agents and only stops its own process", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agentbox-opencode-test-"));
    const binary = path.join(directory, "opencode");
    await writeFile(binary, `#!${process.execPath}
import http from 'node:http';
import fs from 'node:fs';
const port = Number(process.argv[process.argv.lastIndexOf('--port') + 1]);
const expected = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
http.createServer((req, res) => {
  res.writeHead(req.headers.authorization === expected ? 200 : 401);
  res.end('{}');
}).listen(port, '127.0.0.1', () => fs.writeFileSync(process.env.RECORD_FILE, JSON.stringify({ port, config: process.env.OPENCODE_CONFIG, questions: process.env.OPENCODE_ENABLE_QUESTION_TOOL, configDir: process.env.OPENCODE_CONFIG_DIR, disablePlugins: process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS, cwd: process.cwd() })));
`, { mode: 0o700 });
    const adapter = new OpenCodeAgentAdapter();
    const requests: AgentSetupRequest<"open-code">[] = [1, 2].map((index) => ({ provider: "open-code", options: { cwd: directory, stateDirectory: path.join(directory, "state"), env: { RECORD_FILE: path.join(directory, `server-${index}.json`) }, provider: { binary }, approvalMode: "interactive" } }));
    const nativeConfig = path.join(directory, "user-config.json");
    await writeFile(nativeConfig, '{"mcp":{"user-owned":{}}}');
    requests.push({ provider: "open-code", options: { cwd: directory, configuration: "native", stateDirectory: path.join(directory, "unused-state"), env: { RECORD_FILE: path.join(directory, "native.json"), OPENCODE_CONFIG: nativeConfig }, provider: { binary }, approvalMode: "interactive" } });
    try {
      await Promise.all(requests.map((request) => adapter.setup(request)));
      const native = JSON.parse(await readFile(path.join(directory, "native.json"), "utf8"));
      expect(native.config).toBe(nativeConfig);
      expect(native.configDir).toBeUndefined();
      expect(native.disablePlugins).toBeUndefined();
      expect(native.questions).toBeUndefined();
      expect(native.cwd).toBe(await realpath(directory));
      expect(await readFile(nativeConfig, "utf8")).toBe('{"mcp":{"user-owned":{}}}');
      await expect(access(path.join(directory, "unused-state"))).rejects.toThrow();
      const [first, second] = await Promise.all([1, 2].map(async (index) => JSON.parse(await readFile(path.join(directory, `server-${index}.json`), "utf8")) as { port: number; config: string; questions: string }));
      if (!first || !second || !requests[0]) throw new Error("Expected two server fixtures");
      expect(first.port).not.toBe(second.port);
      expect(first.config).not.toBe(second.config);
      expect(first.questions).toBe("true");
      const config = JSON.parse(await readFile(first.config, "utf8")) as { agent: Record<string, { tools: { question: boolean } }> };
      expect(Object.values(config.agent).some((agent) => agent.tools?.question === true)).toBe(true);
      expect((await fetch(`http://127.0.0.1:${first.port}/global/health`)).status).toBe(401);
      await adapter.killServer(requests[0]);
      await expect(fetch(`http://127.0.0.1:${first.port}/global/health`)).rejects.toThrow();
      expect((await fetch(`http://127.0.0.1:${second.port}/global/health`)).status).toBe(401);
    } finally {
      await Promise.all(requests.map((request) => adapter.killServer(request)));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
