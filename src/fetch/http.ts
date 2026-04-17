/**
 * HTTP fetch pipeline: fetch() → content-type routing → Readability → fallbacks.
 *
 * Provenance:
 * - pi-web-access/extract.ts: Readability pipeline, isLikelyJSRendered heuristic,
 *   MIN_USEFUL_CONTENT threshold, fallback chain orchestration
 * - pi-fetch/extensions/fetch.ts: GitHub blob→raw rewrite
 * - pi-surf/extensions/index.ts: CSS selector extraction, maxLength cap
 */

import { Readability } from "@mozilla/readability";
import { parse as parseDom } from "../util/dom.js";
import { htmlToMarkdown, extractHeadingTitle, type MarkdownOptions } from "../util/markdown.js";
import { extractRSCContent } from "./rsc.js";
import { extractWithJinaReader } from "./jina.js";
import { extractPdfFromBuffer } from "./pdf.js";
import { combinedSignal } from "../util/signal.js";
import { fetchWithProxy } from "../util/proxy.js";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
} from "@mariozechner/pi-coding-agent";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB
const MIN_USEFUL_CONTENT = 500;

export interface FetchResult {
  url: string;
  title: string;
  content: string;
  error: string | null;
}

export interface HttpFetchOptions {
  timeoutMs?: number;
  selector?: string;
  includeLinks?: boolean;
  socksProxy?: string | null;
  signal?: AbortSignal;
}

/**
 * Rewrite GitHub blob URLs to raw.githubusercontent.com for direct file content.
 *
 * Provenance: pi-fetch/extensions/fetch.ts (rewriteGithubBlobUrlToRaw)
 */
export function rewriteGithubBlobToRaw(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return url;
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 5) return url;
    const [owner, repo, kind, ref, ...fileParts] = segments;
    if (kind !== "blob" && kind !== "raw") return url;
    if (!owner || !repo || !ref || fileParts.length === 0) return url;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${fileParts.join("/")}`;
  } catch {
    return url;
  }
}

/**
 * Detect if a page is likely JavaScript-rendered (SPA).
 *
 * Provenance: pi-web-access/extract.ts (isLikelyJSRendered)
 * Heuristic: body has <500 chars of text but >3 scripts → likely SPA.
 */
export function isLikelyJSRendered(html: string): boolean {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return false;
  const bodyHtml = bodyMatch[1];
  const textContent = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const scriptCount = (html.match(/<script/gi) || []).length;
  return textContent.length < 500 && scriptCount > 3;
}

export async function httpFetch(url: string, options: HttpFetchOptions = {}): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const mdOptions: MarkdownOptions = { includeLinks: options.includeLinks };

  // Rewrite GitHub blob URLs to raw for direct file access
  const fetchUrl = rewriteGithubBlobToRaw(url);

  const signal = combinedSignal(options.signal, timeoutMs);

  let response: Response;
  try {
    response = await fetchWithProxy(fetchUrl, {
      signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    }, {
      socksProxy: options.socksProxy,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("timeout")) {
      return { url, title: "", content: "", error: `Request timed out (${timeoutMs}ms)` };
    }
    return { url, title: "", content: "", error: msg };
  }

  if (!response.ok) {
    return { url, title: "", content: "", error: `HTTP ${response.status}: ${response.statusText}` };
  }

  // Check content-length before reading body
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
    return {
      url,
      title: "",
      content: "",
      error: `Response too large (${Math.round(parseInt(contentLength, 10) / 1024 / 1024)}MB)`,
    };
  }

  const contentType = response.headers.get("content-type") || "";

  // Binary content → skip
  // PDF detected by content-type (catches URLs without .pdf extension, e.g. arxiv)
  if (contentType.includes("application/pdf")) {
    const buffer = await response.arrayBuffer();
    return extractPdfFromBuffer(buffer, url);
  }

  if (
    contentType.includes("image/") ||
    contentType.includes("audio/") ||
    contentType.includes("video/") ||
    contentType.includes("application/zip") ||
    contentType.includes("application/octet-stream")
  ) {
    return { url, title: "", content: "", error: `Unsupported content type: ${contentType.split(";")[0]}` };
  }

  const text = await response.text();
  const isHTML =
    contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

  // Non-HTML: return text as-is
  if (!isHTML) {
    const title = extractHeadingTitle(text) ?? new URL(fetchUrl).pathname.split("/").pop() ?? url;
    return { url, title, content: text, error: null };
  }

  // HTML pipeline: Readability → RSC → Jina
  const result = extractWithReadability(text, fetchUrl, options.selector, mdOptions);
  if (result && result.content.length >= MIN_USEFUL_CONTENT) {
    return { url, ...result, error: null };
  }

  // RSC fallback for Next.js pages
  const rscResult = extractRSCContent(text);
  if (rscResult && rscResult.content.length >= MIN_USEFUL_CONTENT) {
    return { url, title: rscResult.title, content: rscResult.content, error: null };
  }

  // Jina Reader fallback for JS-rendered / blocked pages
  const jinaResult = await extractWithJinaReader(url, options.signal, options.socksProxy);
  if (jinaResult) {
    return jinaResult;
  }

  // Return whatever we got from Readability (even if short), with a warning
  if (result && result.content.length > 0) {
    const warning = isLikelyJSRendered(text)
      ? "Page appears to be JavaScript-rendered (content loads dynamically)"
      : "Extracted content appears incomplete";
    return { url, ...result, error: warning };
  }

  return {
    url,
    title: "",
    content: "",
    error: isLikelyJSRendered(text)
      ? "Page is JavaScript-rendered — content loads dynamically. Try web_search instead."
      : "Could not extract readable content from HTML",
  };
}

function extractWithReadability(
  html: string,
  url: string,
  selector: string | undefined,
  mdOptions: MarkdownOptions,
): { title: string; content: string } | null {
  const document = parseDom(html);

  // Apply CSS selector to narrow extraction
  if (selector) {
    const selected = document.querySelector(selector);
    if (selected) {
      (document as any).body.innerHTML = selected.outerHTML;
    }
  }

  const reader = new Readability(document as unknown as Document);
  const article = reader.parse();
  if (!article?.content) return null;

  const markdown = htmlToMarkdown(article.content, mdOptions);
  return { title: article.title || "", content: markdown };
}

/** Apply Pi's standard truncation. Returns text + whether it was truncated. */
export function applyTruncation(text: string): { text: string; truncated: boolean } {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) {
    return { text: truncation.content, truncated: false };
  }

  const notice = `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
  return { text: truncation.content + notice, truncated: true };
}
