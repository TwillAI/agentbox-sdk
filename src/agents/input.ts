import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OpenAgentError } from "../shared/errors";
import type {
  AgentProviderName,
  DataContent,
  FilePart,
  ImagePart,
  TextPart,
  UserContent,
  UserContentPart,
} from "./types";

type BinarySource =
  | {
      type: "base64";
      data: string;
    }
  | {
      type: "url";
      url: string;
    };

export type ResolvedTextPart = TextPart;

export interface ResolvedImagePart {
  type: "image";
  mediaType: string;
  source: BinarySource;
}

export interface ResolvedFilePart {
  type: "file";
  mediaType: string;
  filename?: string;
  source: BinarySource;
}

export type ResolvedUserContentPart =
  | ResolvedTextPart
  | ResolvedImagePart
  | ResolvedFilePart;

export type OpenCodePromptPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "file";
      url: string;
      mime: string;
      filename?: string;
    };

export type CodexPromptPart =
  | {
      type: "image";
      url: string;
    }
  | {
      type: "localImage";
      path: string;
    };

const IMAGE_MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const FILE_MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  ...IMAGE_MEDIA_TYPE_BY_EXTENSION,
  ".csv": "text/csv",
  ".htm": "text/html",
  ".html": "text/html",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

const CLAUDE_IMAGE_MEDIA_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const CLAUDE_TEXT_LIKE_MEDIA_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/xml",
]);

export function normalizeUserInput(input: UserContent): UserContentPart[] {
  return typeof input === "string" ? [{ type: "text", text: input }] : input;
}

export async function resolveUserInputParts(
  input: UserContent,
): Promise<ResolvedUserContentPart[]> {
  const parts = normalizeUserInput(input);
  return Promise.all(parts.map((part) => resolveUserInputPart(part)));
}

export async function validateProviderUserInput(
  provider: AgentProviderName,
  input: UserContent,
): Promise<ResolvedUserContentPart[]> {
  const parts = await resolveUserInputParts(input);

  if (provider === "codex") {
    const unsupportedPart = parts.find((part) => part.type === "file");
    if (unsupportedPart) {
      throw new OpenAgentError(
        `The codex provider does not yet support "${unsupportedPart.type}" input parts through codex app-server. Codex currently supports text and image input items.`,
        {
          code: "UNSUPPORTED_INPUT_PART",
          details: {
            provider,
            partType: unsupportedPart.type,
          },
        },
      );
    }

    return parts;
  }

  if (provider === "claude-code") {
    for (const part of parts) {
      if (part.type === "image") {
        if (!CLAUDE_IMAGE_MEDIA_TYPES.has(part.mediaType)) {
          throw new OpenAgentError(
            `Claude Code only supports image inputs with one of these media types: ${Array.from(CLAUDE_IMAGE_MEDIA_TYPES).join(", ")}.`,
            {
              code: "UNSUPPORTED_INPUT_MEDIA_TYPE",
              details: {
                provider,
                partType: part.type,
                mediaType: part.mediaType,
              },
            },
          );
        }
      }

      if (part.type === "file") {
        if (
          part.mediaType !== "application/pdf" &&
          !isClaudeTextLikeMediaType(part.mediaType)
        ) {
          throw new OpenAgentError(
            `Claude Code only supports PDF and text-like file inputs. Received "${part.mediaType}".`,
            {
              code: "UNSUPPORTED_INPUT_MEDIA_TYPE",
              details: {
                provider,
                partType: part.type,
                mediaType: part.mediaType,
              },
            },
          );
        }

        if (
          part.source.type === "url" &&
          part.mediaType !== "application/pdf" &&
          isClaudeTextLikeMediaType(part.mediaType)
        ) {
          throw new OpenAgentError(
            "Claude Code text-like file inputs must be provided as inline data, not a remote URL.",
            {
              code: "UNSUPPORTED_INPUT_SOURCE",
              details: {
                provider,
                partType: part.type,
                mediaType: part.mediaType,
                sourceType: part.source.type,
              },
            },
          );
        }
      }
    }
  }

  return parts;
}

export function mapToOpenCodeParts(
  parts: ResolvedUserContentPart[],
): OpenCodePromptPart[] {
  return parts.map((part) => {
    if (part.type === "text") {
      return {
        type: "text",
        text: part.text,
      };
    }

    return {
      type: "file",
      url: binarySourceToUrl(part.source, part.mediaType),
      mime: part.mediaType,
      ...(part.type === "file" && part.filename
        ? { filename: part.filename }
        : {}),
    };
  });
}

