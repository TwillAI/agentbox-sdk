export async function readStreamAsText(
  stream: ReadableStream<string> | ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      result +=
        typeof value === "string"
          ? value
          : decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  result += decoder.decode();
  return result;
}

export async function readStreamAsBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

export async function pipeReadableStream(
  stream: ReadableStream<string> | ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      onChunk(
        typeof value === "string"
          ? value
          : decoder.decode(value, { stream: true }),
      );
    }
  } finally {
    reader.releaseLock();
  }

  const finalChunk = decoder.decode();
  if (finalChunk) {
    onChunk(finalChunk);
  }
}

export async function readNodeStream(
  stream: NodeJS.ReadableStream,
): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export async function* linesFromTextChunks(
  chunks: AsyncIterable<string>,
): AsyncIterable<string> {
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trimEnd();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        yield line;
      }
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    yield trailing;
  }
}
