/**
 * Twitter/X fetching via Nitter privacy proxy.
 *
 * Provenance: proxyfetch-ts/src/parsers/twitter.ts + proxyfetch-ts/src/render.ts
 * Borrowed: Nitter HTML selectors, tweet extraction (RT, quote, pin, card detection),
 * profile/thread parsing, token-efficient rendering.
 */

import { parse, getText, getAttr, normalizeText } from "../util/dom.js";
import { combinedSignal } from "../util/signal.js";
import { fetchWithProxy } from "../util/proxy.js";
import type { PiInternetConfig } from "../config.js";
import type { FetchResult } from "./http.js";
import type { FetchUrlOptions } from "./router.js";

// ── Types ──────────────────────────────────────────────────────

interface Tweet {
  author: string;
  username: string;
  time: string;
  content: string;
  url?: string;
  isRetweet: boolean;
  retweetedBy?: string;
  isPinned: boolean;
  repliesCount?: string;
  retweetsCount?: string;
  likesCount?: string;
  quote?: { username: string; content: string };
  cardTitle?: string;
  cardUrl?: string;
}

// ── URL rewriting ──────────────────────────────────────────────

function rewriteToProxy(url: string, proxyHost: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, "");
  const query = parsed.search;
  return `https://${proxyHost}${path}${query}`;
}

function isThreadUrl(url: string): boolean {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  return parts.length >= 3 && parts[1] === "status";
}

// ── Parsing ────────────────────────────────────────────────────

