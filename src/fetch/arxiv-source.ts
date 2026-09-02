import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createReadStream as nodeCreateReadStream, createWriteStream as nodeCreateWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract as createTarExtractor, type Headers as TarHeader } from "tar-stream";
import type { FetchResult } from "./http.js";
import { downloadResponseToFile } from "../util/download.js";

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 250 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const ROOT_SCAN_BYTES = 64 * 1024;
const ROOT_PREVIEW_CHARS = 12_000;
const ROOT_PREVIEW_BYTES = ROOT_PREVIEW_CHARS * 4;
const TREE_PREVIEW_ENTRIES = 200;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

interface SourceFile {
  path: string;
  bytes: number;
  sha256: string;
}

interface SourceManifest {
  sourceUrl: string;
  mediaType: string;
  filename: string | null;
  downloadedBytes: number;
  sha256: string;
  format: "tar" | "gzip-tar" | "text" | "gzip-text" | "unknown";
  expandedBytes: number;
  files: SourceFile[];
  likelyRoots: string[];
  extractionError?: string;
}

export async function fetchAndExtractArxivSource(
  response: Response,
  sourceUrl: string,
  title: string,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const directory = await mkdtemp(join(tmpdir(), "pi-internet-arxiv-source-"));
  await chmod(directory, 0o700);
  const sourceDownload = join(directory, "source-download");
  const unpackedDirectory = join(directory, "unpacked");
  const manifestPath = join(directory, "manifest.json");
  await mkdir(unpackedDirectory, { mode: 0o700 });

  let download;
  try {
    download = await downloadResponseToFile(response, sourceDownload, MAX_SOURCE_BYTES, signal);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  const manifest: SourceManifest = {
    sourceUrl,
    mediaType: response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
    filename: contentDispositionFilename(response.headers.get("content-disposition")),
    downloadedBytes: download.bytes,
    sha256: download.sha256,
    format: "unknown",
    expandedBytes: 0,
    files: [],
    likelyRoots: [],
  };

  const expandedPath = join(directory, "expanded-source");
  try {
    const header = download.header;
    if (isGzip(header)) {
      await expandGzip(sourceDownload, expandedPath, signal);
      const expandedHeader = await readHeader(expandedPath);
      if (looksLikeTar(expandedHeader)) {
        manifest.format = "gzip-tar";
        await extractTar(expandedPath, unpackedDirectory, manifest, signal);
      } else if (await looksLikeText(expandedPath)) {
        manifest.format = "gzip-text";
        await storeSingleSource(expandedPath, unpackedDirectory, manifest);
      }
    } else if (looksLikeTar(header)) {
      manifest.format = "tar";
      await extractTar(sourceDownload, unpackedDirectory, manifest, signal);
    } else if (await looksLikeText(sourceDownload)) {
      manifest.format = "text";
      await storeSingleSource(sourceDownload, unpackedDirectory, manifest);
    }

    manifest.likelyRoots = await findLikelyRoots(unpackedDirectory, manifest.files);
  } catch (error) {
    manifest.extractionError = error instanceof Error ? error.message : String(error);
    manifest.files = [];
    manifest.expandedBytes = 0;
    manifest.likelyRoots = [];
    await rm(unpackedDirectory, { recursive: true, force: true });
    await mkdir(unpackedDirectory, { mode: 0o700 });
  } finally {
    await rm(expandedPath, { force: true });
  }

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });

  const content = await renderSourceSummary(manifest, unpackedDirectory);

  return {
    url: sourceUrl,
    title,
    content,
    error: manifest.extractionError ?? (manifest.format === "unknown" ? "Source payload format is unsupported; original payload was retained" : null),
    artifacts: {
      sourceDownload,
      sourceDirectory: unpackedDirectory,
      sourceManifest: manifestPath,
    },
  };
}

async function expandGzip(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        signal?.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > MAX_EXPANDED_BYTES) throw new Error("Expanded source exceeds the 250 MiB limit");
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  await pipeline(
    nodeCreateReadStream(inputPath),
    createGunzip(),
    limiter,
    nodeCreateWriteStream(outputPath, { mode: 0o600, flags: "wx" }),
  );
}

