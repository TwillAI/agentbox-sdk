import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAndWait: vi.fn(),
  list: vi.fn(),
  createSnapshotAndWait: vi.fn(),
  clientClose: vi.fn(),
  clientCtor: vi.fn(),
}));

vi.mock("@tenkicloud/sandbox", () => {
  class SessionNotFoundError extends Error {
    name = "SessionNotFoundError";
  }
  class TenkiSandbox {
    createAndWait = mocks.createAndWait;
    list = mocks.list;
    createSnapshotAndWait = mocks.createSnapshotAndWait;
    close = mocks.clientClose;
    constructor(options: unknown) {
      mocks.clientCtor(options);
    }
  }
  return { TenkiSandbox, SessionNotFoundError };
});

import { Sandbox, SandboxProvider } from "../src";

const enc = new TextEncoder();
const MARKER_TAGS = { "agentbox.provider": "tenki" };

type HandleOptions = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  hang?: boolean;
};

function makeHandle(options: HandleOptions = {}) {
  const { stdout = "", stderr = "", exitCode = 0, hang = false } = options;

  const stream = (content: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (content) {
          controller.enqueue(enc.encode(content));
        }
        if (!hang) {
          controller.close();
        }
      },
    });

  const result = {
    exitCode,
    stdout: enc.encode(stdout),
    stderr: enc.encode(stderr),
  };
  let resolveResult!: (value: typeof result) => void;
  const resultPromise = new Promise<typeof result>((resolve) => {
    resolveResult = resolve;
  });
  if (!hang) {
    resolveResult(result);
  }

  const writes: Uint8Array[] = [];

  return {
    stdout: stream(stdout),
    stderr: stream(stderr),
    stdin: new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(chunk);
      },
    }),
    pid: Promise.resolve(1),
    kill: vi.fn(async () => {}),
    then<T, R>(
      onfulfilled?: ((value: typeof result) => T | PromiseLike<T>) | null,
      onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null,
    ) {
      return resultPromise.then(onfulfilled, onrejected);
    },
    _writes: writes,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "sess-123",
    state: "RUNNING",
    metadata: { ...MARKER_TAGS },
    run: vi.fn(() => makeHandle({ stdout: "ok\n" })),
    exposePort: vi.fn(async (port: number) => ({
      port,
      previewUrl: `https://preview.tenki.sh/${port}`,
    })),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => enc.encode("file-body")),
    resume: vi.fn(async () => {}),
    waitReady: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeSandbox(options: Record<string, unknown> = {}) {
  return new Sandbox(SandboxProvider.Tenki, {
    provider: { apiKey: "tk_test" },
    ...options,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([]);
});

describe("lifecycle", () => {
  it("provisions via createAndWait with metadata, marker tag, and defaults", async () => {
    const session = makeSession();
    mocks.createAndWait.mockResolvedValue(session);

    const sb = makeSandbox({ tags: { scope: "test" } });
    await sb.findOrProvision();

    expect(mocks.clientCtor).toHaveBeenCalledWith(
      expect.objectContaining({ authToken: "tk_test" }),
    );
    expect(mocks.createAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        allowInbound: true,
        allowOutbound: true,
        metadata: { ...MARKER_TAGS, scope: "test" },
        tags: ["agentbox.provider:tenki"],
      }),
    );
    expect(sb.id).toBe("sess-123");
    expect(sb.isWarm).toBe(false);
  });

  it("creates a non-default working directory with a privileged run", async () => {
    const run = vi.fn(() => makeHandle());
    mocks.createAndWait.mockResolvedValue(makeSession({ run }));

    const sb = makeSandbox({ workingDir: "/workspace" });
    await sb.findOrProvision();

    expect(run).toHaveBeenCalledWith(
      ["/bin/sh", "-c", expect.stringContaining("mkdir -p '/workspace'")],
      { privileged: true },
    );
  });

  it("closes the fresh session when working-directory setup fails", async () => {
    const session = makeSession({
      run: vi.fn(() => makeHandle({ exitCode: 1, stderr: "mkdir: denied" })),
    });
    mocks.createAndWait.mockResolvedValue(session);

    const sb = makeSandbox({ workingDir: "/workspace" });
    await expect(sb.findOrProvision()).rejects.toThrow(/working directory/);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(sb.id).toBeUndefined();
  });

  it("warm-reuses a RUNNING session without resuming", async () => {
    const session = makeSession();
    mocks.list.mockResolvedValue([session]);

    const sb = makeSandbox();
    await sb.findOrProvision();

    expect(sb.isWarm).toBe(true);
    expect(sb.id).toBe("sess-123");
    expect(session.resume).not.toHaveBeenCalled();
    expect(session.waitReady).not.toHaveBeenCalled();
    expect(mocks.createAndWait).not.toHaveBeenCalled();
  });

  it("resumes only PAUSED sessions and waits on transitional ones", async () => {
    for (const [state, expected] of [
      ["PAUSED", "resume"],
      ["CREATING", "waitReady"],
      ["RESUMING", "waitReady"],
    ] as const) {
      vi.clearAllMocks();
      const session = makeSession({ state });
      mocks.list.mockResolvedValue([session]);

      const sb = makeSandbox();
      await sb.findOrProvision();

      expect(session.resume).toHaveBeenCalledTimes(expected === "resume" ? 1 : 0);
      expect(session.waitReady).toHaveBeenCalledTimes(
        expected === "waitReady" ? 1 : 0,
      );
    }
  });

  it("does not warm-reuse PAUSING or terminal sessions", async () => {
    const pausing = makeSession({ state: "PAUSING" });
    const terminated = makeSession({ state: "TERMINATED" });
    mocks.list.mockResolvedValue([pausing, terminated]);
    const fresh = makeSession({ id: "sess-new" });
    mocks.createAndWait.mockResolvedValue(fresh);

    const sb = makeSandbox();
    await sb.findOrProvision();

    expect(sb.id).toBe("sess-new");
    expect(sb.isWarm).toBe(false);
  });

  it("propagates lookup failures instead of creating another sandbox", async () => {
    mocks.list.mockRejectedValue(new Error("auth expired"));

    const sb = makeSandbox();
    await expect(sb.findOrProvision()).rejects.toThrow("auth expired");
    expect(mocks.createAndWait).not.toHaveBeenCalled();
  });

  it("pauses on stop and closes session + client on delete", async () => {
    const session = makeSession();
    mocks.createAndWait.mockResolvedValue(session);

    const sb = makeSandbox();
    await sb.findOrProvision();

    await sb.stop();
    expect(session.pause).toHaveBeenCalled();

    await sb.delete();
    expect(session.close).toHaveBeenCalled();
    expect(mocks.clientClose).toHaveBeenCalled();
  });

  it("keeps the session reference when close() fails so delete can be retried", async () => {
    let closeCalls = 0;
    const session = makeSession({
      close: vi.fn(async () => {
        closeCalls++;
        if (closeCalls === 1) {
          throw new Error("network blip");
        }
      }),
    });
    mocks.createAndWait.mockResolvedValue(session);

    const sb = makeSandbox();
    await sb.findOrProvision();

    await expect(sb.delete()).rejects.toThrow("network blip");
    expect(sb.id).toBe("sess-123");

    await sb.delete();
    expect(sb.id).toBeUndefined();
    expect(closeCalls).toBe(2);
  });

  it("treats an already-gone session as successfully deleted", async () => {
    const { SessionNotFoundError } = await import("@tenkicloud/sandbox");
    const session = makeSession({
      close: vi.fn(async () => {
        throw new SessionNotFoundError("gone");
      }),
    });
    mocks.createAndWait.mockResolvedValue(session);

    const sb = makeSandbox();
    await sb.findOrProvision();

    await sb.delete();
    expect(sb.id).toBeUndefined();
  });

  it("snapshots via createSnapshotAndWait", async () => {
    mocks.createAndWait.mockResolvedValue(makeSession());
    mocks.createSnapshotAndWait.mockResolvedValue({ id: "snap-1" });

    const sb = makeSandbox();
    await sb.findOrProvision();

    expect(await sb.snapshot()).toBe("snap-1");
    expect(mocks.createSnapshotAndWait).toHaveBeenCalledWith("sess-123");
  });

  it("lists sessions filtered by tags mirrored into metadata", async () => {
    const mine = makeSession({ metadata: { ...MARKER_TAGS, scope: "a" } });
    const other = makeSession({
      id: "sess-other",
      metadata: { ...MARKER_TAGS, scope: "b" },
    });
    mocks.list.mockResolvedValue([mine, other]);

    const sb = makeSandbox({ tags: { scope: "a" } });
    const descriptors = await sb.list();

    expect(mocks.list).toHaveBeenCalledWith({
      tags: ["agentbox.provider:tenki"],
    });
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      provider: "tenki",
      id: "sess-123",
      state: "RUNNING",
      tags: { ...MARKER_TAGS, scope: "a" },
    });
  });
});

