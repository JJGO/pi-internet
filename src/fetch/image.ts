/**
 * Direct image URL handling: download to a local temp file so the model can
 * inspect it with the read tool.
 *
 * fetch_url returns the local path plus metadata instead of inline image
 * parts: read displays one image per call while fetch_url accepts up to five
 * URLs, so the model chooses which downloaded images to actually view.
 *
 * Only formats the read tool can display are downloaded (jpg/png/gif/webp/bmp).
 * Other image formats return a URL-only note instead of a file nobody can view.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { downloadResponseToFile } from "../util/download.js";
import type { FetchResult } from "./http.js";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

/** Formats the read tool can display, keyed by canonical MIME type. */
const READABLE_IMAGE_TYPES = new Map<string, string>([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/bmp", ".bmp"],
]);

export function readableImageExtension(mimeType: string): string | undefined {
  return READABLE_IMAGE_TYPES.get(normalizeImageMimeType(mimeType));
}

function normalizeImageMimeType(contentType: string): string {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

/** Derive a safe filename from the URL path, replacing the extension with the
 * one implied by the response content type. */
function imageFilename(url: string, extension: string): string {
  let stem = "image";
  try {
    const path = new URL(url).pathname;
    let name = basename(path);
    try {
      name = decodeURIComponent(name);
    } catch {
      // keep encoded form
    }
    const candidate = name.slice(0, name.length - extname(name).length);
    const sanitized = candidate.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
    if (sanitized) stem = sanitized.slice(0, 80);
  } catch {
    // keep default
  }
  return `${stem}${extension}`;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Best-effort dimension extraction from the leading bytes of an image file.
 * Returns undefined when the format marker is not found in the header window
 * (e.g. JPEG dimensions behind a very large EXIF block).
 */
export function parseImageDimensions(header: Uint8Array, mimeType: string): ImageDimensions | undefined {
  const view = Buffer.from(header.buffer, header.byteOffset, header.byteLength);
  try {
    switch (normalizeImageMimeType(mimeType)) {
      case "image/png":
        // IHDR is always the first chunk: width/height at offsets 16/20.
        if (view.length >= 24 && view.toString("latin1", 12, 16) === "IHDR") {
          return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
        }
        return undefined;
      case "image/gif":
        if (view.length >= 10) {
          return { width: view.readUInt16LE(6), height: view.readUInt16LE(8) };
        }
        return undefined;
      case "image/bmp":
        if (view.length >= 26 && view.toString("latin1", 0, 2) === "BM") {
          return { width: Math.abs(view.readInt32LE(18)), height: Math.abs(view.readInt32LE(22)) };
        }
        return undefined;
      case "image/jpeg":
        return parseJpegDimensions(view);
      case "image/webp":
        return parseWebpDimensions(view);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function parseJpegDimensions(view: Buffer): ImageDimensions | undefined {
  if (view.length < 4 || view.readUInt16BE(0) !== 0xffd8) return undefined;
  let offset = 2;
  while (offset + 9 < view.length) {
    if (view[offset] !== 0xff) return undefined;
    const marker = view[offset + 1];
    // SOF0-SOF15 excluding DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.readUInt16BE(offset + 5), width: view.readUInt16BE(offset + 7) };
    }
    offset += 2 + view.readUInt16BE(offset + 2);
  }
  return undefined;
}

function parseWebpDimensions(view: Buffer): ImageDimensions | undefined {
  if (view.length < 30 || view.toString("latin1", 0, 4) !== "RIFF" || view.toString("latin1", 8, 12) !== "WEBP") {
    return undefined;
  }
  const format = view.toString("latin1", 12, 16);
  if (format === "VP8 ") {
    return { width: view.readUInt16LE(26) & 0x3fff, height: view.readUInt16LE(28) & 0x3fff };
  }
  if (format === "VP8L") {
    const bits = view.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === "VP8X") {
    return {
      width: (view.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (view.readUIntLE(27, 3) & 0xffffff) + 1,
    };
  }
  return undefined;
}

export interface DownloadedImage {
  path: string;
  mimeType: string;
  bytes: number;
  dimensions?: ImageDimensions;
}

/**
 * Download an image response to a fresh temp directory.
 * Throws on size-limit or I/O failures; the caller decides how to surface them.
 */
export async function downloadImageToTemp(
  response: Response,
  url: string,
  options: { signal?: AbortSignal; maxBytes?: number; tempPrefix?: string } = {},
): Promise<DownloadedImage> {
  const contentType = response.headers.get("content-type") ?? "";
  const mimeType = normalizeImageMimeType(contentType);
  const extension = readableImageExtension(mimeType);
  if (!extension) {
    await response.body?.cancel();
    throw new Error(`Unsupported image format: ${mimeType || "unknown"}`);
  }

  const directory = await mkdtemp(join(tmpdir(), options.tempPrefix ?? "pi-internet-image-"));
  try {
    const path = join(directory, imageFilename(url, extension));
    // 128KB header window: enough for PNG/GIF/BMP/WebP markers and JPEG SOF
    // behind typical EXIF blocks.
    const download = await downloadResponseToFile(
      response,
      path,
      options.maxBytes ?? MAX_IMAGE_BYTES,
      options.signal,
      128 * 1024,
    );

    return {
      path,
      mimeType,
      bytes: download.bytes,
      dimensions: parseImageDimensions(download.header, mimeType),
    };
  } catch (error) {
    // Do not leak the directory or a partial file on size-cap/I/O failures.
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Shared response handling for HTTP and Redlib; consumes the existing response. */
export async function fetchImageResponse(response: Response, url: string, signal?: AbortSignal): Promise<FetchResult> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!readableImageExtension(contentType)) {
    await response.body?.cancel();
    return {
      url,
      title: "",
      content: `Image format ${contentType.split(";")[0]} cannot be displayed by the read tool (supported: jpg/png/gif/webp/bmp). Image URL: ${url}`,
      contentType: normalizeImageMimeType(contentType),
      error: null,
    };
  }
  try {
    const image = await downloadImageToTemp(response, url, { signal });
    return formatImageFetchResult(url, image);
  } catch (error) {
    return { url, title: "", content: "", error: error instanceof Error ? error.message : String(error) };
  }
}

export function formatImageFetchResult(url: string, image: DownloadedImage): FetchResult {
  const dims = image.dimensions ? `${image.dimensions.width}x${image.dimensions.height}` : "unknown";
  const content = [
    `Downloaded image to: ${image.path}`,
    "",
    `- Source URL: ${url}`,
    `- Type: ${image.mimeType}`,
    `- Size: ${formatBytes(image.bytes)}`,
    `- Dimensions: ${dims}`,
    "",
    "Use the read tool on the local path to view the image (one image per read call).",
  ].join("\n");

  return {
    url,
    title: basename(image.path),
    content,
    error: null,
    artifacts: { imageDownload: image.path },
    contentType: image.mimeType,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
