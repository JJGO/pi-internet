/**
 * URL classification and dispatch to specialized handlers.
 *
 * Provenance: pi-web-access/extract.ts (URL classification order, fallback orchestration).
 *
 * Routing order:
 * 1. arXiv → representation-aware paper fetcher
 * 2. Reddit → Redlib proxy parser
 * 3. Twitter/X → Nitter proxy parser
 * 4. GitHub → clone code locally or fetch collaboration surfaces via API
 * 5. YouTube → yt-dlp transcript
 * 6. HTTP → content classification and extraction
 */

import type { PiInternetConfig } from "../config.js";
import { abortableDelay } from "../util/retry-fetch.js";
import type { UrlLookup } from "../util/safe-fetch.js";
import { httpFetch, type FetchArtifacts, type FetchResult, type HttpFetchOptions } from "./http.js";

// Lazy imports for specialized handlers (loaded on first use)
let arxivModule: typeof import("./arxiv.js") | null = null;
let githubModule: typeof import("./github.js") | null = null;
let youtubeModule: typeof import("./youtube.js") | null = null;
let redditModule: typeof import("./reddit.js") | null = null;
let twitterModule: typeof import("./twitter.js") | null = null;

// ── URL classifiers ────────────────────────────────────────────

const REDDIT_HOSTS = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "np.reddit.com",
  "new.reddit.com",
  "sh.reddit.com",
  "m.reddit.com",
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

function getHostWithPort(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function isRedditUrl(url: string, redditProxyHost?: string | null): boolean {
  const host = getHost(url);
  if (host !== null && REDDIT_HOSTS.has(host)) return true;

  // config.ts normalizes reddit.proxyHost to a lowercase host[:port] at load time.
  if (!redditProxyHost) return false;
  return getHostWithPort(url) === redditProxyHost;
}

function isTwitterUrl(url: string): boolean {
  const host = getHost(url);
  return host !== null && TWITTER_HOSTS.has(host);
}

function isGitHubUrl(url: string): boolean {
  const host = getHost(url);
  return host === "github.com" || host === "www.github.com" || host === "gist.github.com";
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

// ── Session-scoped proxy disable state ─────────────────────────
// Twitter/X proxy failures disable that proxy for the rest of the session and
// fall through to regular HTTP. Reddit proxy failures are surfaced directly.

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
    await abortableDelay(rateLimitMs - elapsed, signal);
  }
  lastRequestByHost.set(host, Date.now());
}

// ── Main router ────────────────────────────────────────────────

export interface FetchUrlOptions {
  selector?: string;
  includeLinks?: boolean;
  verbose?: boolean;
  allowImages?: boolean;
  cleanYouTubeDescription?: (description: string) => Promise<string>;
  signal?: AbortSignal;
  lookup?: UrlLookup;
}

export interface FetchUrlResult {
  url: string;
  title: string;
  content: string;
  error: string | null;
  images?: Array<{ data: string; mimeType: string }>;
  fullOutputPath?: string;
  artifacts?: FetchArtifacts;
}