async function extractTar(
  archivePath: string,
  outputDirectory: string,
  manifest: SourceManifest,
  signal?: AbortSignal,
): Promise<void> {
  const extractor = createTarExtractor();
  const seen = new Set<string>();
  let entries = 0;
  let totalBytes = 0;

  extractor.on("entry", (header, stream, next) => {
    void handleTarEntry(header, stream, next);
  });

  async function handleTarEntry(
    header: TarHeader,
    stream: NodeJS.ReadableStream,
    next: (error?: unknown) => void,
  ): Promise<void> {
    try {
      signal?.throwIfAborted();
      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error(`Source archive exceeds ${MAX_ENTRIES} entries`);
      const relativePath = safeArchivePath(header.name);
      if (seen.has(relativePath)) throw new Error(`Source archive contains duplicate path: ${relativePath}`);
      seen.add(relativePath);

      if (header.type === "directory") {
        await mkdir(join(outputDirectory, relativePath), { recursive: true, mode: 0o700 });
        stream.resume();
        next();
        return;
      }
      if (header.type && header.type !== "file" && header.type !== "contiguous-file") {
        throw new Error(`Source archive contains unsupported ${header.type} entry: ${relativePath}`);
      }
      if ((header.size ?? 0) > MAX_FILE_BYTES) throw new Error(`Source file exceeds the 100 MiB limit: ${relativePath}`);

      const outputPath = join(outputDirectory, relativePath);
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
      const hash = createHash("sha256");
      let fileBytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          try {
            signal?.throwIfAborted();
            fileBytes += chunk.byteLength;
            totalBytes += chunk.byteLength;
            if (fileBytes > MAX_FILE_BYTES) throw new Error(`Source file exceeds the 100 MiB limit: ${relativePath}`);
            if (totalBytes > MAX_EXPANDED_BYTES) throw new Error("Expanded source exceeds the 250 MiB limit");
            hash.update(chunk);
            callback(null, chunk);
          } catch (error) {
            callback(error as Error);
          }
        },
      });
      await pipeline(
        stream,
        limiter,
        nodeCreateWriteStream(outputPath, { mode: 0o600, flags: "wx" }),
      );
      manifest.files.push({ path: relativePath, bytes: fileBytes, sha256: hash.digest("hex") });
      manifest.expandedBytes = totalBytes;
      next();
    } catch (error) {
      stream.resume();
      next(error);
    }
  }

  await pipeline(nodeCreateReadStream(archivePath), extractor);
}