function extractTweet(item: Element, baseUrl: string): Tweet {
  const isRetweet = !!item.querySelector(".retweet-header");
  let retweetedBy: string | undefined;
  if (isRetweet) {
    const rt = item.querySelector(".retweet-header");
    if (rt) retweetedBy = getText(rt).replace(" retweeted", "").trim();
  }

  const isPinned = !!item.querySelector(".pinned");

  let url: string | undefined;
  const linkEl = item.querySelector(".tweet-link");
  const href = getAttr(linkEl, "href");
  if (href) url = baseUrl + href.replace(/#m$/, "");

  const fullnameEl = item.querySelector(".fullname");
  const author = getAttr(fullnameEl, "title") || getText(fullnameEl);

  const usernameEl = item.querySelector(".username");
  const username = getAttr(usernameEl, "title") || getText(usernameEl);

  const dateEl = item.querySelector(".tweet-date a");
  const time = getAttr(dateEl, "title") || getText(dateEl);

  const contentEl = item.querySelector(".tweet-content");
  const content = contentEl ? normalizeText(contentEl.textContent || "") : "";

  const statEls = item.querySelectorAll(".tweet-stat");
  const stats: string[] = [];
  for (const s of statEls) stats.push(getText(s as Element));

  let quote: Tweet["quote"] | undefined;
  const quoteEl = item.querySelector(".quote");
  if (quoteEl) {
    const qUser = quoteEl.querySelector(".username");
    const qContent = quoteEl.querySelector(".quote-text");
    quote = {
      username: getAttr(qUser, "title") || getText(qUser),
      content: qContent ? getText(qContent) : "",
    };
  }

  const cardEl = item.querySelector(".card-container");
  const cardTitle = cardEl?.querySelector(".card-title") ? getText(cardEl.querySelector(".card-title")) : undefined;
  const cardUrl = getAttr(cardEl, "href");

  return {
    author, username, time, content, url,
    isRetweet, retweetedBy, isPinned,
    repliesCount: stats[0] || undefined,
    retweetsCount: stats[1] || undefined,
    likesCount: stats[2] || undefined,
    quote, cardTitle, cardUrl,
  };
}

// ── Rendering ──────────────────────────────────────────────────

const TWEET_MAX_LEN = 500;

function renderTweet(t: Tweet, verbose: boolean): string {
  const parts: string[] = [];

  let header = `**${t.username}**`;
  if (t.isRetweet && t.retweetedBy) header = `**${t.username}** (RT by ${t.retweetedBy})`;
  if (t.isPinned) header = `[pinned] ${header}`;
  header += ` — ${t.time}`;
  if (t.url) header += `  (${t.url})`;
  parts.push(header);

  if (t.content) {
    const content = !verbose && t.content.length > TWEET_MAX_LEN
      ? t.content.slice(0, TWEET_MAX_LEN) + "..."
      : t.content;
    parts.push(content);
  }

  if (t.cardTitle) {
    parts.push(`> [${t.cardTitle}]${t.cardUrl ? ` (${t.cardUrl})` : ""}`);
  }
  if (t.quote) {
    parts.push(`> QT ${t.quote.username}: ${t.quote.content}`);
  }

  const tweetStats: string[] = [];
  if (t.repliesCount) tweetStats.push(`${t.repliesCount} replies`);
  if (t.retweetsCount) tweetStats.push(`${t.retweetsCount} RT`);
  if (t.likesCount) tweetStats.push(`${t.likesCount} likes`);
  if (tweetStats.length) parts.push(tweetStats.join(" | "));

  return parts.join("\n");
}

// ── Public API ─────────────────────────────────────────────────

export async function fetchTwitter(
  url: string,
  config: PiInternetConfig,
  options: FetchUrlOptions,
): Promise<FetchResult> {
  const proxyHost = config.twitter.proxyHost;
  if (!proxyHost) throw new Error("Twitter proxy host not configured");

  const proxyUrl = rewriteToProxy(url, proxyHost);
  const baseUrl = `https://${proxyHost}`;
  const verbose = options.verbose ?? false;

  const res = await fetchWithProxy(proxyUrl, {
    headers: { "User-Agent": "pi-internet/0.1" },
    signal: combinedSignal(options.signal, 15_000),
  }, {
    socksProxy: config.fetch.socksProxy,
  });

  if (!res.ok) throw new Error(`Nitter proxy returned HTTP ${res.status}`);

  const html = await res.text();
  const doc = parse(html);

  if (isThreadUrl(url)) {
    // Thread view
    const mainEl = doc.querySelector(".main-tweet .timeline-item");
    if (!mainEl) throw new Error("Could not find main tweet in thread page");
    const mainTweet = extractTweet(mainEl, baseUrl);

    const threadTweets: Tweet[] = [];
    const afterEl = doc.querySelector(".after-tweet");
    if (afterEl) {
      for (const item of afterEl.querySelectorAll(".timeline-item")) {
        threadTweets.push(extractTweet(item as Element, baseUrl));
      }
    }

    const replies: Tweet[] = [];
    const repliesSection = doc.querySelector(".replies");
    if (repliesSection) {
      for (const item of repliesSection.querySelectorAll(".timeline-item")) {
        const tweet = extractTweet(item as Element, baseUrl);
        if (tweet.content || tweet.username) replies.push(tweet);
      }
    }

    const lines: string[] = [renderTweet(mainTweet, true), ""];
    for (const tt of threadTweets) lines.push(renderTweet(tt, true), "");
    if (replies.length > 0) {
      lines.push("---", `## Replies (${replies.length})`, "");
      for (const r of replies) lines.push(renderTweet(r, verbose), "");
    }

    return { url, title: `${mainTweet.username}: ${mainTweet.content.slice(0, 60)}`, content: lines.join("\n"), error: null };
  }

  // Profile view
  const nameEl = doc.querySelector(".profile-card-fullname");
  const name = getAttr(nameEl, "title") || getText(nameEl);
  const userEl = doc.querySelector(".profile-card-username");
  const username = getAttr(userEl, "title") || getText(userEl);
  const bioEl = doc.querySelector(".profile-bio");
  const bio = bioEl ? normalizeText(bioEl.textContent || "") : "";

  function stat(cls: string): string | undefined {
    const el = doc.querySelector(`.profile-statlist .${cls} .profile-stat-num`);
    return el ? getText(el) : undefined;
  }

  const tweets: Tweet[] = [];
  for (const item of doc.querySelectorAll(".timeline-item")) {
    const tweet = extractTweet(item as Element, baseUrl);
    if (tweet.content || tweet.username) tweets.push(tweet);
  }

  if (!name && !username && tweets.length === 0) {
    throw new Error("Proxy returned no content — possibly rate-limited or blocked");
  }

  const lines: string[] = [`# ${name} (${username})`];
  if (bio) lines.push(bio);
  const stats: string[] = [];
  const followers = stat("followers");
  const following = stat("following");
  if (followers) stats.push(`${followers} followers`);
  if (following) stats.push(`${following} following`);
  if (stats.length) lines.push(stats.join(" | "));
  lines.push("", "---", "");

  for (const t of tweets) lines.push(renderTweet(t, verbose), "");

  return { url, title: `${name} (${username})`, content: lines.join("\n"), error: null };
}