describe("run", () => {
  async function provisioned(session: ReturnType<typeof makeSession>) {
    mocks.createAndWait.mockResolvedValue(session);
    const sb = makeSandbox();
    await sb.findOrProvision();
    return sb;
  }

  it("maps stdout, stderr, and exit code", async () => {
    const sb = await provisioned(
      makeSession({
        run: vi.fn(() => makeHandle({ stdout: "out", stderr: "err", exitCode: 7 })),
      }),
    );

    const result = await sb.run("false");
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.combinedOutput).toBe("outerr");
  });

  it("wraps commands in a shell and forwards cwd + merged env", async () => {
    const run = vi.fn(() => makeHandle({ stdout: "ok" }));
    mocks.createAndWait.mockResolvedValue(makeSession({ run }));
    const sb = makeSandbox({ env: { BASE: "1" } });
    await sb.findOrProvision();

    await sb.run(["echo", "hello world"], { cwd: "/tmp", env: { EXTRA: "2" } });

    expect(run).toHaveBeenCalledWith(
      ["/bin/sh", "-lc", "'echo' 'hello world'"],
      { cwd: "/tmp", env: { BASE: "1", EXTRA: "2" } },
    );
  });

  it("enforces timeoutMs: rejects promptly and kills the process", async () => {
    const handle = makeHandle({ hang: true });
    const sb = await provisioned(makeSession({ run: vi.fn(() => handle) }));

    const start = Date.now();
    await expect(sb.run("sleep 60", { timeoutMs: 50 })).rejects.toThrow(
      /timed out after 50ms/,
    );
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(handle.kill).toHaveBeenCalled();
  });
});