async function storeSingleSource(
  inputPath: string,
  outputDirectory: string,
  manifest: SourceManifest,
): Promise<void> {
  const stat = await open(inputPath, "r").then(async (file) => {
    try {
      return await file.stat();
    } finally {
      await file.close();
    }
  });
  if (stat.size > MAX_FILE_BYTES) throw new Error("Source file exceeds the 100 MiB limit");
  const path = "source.tex";
  await copyFile(inputPath, join(outputDirectory, path));
  await chmod(join(outputDirectory, path), 0o600);
  const data = await readFile(join(outputDirectory, path));
  manifest.files.push({ path, bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") });
  manifest.expandedBytes = data.byteLength;
}

async function findLikelyRoots(outputDirectory: string, files: SourceFile[]): Promise<string[]> {
  const candidates: Array<{ path: string; score: number }> = [];
  for (const file of files) {
    if (!file.path.toLowerCase().endsWith(".tex")) continue;
    const handle = await open(join(outputDirectory, file.path), "r");
    try {
      const buffer = Buffer.alloc(Math.min(ROOT_SCAN_BYTES, file.bytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      let score = /\\documentclass(?:\[[^\]]*\])?\s*\{/.test(text) ? 100 : 0;
      if (/(^|\/)(main|paper|ms|article)\.tex$/i.test(file.path)) score += 20;
      score -= file.path.split("/").length;
      candidates.push({ path: file.path, score });
    } finally {
      await handle.close();
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).map((item) => item.path);
}

async function renderSourceSummary(manifest: SourceManifest, outputDirectory: string): Promise<string> {
  const lines = [
    "## Source manifest",
    "",
    `- Format: ${manifest.format}`,
    `- Downloaded: ${formatBytes(manifest.downloadedBytes)}`,
    `- Expanded: ${formatBytes(manifest.expandedBytes)}`,
    `- SHA-256: \`${manifest.sha256}\``,
    `- Files: ${manifest.files.length}`,
  ];
  if (manifest.extractionError) lines.push(`- Extraction error: ${manifest.extractionError}`);

  if (manifest.files.length > 0) {
    lines.push("", "## File tree", "");
    for (const file of manifest.files.slice(0, TREE_PREVIEW_ENTRIES)) {
      lines.push(`- ${file.path} (${formatBytes(file.bytes)})`);
    }
    if (manifest.files.length > TREE_PREVIEW_ENTRIES) {
      lines.push(`- … ${manifest.files.length - TREE_PREVIEW_ENTRIES} more files; see manifest.json`);
    }
  }

  const root = manifest.likelyRoots[0];
  if (root) {
    const rootFile = manifest.files.find((file) => file.path === root)!;
    const handle = await open(join(outputDirectory, root), "r");
    let preview: string;
    let bytesRead: number;
    try {
      const buffer = Buffer.alloc(Math.min(ROOT_PREVIEW_BYTES, rootFile.bytes));
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
      preview = buffer.subarray(0, bytesRead).toString("utf8").slice(0, ROOT_PREVIEW_CHARS);
    } finally {
      await handle.close();
    }
    lines.push(
      "",
      "## Likely root TeX file",
      "",
      `Path: ${join(outputDirectory, root)}`,
      "",
      "```tex",
      preview,
      "```",
    );
    if (rootFile.bytes > bytesRead || preview.length >= ROOT_PREVIEW_CHARS) {
      lines.push("", `Preview truncated at ${ROOT_PREVIEW_CHARS} characters.`);
    }
  }
  return lines.join("\n");
}

export function safeArchivePath(name: string): string {
  if (!name || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Source archive contains an invalid empty or control-character path");
  const portable = name.replace(/\\/g, "/");
  if (Buffer.byteLength(portable, "utf8") > 4096) throw new Error("Source archive path is too long");
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) {
    throw new Error(`Source archive contains absolute path: ${name}`);
  }
  const normalized = posix.normalize(portable).replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Source archive path escapes destination: ${name}`);
  }
  for (const segment of normalized.split("/")) {
    if (segment.includes(":")) throw new Error(`Source archive path contains a Windows alternate stream: ${name}`);
    if (/[ .]$/.test(segment)) throw new Error(`Source archive path has a Windows-ambiguous segment: ${name}`);
    if (WINDOWS_RESERVED_NAMES.test(segment)) throw new Error(`Source archive path uses a Windows device name: ${name}`);
  }
  return normalized;
}

function isGzip(header: Uint8Array): boolean {
  return header[0] === 0x1f && header[1] === 0x8b;
}

function looksLikeTar(header: Uint8Array): boolean {
  if (header.byteLength < 512) return false;
  const block = Buffer.from(header.subarray(0, 512));
  const stored = Number.parseInt(block.subarray(148, 156).toString("ascii").replace(/\0.*$/, "").trim(), 8);
  if (!Number.isFinite(stored)) return false;
  let sum = 0;
  for (let index = 0; index < block.length; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  return sum === stored;
}

async function looksLikeText(path: string): Promise<boolean> {
  const header = await readHeader(path, 8192);
  if (header.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(header);
    return true;
  } catch {
    return false;
  }
}

async function readHeader(path: string, bytes = 1024): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

function contentDispositionFilename(value: string | null): string | null {
  if (!value) return null;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  }
  return value.match(/filename="?([^";]+)"?/i)?.[1] ?? null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