export function mapToClaudeUserContent(
  parts: ResolvedUserContentPart[],
): string | Array<Record<string, unknown>> {
  if (parts.every((part) => part.type === "text")) {
    return joinTextParts(parts);
  }

  return parts.map((part) => {
    if (part.type === "text") {
      return {
        type: "text",
        text: part.text,
      };
    }

    if (part.type === "image") {
      if (part.source.type === "url" && isRemoteUrl(part.source.url)) {
        return {
          type: "image",
          source: {
            type: "url",
            url: part.source.url,
          },
        };
      }

      return {
        type: "image",
        source: {
          type: "base64",
          media_type: part.mediaType,
          data:
            part.source.type === "base64"
              ? part.source.data
              : dataUrlToBase64(part.source.url),
        },
      };
    }

    if (part.mediaType === "application/pdf") {
      if (part.source.type === "url" && isRemoteUrl(part.source.url)) {
        return {
          type: "document",
          source: {
            type: "url",
            url: part.source.url,
          },
        };
      }

      return {
        type: "document",
        source: {
          type: "base64",
          media_type: part.mediaType,
          data:
            part.source.type === "base64"
              ? part.source.data
              : dataUrlToBase64(part.source.url),
        },
      };
    }

    if (!isClaudeTextLikeMediaType(part.mediaType)) {
      throw new OpenAgentError(
        `Claude Code cannot map file inputs with media type "${part.mediaType}".`,
        {
          code: "UNSUPPORTED_INPUT_MEDIA_TYPE",
          details: {
            partType: part.type,
            mediaType: part.mediaType,
          },
        },
      );
    }

    return {
      type: "document",
      source: {
        type: "text",
        media_type: "text/plain",
        data: Buffer.from(
          part.source.type === "base64"
            ? part.source.data
            : dataUrlToBase64(part.source.url),
          "base64",
        ).toString("utf8"),
      },
    };
  });
}

export async function mapToCodexPromptParts(
  parts: ResolvedUserContentPart[],
  materializeLocalImage: (
    part: ResolvedImagePart,
    index: number,
  ) => Promise<string>,
): Promise<CodexPromptPart[]> {
  const mapped: CodexPromptPart[] = [];

  for (const [index, part] of parts.entries()) {
    if (part.type !== "image") {
      continue;
    }

    if (part.source.type === "url" && isRemoteUrl(part.source.url)) {
      mapped.push({
        type: "image",
        url: part.source.url,
      });
      continue;
    }

    mapped.push({
      type: "localImage",
      path: await materializeLocalImage(part, index),
    });
  }

  return mapped;
}

export function joinTextParts(
  parts: Array<TextPart | ResolvedUserContentPart>,
): string {
  return parts
    .map((part) => {
      if (part.type !== "text") {
        throw new OpenAgentError(
          `Cannot join "${part.type}" input parts into a text-only prompt.`,
          {
            code: "UNSUPPORTED_INPUT_PART",
            details: {
              partType: part.type,
            },
          },
        );
      }

      return part.text;
    })
    .join("");
}

async function resolveUserInputPart(
  part: UserContentPart,
): Promise<ResolvedUserContentPart> {
  if (part.type === "text") {
    return part;
  }

  if (part.type === "image") {
    const resolved = await resolveBinaryContent(part.image, {
      kind: "image",
      mediaType: part.mediaType,
    });

    return {
      type: "image",
      mediaType: resolved.mediaType,
      source: resolved.source,
    };
  }

  const resolved = await resolveBinaryContent(part.data, {
    kind: "file",
    mediaType: part.mediaType,
    filename: part.filename,
  });

  return {
    type: "file",
    mediaType: resolved.mediaType,
    filename: resolved.filename,
    source: resolved.source,
  };
}

