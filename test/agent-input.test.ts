import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { UserContent } from "../src";
import {
  joinTextParts,
  mapToClaudeUserContent,
  mapToCodexPromptParts,
  mapToOpenCodeParts,
  normalizeUserInput,
  validateProviderUserInput,
} from "../src/agents/input";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("multimodal input helpers", () => {
  it("normalizes string input into a text part", () => {
    expect(normalizeUserInput("hello")).toEqual([
      { type: "text", text: "hello" },
    ]);
  });

  it("keeps multiple text parts in order", async () => {
    const input: UserContent = [
      { type: "text", text: "hello" },
      { type: "text", text: " world" },
    ];
    const parts = await validateProviderUserInput("codex", input);

    expect(joinTextParts(parts)).toBe("hello world");
  });

  it("maps OpenCode image and file parts to multipart payloads", async () => {
    const parts = await validateProviderUserInput("opencode", [
      { type: "text", text: "Inspect these assets." },
      {
        type: "image",
        image: new URL("https://example.com/mockup.png"),
      },
      {
        type: "file",
        data: Buffer.from("release notes"),
        mediaType: "text/plain",
        filename: "notes.txt",
      },
    ]);

    expect(mapToOpenCodeParts(parts)).toEqual([
      { type: "text", text: "Inspect these assets." },
      {
        type: "file",
        url: "https://example.com/mockup.png",
        mime: "image/png",
      },
      {
        type: "file",
        url: "data:text/plain;base64,cmVsZWFzZSBub3Rlcw==",
        mime: "text/plain",
        filename: "notes.txt",
      },
    ]);
  });

  it("maps Claude image and text file parts to content blocks", async () => {
    const parts = await validateProviderUserInput("claude-code", [
      { type: "text", text: "Summarize the attached materials." },
      {
        type: "image",
        image: Buffer.from([1, 2, 3]),
        mediaType: "image/png",
      },
      {
        type: "file",
        data: Buffer.from("hello from the text file"),
        mediaType: "text/plain",
        filename: "notes.txt",
      },
    ]);

    expect(mapToClaudeUserContent(parts)).toEqual([
      { type: "text", text: "Summarize the attached materials." },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "AQID",
        },
      },
      {
        type: "document",
        source: {
          type: "text",
          media_type: "text/plain",
          data: "hello from the text file",
        },
      },
    ]);
  });

  it("reads file URLs and infers common image media types", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentbox-input-"));
    tempDirs.push(tempDir);
    const imagePath = path.join(tempDir, "diagram.png");
    await fs.writeFile(imagePath, Buffer.from([1, 2, 3]));

    const parts = await validateProviderUserInput("opencode", [
      { type: "image", image: pathToFileURL(imagePath) },
    ]);

    const mapped = mapToOpenCodeParts(parts);
    expect(mapped).toEqual([
      {
        type: "file",
        url: "data:image/png;base64,AQID",
        mime: "image/png",
      },
    ]);
  });

  it("maps Codex remote and local images to app-server prompt parts", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentbox-codex-input-"),
    );
    tempDirs.push(tempDir);
    const imagePath = path.join(tempDir, "diagram.png");
    await fs.writeFile(imagePath, Buffer.from([1, 2, 3]));

    const parts = await validateProviderUserInput("codex", [
      {
        type: "image",
        image: new URL("https://example.com/mockup.png"),
      },
      {
        type: "image",
        image: pathToFileURL(imagePath),
      },
    ]);

    expect(
      await mapToCodexPromptParts(parts, async (_part, index) => {
        return `/tmp/materialized-${index}.png`;
      }),
    ).toEqual([
      {
        type: "image",
        url: "https://example.com/mockup.png",
      },
      {
        type: "localImage",
        path: "/tmp/materialized-1.png",
      },
    ]);
  });

  it("rejects Codex generic file parts", async () => {
    await expect(
      validateProviderUserInput("codex", [
        {
          type: "file",
          data: Buffer.from("release notes"),
          mediaType: "text/plain",
          filename: "notes.txt",
        },
      ]),
    ).rejects.toThrow(
      /codex provider does not yet support "file" input parts/i,
    );
  });

  it("rejects Claude binary file media types that are not PDFs", async () => {
    await expect(
      validateProviderUserInput("claude-code", [
        {
          type: "file",
          data: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
          mediaType: "application/octet-stream",
          filename: "archive.bin",
        },
      ]),
    ).rejects.toThrow(/only supports PDF and text-like file inputs/i);
  });
});
