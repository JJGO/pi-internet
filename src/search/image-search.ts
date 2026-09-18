/**
 * Image search orchestration: run the Kagi provider, download thumbnails to
 * one per-call temp directory, and format results for the model.
 *
 * Thumbnails land on disk (not in context) so the model can inspect chosen
 * candidates with the read tool and fetch the full-resolution URL only when
 * needed. Individual thumbnail failures degrade to URL-only rows.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadResponseToFile } from "../util/download.js";
import { fetchWithProxy } from "../util/proxy.js";
import { MAX_IMAGE_BYTES, readableImageExtension } from "../fetch/image.js";
import { searchKagiImages, type KagiImageResult } from "./providers/kagi-images.js";

const THUMBNAIL_TIMEOUT_MS = 15_000;

export interface ImageSearchResultRow extends KagiImageResult {
  /** Local path of the downloaded thumbnail, when the download succeeded. */
  thumbnailPath?: string;
}

export interface ImageSearchOutcome {
  results: ImageSearchResultRow[];
  provider: string;
  /** Temp directory holding the downloaded thumbnails (absent if none). */
  thumbnailDir?: string;
  downloadedCount: number;
}

export interface RunImageSearchOptions {
  query: string;
  numResults: number;
  signal?: AbortSignal;
  socksProxy?: string | null;
}

export async function runImageSearch(options: RunImageSearchOptions): Promise<ImageSearchOutcome> {
  const results = await searchKagiImages(options);
  const { rows, thumbnailDir, downloadedCount } = await downloadThumbnails(results, options);
  return { results: rows, provider: "kagi", thumbnailDir, downloadedCount };
}

async function downloadThumbnails(
  results: KagiImageResult[],
  options: Pick<RunImageSearchOptions, "signal" | "socksProxy">,
): Promise<{ rows: ImageSearchResultRow[]; thumbnailDir?: string; downloadedCount: number }> {
  if (!results.some((result) => result.thumbnailUrl)) {
    return { rows: results, downloadedCount: 0 };
  }

  const thumbnailDir = await mkdtemp(join(tmpdir(), "pi-internet-images-"));
  const rows = await Promise.all(
    results.map(async (result, index): Promise<ImageSearchResultRow> => {
      if (!result.thumbnailUrl) return result;
      const thumbnailPath = await downloadThumbnail(result.thumbnailUrl, thumbnailDir, index + 1, options);
      return thumbnailPath ? { ...result, thumbnailPath } : result;
    }),
  );

  const downloadedCount = rows.filter((row) => row.thumbnailPath).length;
  if (downloadedCount === 0) {
    await rm(thumbnailDir, { recursive: true, force: true }).catch(() => {});
    return { rows, downloadedCount };
  }
  return { rows, thumbnailDir, downloadedCount };
}

/** Download one thumbnail; returns undefined on any failure. */
async function downloadThumbnail(
  url: string,
  directory: string,
  index: number,
  options: Pick<RunImageSearchOptions, "signal" | "socksProxy">,
): Promise<string | undefined> {
  try {
    const timeout = AbortSignal.timeout(THUMBNAIL_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await fetchWithProxy(url, { signal }, { socksProxy: options.socksProxy });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const extension = readableImageExtension(response.headers.get("content-type") ?? "");
    if (!extension) {
      await response.body?.cancel();
      return undefined;
    }
    const path = join(directory, `image-${index}${extension}`);
    await downloadResponseToFile(response, path, MAX_IMAGE_BYTES, signal);
    return path;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return undefined;
  }
}

export function formatImageResults(outcome: ImageSearchOutcome): string {
  const lines: string[] = [];

  if (outcome.downloadedCount > 0 && outcome.thumbnailDir) {
    lines.push(
      `Downloaded ${outcome.downloadedCount} thumbnail(s) to ${outcome.thumbnailDir}. ` +
        "Use the read tool on a thumbnail path to view it (one image per read call); " +
        "fetch the full-resolution URL with fetch_url when a candidate looks right.",
    );
    lines.push("");
  }

  outcome.results.forEach((result, index) => {
    const dims = result.width && result.height ? `${result.width}x${result.height}` : "unknown size";
    const meta: string[] = [dims];
    if (result.published) meta.push(result.published);
    lines.push(`## ${index + 1}. ${result.title} (${meta.join(", ")})`);
    lines.push(`- Page: ${result.pageUrl}`);
    lines.push(`- Full image: ${result.imageUrl}`);
    if (result.thumbnailPath) {
      lines.push(`- Thumbnail: ${result.thumbnailPath}`);
    } else if (result.thumbnailUrl) {
      lines.push(`- Thumbnail (not downloaded): ${result.thumbnailUrl}`);
    }
    lines.push("");
  });

  return lines.join("\n").trimEnd();
}
