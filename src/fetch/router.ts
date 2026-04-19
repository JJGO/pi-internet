/**
 * URL classification and dispatch to specialized handlers.
 *
 * Provenance: pi-web-access/extract.ts (URL classification order, fallback orchestration).
 *
 * Routing order:
 * 1. Reddit → Redlib proxy parser
 * 2. Twitter/X → Nitter proxy parser
 * 3. GitHub → clone locally
 * 4. YouTube → yt-dlp transcript
 * 5. PDF → text extraction
 * 6. HTTP → Readability → RSC → Jina fallback chain
 */

import type { PiInternetConfig } from "../config.js";
import { httpFetch, applyTruncation, type FetchResult, type HttpFetchOptions } from "./http.js";

// Lazy imports for specialized handlers (loaded on first use)
let githubModule: typeof import("./github.js") | null = null;
let youtubeModule: typeof import("./youtube.js") | null = null;
let pdfModule: typeof import("./pdf.js") | null = null;
let redditModule: typeof import("./reddit.js") | null = null;
let twitterModule: typeof import("./twitter.js") | null = null;

// ── URL classifiers ────────────────────────────────────────────

const REDDIT_HOSTS = new Set([
  "reddit.com", "www.reddit.com", "old.reddit.com", "np.reddit.com",
]);

const TWITTER_HOSTS = new Set([
  "twitter.com", "www.twitter.com", "mobile.twitter.com", "x.com", "www.x.com",
]);

function getHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isRedditUrl(url: string): boolean {
  const host = getHost(url);
  return host !== null && REDDIT_HOSTS.has(host);
}

function isTwitterUrl(url: string): boolean {
  const host = getHost(url);
  return host !== null && TWITTER_HOSTS.has(host);
}

function isGitHubUrl(url: string): boolean {
  const host = getHost(url);
  return host === "github.com" || host === "www.github.com";
}

function isYouTubeUrl(url: string): boolean {
  const host = getHost(url);
  if (!host) return false;
  return (
    host === "youtube.com" ||
    host === "www.youtube.com" ||
    host === "m.youtube.com" ||
    host === "youtu.be" ||
    host === "music.youtube.com"
  );
}

function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

// ── Session-scoped proxy disable state ─────────────────────────
// When a proxy host fails during a session, we disable it and
// fall through to regular HTTP fetch for the rest of the session.

const disabledProxyHosts = new Set<string>();
const lastRequestByHost = new Map<string, number>();

export function resetProxyState(): void {
  disabledProxyHosts.clear();
  lastRequestByHost.clear();
}

function isProxyDisabled(host: string): boolean {
  return disabledProxyHosts.has(host);
}

function disableProxy(host: string): void {
  disabledProxyHosts.add(host);
}

/**
 * Enforce a minimum interval between requests to the same proxy host.
 * Waits for the remaining time if the last request was too recent.
 * Respects AbortSignal for immediate cancellation during the wait.
 */
async function throttle(host: string, rateLimitMs: number, signal?: AbortSignal): Promise<void> {
  const last = lastRequestByHost.get(host) ?? 0;
  const elapsed = Date.now() - last;
  if (elapsed < rateLimitMs) {
    const delay = rateLimitMs - elapsed;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const timer = setTimeout(() => { cleanup(); resolve(); }, delay);
      const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal!.reason); };
      const cleanup = () => { signal?.removeEventListener("abort", onAbort); };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  lastRequestByHost.set(host, Date.now());
}

// ── Main router ────────────────────────────────────────────────

export interface FetchUrlOptions {
  selector?: string;
  includeLinks?: boolean;
  verbose?: boolean;
  maxComments?: number;
  signal?: AbortSignal;
}

export interface FetchUrlResult {
  url: string;
  title: string;
  content: string;
  error: string | null;
  truncated: boolean;
}

export async function fetchUrl(
  url: string,
  config: PiInternetConfig,
  options: FetchUrlOptions = {},
): Promise<FetchUrlResult> {
  if (options.signal?.aborted) {
    return { url, title: "", content: "", error: "Cancelled", truncated: false };
  }

  let result: FetchResult;

  try {
    // 1. Reddit
    const redditProxyHost = config.reddit.proxyHost;
    if (isRedditUrl(url) && redditProxyHost && !isProxyDisabled(redditProxyHost)) {
      try {
        await throttle(redditProxyHost, config.reddit.rateLimitMs, options.signal);
        if (!redditModule) redditModule = await import("./reddit.js");
        result = await redditModule.fetchReddit(url, config, options);
        return finalize(result);
      } catch (err) {
        if (options.signal?.aborted) throw err;
        disableProxy(redditProxyHost);
        // Fall through to regular HTTP
      }
    }

    // 2. Twitter/X
    const twitterProxyHost = config.twitter.proxyHost;
    if (isTwitterUrl(url) && twitterProxyHost && !isProxyDisabled(twitterProxyHost)) {
      try {
        await throttle(twitterProxyHost, config.twitter.rateLimitMs, options.signal);
        if (!twitterModule) twitterModule = await import("./twitter.js");
        result = await twitterModule.fetchTwitter(url, config, options);
        return finalize(result);
      } catch (err) {
        if (options.signal?.aborted) throw err;
        disableProxy(twitterProxyHost);
        // Fall through to regular HTTP
      }
    }

    // 3. GitHub
    if (isGitHubUrl(url) && config.github.enabled) {
      if (!githubModule) githubModule = await import("./github.js");
      const ghResult = await githubModule.fetchGitHub(url, config, options.signal);
      if (ghResult) return finalize(ghResult);
      // null means "not a code URL" — fall through to HTTP
    }

    // 4. YouTube
    if (isYouTubeUrl(url) && config.youtube.enabled) {
      if (!youtubeModule) youtubeModule = await import("./youtube.js");
      result = await youtubeModule.fetchYouTube(url, {
        verbose: options.verbose,
        signal: options.signal,
      });
      return finalize(result);
    }

    // 5. PDF (by URL extension — content-type check happens in httpFetch)
    if (isPdfUrl(url)) {
      if (!pdfModule) pdfModule = await import("./pdf.js");
      result = await pdfModule.fetchPdf(url, options.signal, config.fetch.socksProxy);
      return finalize(result);
    }

    // 6. Regular HTTP with fallback chain
    result = await httpFetch(url, {
      timeoutMs: config.fetch.timeoutMs,
      selector: options.selector,
      includeLinks: options.includeLinks ?? config.fetch.includeLinks,
      socksProxy: config.fetch.socksProxy,
      signal: options.signal,
    });
    return finalize(result);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { url, title: "", content: "", error: msg, truncated: false };
  }
}

function finalize(result: FetchResult): FetchUrlResult {
  if (result.error && !result.content) {
    return { ...result, truncated: false };
  }
  const truncated = applyTruncation(result.content);
  return {
    url: result.url,
    title: result.title,
    content: truncated.text,
    error: result.error,
    truncated: truncated.truncated,
  };
}
