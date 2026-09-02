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
import { extractWithDefuddle } from "./defuddle.js";
import { extractWithJinaReader } from "./jina.js";
import {
  downloadAndExtractPdf,
  finalizePdfResult,
  renderGenericPdfPreamble,
} from "./pdf.js";
import { readResponseText } from "../util/download.js";
import { fetchWithTransientRetry } from "../util/retry-fetch.js";
import { combinedSignal } from "../util/signal.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB
const MIN_USEFUL_CONTENT = 500;

export interface FetchArtifacts {
  pdf?: string;
  markdown?: string;
  sourceDownload?: string;
  sourceDirectory?: string;
  sourceManifest?: string;
}

export interface FetchResult {
  url: string;
  title: string;
  content: string;
  error: string | null;
  images?: Array<{ data: string; mimeType: string }>;
  fullOutputPath?: string;
  artifacts?: FetchArtifacts;
}

export interface HttpFetchOptions {
  timeoutMs?: number;
  selector?: string;
  includeLinks?: boolean;
  socksProxy?: string | null;
  signal?: AbortSignal;
  retryTransient?: boolean;
}

/**
 * Rewrite GitHub blob URLs to raw.githubusercontent.com for direct file content.
 *
 * Provenance: pi-fetch/extensions/fetch.ts (rewriteGithubBlobUrlToRaw)
 */
function isPdfPath(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

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
  const signal = combinedSignal(options.signal, timeoutMs);

  // Rewrite GitHub blob URLs to raw for direct file access
  const fetchUrl = rewriteGithubBlobToRaw(url);

  let response: Response;
  try {
    response = await fetchWithTransientRetry(fetchUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/pdf,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    }, {
      timeoutMs,
      signal,
      socksProxy: options.socksProxy,
      retries: options.retryTransient ? 1 : 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("timeout")) {
      return { url, title: "", content: "", error: `Request timed out (${timeoutMs}ms)` };
    }
    return { url, title: "", content: "", error: msg };
  }

  if (!response.ok) {
    await response.body?.cancel();
    return { url, title: "", content: "", error: `HTTP ${response.status}: ${response.statusText}` };
  }

  const contentType = response.headers.get("content-type") || "";
  const normalizedContentType = contentType.toLowerCase();
  const pdfCandidate = normalizedContentType.includes("pdf")
    || normalizedContentType.includes("application/octet-stream")
    || isPdfPath(fetchUrl);

  if (pdfCandidate) {
    try {
      const extraction = await downloadAndExtractPdf(response, url, signal);
      return await finalizePdfResult(extraction, renderGenericPdfPreamble(extraction));
    } catch (error) {
      return { url, title: "", content: "", error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (
    contentType.includes("image/") ||
    contentType.includes("audio/") ||
    contentType.includes("video/") ||
    contentType.includes("application/zip")
  ) {
    return { url, title: "", content: "", error: `Unsupported content type: ${contentType.split(";")[0]}` };
  }

  let text: string;
  try {
    text = await readResponseText(response, MAX_RESPONSE_BYTES, signal);
  } catch (error) {
    return { url, title: "", content: "", error: error instanceof Error ? error.message : String(error) };
  }
  const isHTML =
    contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

  // Non-HTML: return text as-is
  if (!isHTML) {
    const title = extractHeadingTitle(text) ?? new URL(fetchUrl).pathname.split("/").pop() ?? url;
    return { url, title, content: text, error: null };
  }

  // HTML pipeline: Readability → RSC → Defuddle → Jina
  const result = extractWithReadability(text, fetchUrl, options.selector, mdOptions);
  if (result && result.content.length >= MIN_USEFUL_CONTENT) {
    return { url, ...result, error: null };
  }

  // RSC fallback for Next.js pages
  const rscResult = extractRSCContent(text);
  if (rscResult && rscResult.content.length >= MIN_USEFUL_CONTENT) {
    return { url, title: rscResult.title, content: rscResult.content, error: null };
  }

  // Defuddle fallback stays local and uses the existing Markdown output policy.
  const defuddleResult = await extractWithDefuddle(
    text,
    response.url || fetchUrl,
    options.selector,
    mdOptions,
    signal,
  );
  if (signal.aborted) {
    return { url, title: "", content: "", error: `Request timed out (${timeoutMs}ms)` };
  }
  if (defuddleResult && defuddleResult.content.length >= MIN_USEFUL_CONTENT) {
    return { url, title: result?.title || defuddleResult.title, content: defuddleResult.content, error: null };
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
