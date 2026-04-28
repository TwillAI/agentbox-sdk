/**
 * Tiny in-memory tarball builder used by `Sandbox.uploadAndRun`.
 *
 * Builds an uncompressed POSIX USTAR archive entirely in-memory, suitable
 * for piping through a sandbox's stdin to be extracted by `tar -x`. We
 * deliberately don't gzip on the host: setup tarballs are small (a few
 * KB) and the sandbox's `tar` may not always have gzip when the image is
 * stripped down, so plain tar keeps the contract simple.
 */

import tar from "tar-stream";

export interface TarballEntry {
  /** Absolute or relative path the file should be written to in the sandbox. */
  path: string;
  /** File contents. Strings are encoded as UTF-8. */
  content: string | Buffer;
  /** Optional file mode (default `0o644`). Pass `0o755` for executables. */
  mode?: number;
}

/**
 * Serialize the entries into an in-memory tar archive. Resolves with a
 * single `Buffer` ready to be written to a process stdin.
 */
export async function buildTarball(entries: TarballEntry[]): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  const finished = new Promise<void>((resolve, reject) => {
    pack.on("end", () => resolve());
    pack.on("error", (error: Error) => reject(error));
  });

  for (const entry of entries) {
    const content =
      typeof entry.content === "string"
        ? Buffer.from(entry.content, "utf8")
        : entry.content;
    pack.entry(
      {
        name: entry.path.replace(/^\/+/, ""),
        mode: entry.mode ?? 0o644,
        size: content.length,
        mtime: new Date(0),
        type: "file",
      },
      content,
    );
  }
  pack.finalize();

  await finished;
  return Buffer.concat(chunks);
}
