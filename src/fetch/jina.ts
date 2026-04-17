/**
 * Jina Reader fallback for JS-rendered and blocked pages.
 *
 * Provenance: pi-web-access/extract.ts (lines 74-117)
 * Borrowed: Jina Reader URL construction (r.jina.ai/ prefix),
 * markdown content extraction, JS-rendering failure detection.
 *
 * Jina Reader handles JS rendering server-side, no API key needed.
 * Used as fallback when Readability fails or returns too little content.
 */

import type { FetchResult } from "./http.js";
import { combinedSignal } from "../util/signal.js";
import { fetchWithProxy } from "../util/proxy.js";
import { extractHeadingTitle } from "../util/markdown.js";

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30_000;

export async function extractWithJinaReader(
  url: string,
  signal?: AbortSignal,
  socksProxy?: string | null,
): Promise<FetchResult | null> {
  const jinaUrl = JINA_READER_BASE + url;

  try {
    const res = await fetchWithProxy(jinaUrl, {
      headers: {
        Accept: "text/markdown",
        "X-No-Cache": "true",
      },
      signal: combinedSignal(signal, JINA_TIMEOUT_MS),
    }, {
      socksProxy,
    });

    if (!res.ok) return null;

    const content = await res.text();

    // Jina returns metadata then "Markdown Content:" then the actual content
    const contentStart = content.indexOf("Markdown Content:");
    if (contentStart < 0) return null;

    const markdownPart = content.slice(contentStart + 17).trim();

    // Detect failed JS rendering or minimal content
    if (
      markdownPart.length < 100 ||
      markdownPart.startsWith("Loading...") ||
      markdownPart.startsWith("Please enable JavaScript")
    ) {
      return null;
    }

    const title = extractHeadingTitle(markdownPart) ?? new URL(url).pathname.split("/").pop() ?? url;
    return { url, title, content: markdownPart, error: null };
  } catch {
    return null;
  }
}