describe("runAsync", () => {
  async function provisioned(session: ReturnType<typeof makeSession>) {
    mocks.createAndWait.mockResolvedValue(session);
    const sb = makeSandbox();
    await sb.findOrProvision();
    return sb;
  }

  it("streams stdout events and delivers the exit event", async () => {
    const sb = await provisioned(
      makeSession({ run: vi.fn(() => makeHandle({ stdout: "tick" })) }),
    );

    const handle = await sb.runAsync("emit");
    const chunks: string[] = [];
    let exitCode: number | undefined;
    for await (const event of handle) {
      if (event.type === "stdout" && event.chunk) chunks.push(event.chunk);
      if (event.type === "exit") exitCode = event.exitCode;
    }

    expect(chunks.join("")).toBe("tick");
    expect(exitCode).toBe(0);
    expect((await handle.wait()).exitCode).toBe(0);
  });

  it("forwards write() input to the process stdin", async () => {
    const raw = makeHandle({ stdout: "ok" });
    const sb = await provisioned(makeSession({ run: vi.fn(() => raw) }));

    const handle = await sb.runAsync("cat");
    await handle.write!("ping\n");

    expect(new TextDecoder().decode(raw._writes[0])).toBe("ping\n");
  });

  it("kill() settles wait() immediately with exit 137", async () => {
    const raw = makeHandle({ hang: true });
    const sb = await provisioned(makeSession({ run: vi.fn(() => raw) }));

    const handle = await sb.runAsync("sleep 120");
    const start = Date.now();
    await handle.kill();
    const result = await handle.wait();

    expect(Date.now() - start).toBeLessThan(1_000);
    expect(result.exitCode).toBe(137);
    expect(raw.kill).toHaveBeenCalled();
  });

  it("enforces timeoutMs: wait() rejects, iterator surfaces the error, process killed", async () => {
    const raw = makeHandle({ hang: true });
    const sb = await provisioned(makeSession({ run: vi.fn(() => raw) }));

    const handle = await sb.runAsync("sleep 60", { timeoutMs: 50 });
    await expect(handle.wait()).rejects.toThrow(/timed out after 50ms/);
    expect(raw.kill).toHaveBeenCalled();

    await expect(async () => {
      for await (const event of handle) void event;
    }).rejects.toThrow(/timed out/);
  });

  it("does not time out commands that finish in time", async () => {
    const raw = makeHandle({ stdout: "fast" });
    const sb = await provisioned(makeSession({ run: vi.fn(() => raw) }));

    const handle = await sb.runAsync("true", { timeoutMs: 5_000 });
    const result = await handle.wait();

    expect(result.exitCode).toBe(0);
    expect(raw.kill).not.toHaveBeenCalled();
  });
});