async function resolveBinaryContent(
  content: DataContent,
  options: {
    kind: ImagePart["type"] | FilePart["type"];
    mediaType?: string;
    filename?: string;
  },
): Promise<{ mediaType: string; filename?: string; source: BinarySource }> {
  if (content instanceof URL) {
    return resolveUrlContent(content, options);
  }

  if (typeof content === "string") {
    const url = parseStructuredUrl(content);
    if (url) {
      return resolveUrlContent(url, options);
    }

    const mediaType = resolveMediaType("", options);
    return {
      mediaType,
      filename: options.filename,
      source: {
        type: "base64",
        data: content,
      },
    };
  }

  if (Buffer.isBuffer(content)) {
    return {
      mediaType: resolveMediaType("", options),
      filename: options.filename,
      source: {
        type: "base64",
        data: content.toString("base64"),
      },
    };
  }

  if (content instanceof Uint8Array) {
    return {
      mediaType: resolveMediaType("", options),
      filename: options.filename,
      source: {
        type: "base64",
        data: Buffer.from(content).toString("base64"),
      },
    };
  }

  if (content instanceof ArrayBuffer) {
    return {
      mediaType: resolveMediaType("", options),
      filename: options.filename,
      source: {
        type: "base64",
        data: Buffer.from(content).toString("base64"),
      },
    };
  }

  throw new OpenAgentError("Unsupported input content type.", {
    code: "UNSUPPORTED_INPUT_SOURCE",
    details: {
      kind: options.kind,
      valueType: typeof content,
    },
  });
}

async function resolveUrlContent(
  url: URL,
  options: {
    kind: ImagePart["type"] | FilePart["type"];
    mediaType?: string;
    filename?: string;
  },
): Promise<{ mediaType: string; filename?: string; source: BinarySource }> {
  if (url.protocol === "data:") {
    const parsed = parseDataUrl(url.toString());
    return {
      mediaType: resolveMediaType("", options, parsed.mediaType),
      filename: options.filename,
      source: {
        type: "base64",
        data: parsed.base64Data,
      },
    };
  }

  if (url.protocol === "file:") {
    const filePath = fileURLToPath(url);
    const buffer = await readFile(filePath);
    return {
      mediaType: resolveMediaType(filePath, options),
      filename: options.filename ?? path.basename(filePath),
      source: {
        type: "base64",
        data: buffer.toString("base64"),
      },
    };
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    return {
      mediaType: resolveMediaType(url.pathname, options),
      filename: options.filename ?? inferFilename(url.pathname),
      source: {
        type: "url",
        url: url.toString(),
      },
    };
  }

  throw new OpenAgentError(
    `Unsupported input URL protocol "${url.protocol}" for ${options.kind} parts.`,
    {
      code: "UNSUPPORTED_INPUT_SOURCE",
      details: {
        kind: options.kind,
        protocol: url.protocol,
      },
    },
  );
}

function resolveMediaType(
  pathname: string,
  options: {
    kind: ImagePart["type"] | FilePart["type"];
    mediaType?: string;
  },
  parsedMediaType?: string,
): string {
  const explicitMediaType = options.mediaType ?? parsedMediaType;
  if (explicitMediaType) {
    return explicitMediaType;
  }

  const inferredMediaType = inferMediaType(pathname);
  if (inferredMediaType) {
    return inferredMediaType;
  }

  throw new OpenAgentError(
    `Could not determine a media type for the ${options.kind} input part.`,
    {
      code: "MISSING_INPUT_MEDIA_TYPE",
      details: {
        kind: options.kind,
        pathname,
      },
    },
  );
}

function inferMediaType(pathname: string): string | undefined {
  const extension = path.extname(pathname).toLowerCase();
  return FILE_MEDIA_TYPE_BY_EXTENSION[extension];
}

function inferFilename(pathname: string): string | undefined {
  const name = path.basename(pathname);
  return name && name !== "." ? name : undefined;
}

function parseStructuredUrl(value: string): URL | null {
  if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value)) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function parseDataUrl(value: string): {
  mediaType?: string;
  base64Data: string;
} {
  const separatorIndex = value.indexOf(",");
  if (separatorIndex === -1) {
    throw new OpenAgentError("Invalid data URL input.", {
      code: "INVALID_INPUT_DATA_URL",
    });
  }

  const header = value.slice(5, separatorIndex);
  const body = value.slice(separatorIndex + 1);
  const mediaType = header.split(";")[0] || undefined;
  const isBase64 = header.includes(";base64");

  return {
    mediaType,
    base64Data: isBase64
      ? body
      : Buffer.from(decodeURIComponent(body), "utf8").toString("base64"),
  };
}

function binarySourceToUrl(source: BinarySource, mediaType: string): string {
  return source.type === "url"
    ? source.url
    : `data:${mediaType};base64,${source.data}`;
}

function dataUrlToBase64(value: string): string {
  return parseDataUrl(value).base64Data;
}

function isRemoteUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function isClaudeTextLikeMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") || CLAUDE_TEXT_LIKE_MEDIA_TYPES.has(mediaType)
  );
}