export async function fetchUrl(
  url: string,
  config: PiInternetConfig,
  options: FetchUrlOptions = {},
): Promise<FetchUrlResult> {
  if (options.signal?.aborted) {
    return { url, title: "", content: "", error: "Cancelled" };
  }

  let result: FetchResult;

  try {
    // 1. arXiv
    if (!arxivModule) arxivModule = await import("./arxiv.js");
    const arxivResult = await arxivModule.fetchArxiv(url, config, options);
    if (arxivResult) return arxivResult;

    // 2. Reddit
    const redditProxyHost = config.reddit.proxyHost;
    if (isRedditUrl(url, redditProxyHost)) {
      if (redditProxyHost) {
        await throttle(redditProxyHost, config.reddit.rateLimitMs, options.signal);
        if (!redditModule) redditModule = await import("./reddit.js");
        result = await redditModule.fetchReddit(url, config, options);
        return result;
      }

      result = await httpFetch(url, {
        timeoutMs: config.fetch.timeoutMs,
        selector: options.selector,
        includeLinks: options.includeLinks ?? config.fetch.includeLinks,
        socksProxy: config.fetch.socksProxy,
        signal: options.signal,
        allowPrivateNetworks: config.fetch.allowPrivateNetworks,
        lookup: options.lookup,
      });
      return addDirectRedditGuidance(result);
    }

    // 3. Twitter/X
    const twitterProxyHost = config.twitter.proxyHost;
    if (isTwitterUrl(url) && twitterProxyHost && !isProxyDisabled(twitterProxyHost)) {
      try {
        await throttle(twitterProxyHost, config.twitter.rateLimitMs, options.signal);
        if (!twitterModule) twitterModule = await import("./twitter.js");
        result = await twitterModule.fetchTwitter(url, config, options);
        return result;
      } catch (err) {
        if (options.signal?.aborted) throw err;
        disableProxy(twitterProxyHost);
        // Fall through to regular HTTP
      }
    }

    // 4. GitHub
    if (isGitHubUrl(url) && config.github.enabled) {
      if (!githubModule) githubModule = await import("./github.js");
      const ghResult = await githubModule.fetchGitHub(url, config, options.signal, {
        verbose: options.verbose,
        includeLinks: options.includeLinks,
      });
      if (ghResult) return ghResult;
      // null means "not a supported GitHub URL" — fall through to HTTP
    }

    // 5. YouTube
    if (isYouTubeUrl(url) && config.youtube.enabled) {
      if (!youtubeModule) youtubeModule = await import("./youtube.js");
      result = await youtubeModule.fetchYouTube(url, {
        verbose: options.verbose,
        allowImages: options.allowImages,
        cleanYouTubeDescription: options.cleanYouTubeDescription,
        signal: options.signal,
      });
      return result;
    }

    // 6. Regular HTTP with content-type routing and fallback chain
    result = await httpFetch(url, {
      timeoutMs: config.fetch.timeoutMs,
      selector: options.selector,
      includeLinks: options.includeLinks ?? config.fetch.includeLinks,
      socksProxy: config.fetch.socksProxy,
      signal: options.signal,
      allowPrivateNetworks: config.fetch.allowPrivateNetworks,
      lookup: options.lookup,
    });
    return result;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { url, title: "", content: "", error: msg };
  }
}

function addDirectRedditGuidance(result: FetchResult): FetchResult {
  const guidance = "Configure a Redlib-compatible proxy with PI_INTERNET_REDLIB_PROXY or piInternet.reddit.proxyHost to fetch Reddit reliably with structured comments.";
  const detail = directRedditFailureDetail(result);

  if (!detail) return result;

  // Verification/challenge pages are not useful content, so suppress them and
  // return an actionable error instead of spending context on Reddit's blocker.
  if (isRedditVerificationContent(result)) {
    return {
      url: result.url,
      title: result.title,
      content: "",
      error: `Direct Reddit fetch failed (${detail}). ${guidance}`,
    };
  }

  if (result.content) {
    return {
      ...result,
      error: result.error
        ? `${result.error}. Direct Reddit fetch may be incomplete. ${guidance}`
        : `Direct Reddit fetch may be incomplete. ${guidance}`,
    };
  }

  return {
    ...result,
    error: `Direct Reddit fetch failed (${detail}). ${guidance}`,
  };
}

function directRedditFailureDetail(result: FetchResult): string | null {
  if (isRedditVerificationContent(result)) return "Reddit verification/block page returned";
  if (result.error) return result.error;
  if (!result.content.trim()) return "no readable content returned";
  return null;
}

function isRedditVerificationContent(result: FetchResult): boolean {
  const haystack = `${result.title}\n${result.content}`.toLowerCase();
  return (
    haystack.includes("reddit - please wait for verification") ||
    haystack.includes("please wait for verification") ||
    haystack.includes("js_challenge")
  );
}