describe("files", () => {
  it("uses the data-plane API inside /home/tenki and resolves relative paths", async () => {
    const session = makeSession();
    mocks.createAndWait.mockResolvedValue(session);
    const sb = makeSandbox();
    await sb.findOrProvision();

    await sb.uploadFile("hello", "notes.txt");
    expect(session.writeFile).toHaveBeenCalledWith(
      "/home/tenki/notes.txt",
      enc.encode("hello"),
    );

    const body = await sb.downloadFile("notes.txt");
    expect(session.readFile).toHaveBeenCalledWith("/home/tenki/notes.txt");
    expect(body.toString("utf8")).toBe("file-body");
  });

  it("falls back to a shell pipe for paths outside /home/tenki", async () => {
    const run = vi.fn(() => makeHandle({ stdout: "shell-body" }));
    const session = makeSession({ run });
    mocks.createAndWait.mockResolvedValue(session);
    const sb = makeSandbox({ workingDir: "/workspace" });
    await sb.findOrProvision();
    run.mockClear();

    await sb.uploadFile("data", "artifact.bin");
    expect(session.writeFile).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      [
        "/bin/sh",
        "-c",
        "mkdir -p '/workspace' && cat > '/workspace/artifact.bin'",
      ],
      { stdin: expect.any(ReadableStream) },
    );

    const body = await sb.downloadFile("/workspace/artifact.bin");
    expect(session.readFile).not.toHaveBeenCalled();
    expect(body.toString("utf8")).toBe("shell-body");
  });
});

describe("preview links", () => {
  it("caches the URL and refreshes it after expiry", async () => {
    let exposes = 0;
    const session = makeSession({
      exposePort: vi.fn(async (port: number) => {
        exposes++;
        return {
          port,
          previewUrl: `https://p${exposes}.tenki.sh`,
          expiresAt: new Date(Date.now() + 5_100),
        };
      }),
    });
    mocks.createAndWait.mockResolvedValue(session);
    const sb = makeSandbox();
    await sb.findOrProvision();

    const first = await sb.getPreviewLink(3000);
    const second = await sb.getPreviewLink(3000);
    expect(first).toBe(second);
    expect(exposes).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 200));
    const third = await sb.getPreviewLink(3000);
    expect(third).not.toBe(first);
    expect(exposes).toBe(2);
  });

  it("keeps URLs without expiry cached", async () => {
    const session = makeSession();
    mocks.createAndWait.mockResolvedValue(session);
    const sb = makeSandbox();
    await sb.findOrProvision();

    await sb.openPort(3000);
    const url = await sb.getPreviewLink(3000);
    expect(url).toBe("https://preview.tenki.sh/3000");
    expect(session.exposePort).toHaveBeenCalledTimes(1);
  });
});
