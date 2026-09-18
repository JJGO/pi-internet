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
import { readResponseText } from "../util/download.js";
import { validateUserUrl, type UserUrlPolicy } from "../util/safe-fetch.js";

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30_000;
const MAX_JINA_RESPONSE_BYTES = 5 * 1024 * 1024;

export async function extractWithJinaReader(
  url: string,
  signal?: AbortSignal,
  socksProxy?: string | null,
  policy: UserUrlPolicy = {},
): Promise<FetchResult | null> {
  const jinaUrl = JINA_READER_BASE + url;

  try {
    await validateUserUrl(url, policy);
    const requestSignal = combinedSignal(signal, JINA_TIMEOUT_MS);
    const res = await fetchWithProxy(jinaUrl, {
      headers: {
        Accept: "text/markdown",
        "X-No-Cache": "true",
      },
      signal: requestSignal,
      redirect: "error",
    }, {
      socksProxy,
    });

    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }

    const content = await readResponseText(res, MAX_JINA_RESPONSE_BYTES, requestSignal);
    const parsed = parseJinaResponse(content);
    if (!parsed) return null;

    const title = parsed.title
      ?? extractHeadingTitle(parsed.content)
      ?? new URL(url).pathname.split("/").pop()
      ?? url;
    return { url, title, content: parsed.content, error: null };
  } catch {
    return null;
  }
}

/**
 * Parse a Jina Reader text/markdown response: a metadata header (Title:, URL Source:, ...)
 * followed by "Markdown Content:" and the extracted markdown.
 * Returns null when the response is malformed or the content looks like failed JS rendering.
 */
export function parseJinaResponse(response: string): { title: string | null; content: string } | null {
  const contentStart = response.indexOf("Markdown Content:");
  if (contentStart < 0) return null;

  const content = response.slice(contentStart + 17).trim();

  // Detect failed JS rendering or minimal content
  if (
    content.length < 100 ||
    content.startsWith("Loading...") ||
    content.startsWith("Please enable JavaScript")
  ) {
    return null;
  }

  const titleMatch = response.slice(0, contentStart).match(/^Title:[ \t]*(.+)$/m);
  const title = titleMatch?.[1].trim() || null;
  return { title, content };
}


