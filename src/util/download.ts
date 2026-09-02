import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export interface DownloadResult {
  bytes: number;
  header: Uint8Array;
  sha256: string;
}

export async function downloadResponseToFile(
  response: Response,
  outputPath: string,
  maxBytes: number,
  signal?: AbortSignal,
  headerBytes = 1024,
): Promise<DownloadResult> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response exceeds the ${formatMiB(maxBytes)} limit`);
  }
  if (!response.body) throw new Error("Response has no body");

  const reader = response.body.getReader();
  const file = await open(outputPath, "wx", 0o600);
  const hash = createHash("sha256");
  const headerChunks: Uint8Array[] = [];
  let headerLength = 0;
  let bytes = 0;

  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeds the ${formatMiB(maxBytes)} limit`);
      }

      bytes += value.byteLength;
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
        if (bytesWritten === 0) throw new Error("File write made no progress");
        offset += bytesWritten;
      }

      if (headerLength < headerBytes) {
        const part = value.subarray(0, headerBytes - headerLength);
        headerChunks.push(part);
        headerLength += part.byteLength;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    await file.close();
  }

  return {
    bytes,
    header: Buffer.concat(headerChunks.map((chunk) => Buffer.from(chunk))),
    sha256: hash.digest("hex"),
  };
}

export async function readResponseBuffer(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response exceeds the ${formatMiB(maxBytes)} limit`);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeds the ${formatMiB(maxBytes)} limit`);
      }
      bytes += value.byteLength;
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

export async function readResponseText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const buffer = await readResponseBuffer(response, maxBytes, signal);
  return new TextDecoder().decode(buffer);
}

export async function readResponseJson<T>(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<T> {
  return JSON.parse(await readResponseText(response, maxBytes, signal)) as T;
}

function formatMiB(bytes: number): string {
  return bytes < 1024 * 1024 ? `${bytes} B` : `${Math.round(bytes / 1024 / 1024)} MiB`;
}
