/**
 * Reddit fetching via Redlib privacy proxy.
 *
 * Provenance: proxyfetch-ts/src/parsers/reddit.ts + proxyfetch-ts/src/render.ts
 * Borrowed: Redlib HTML selectors, post/comment extraction, nested reply traversal,
 * OP detection, depth-limited rendering, truncation notices.
 */

import { parse, getText, getAttr, normalizeText, type Doc } from "../util/dom.js";
import { combinedSignal } from "../util/signal.js";
import { fetchWithProxy } from "../util/proxy.js";
import type { PiInternetConfig } from "../config.js";
import type { FetchResult } from "./http.js";
import type { FetchUrlOptions } from "./router.js";

// ── Types ──────────────────────────────────────────────────────

interface RedditPost {
  title: string;
  author: string;
  subreddit: string;
  time: string;
  score?: string;
  flair?: string;
  commentCount?: string;
  body?: string;
  url?: string;
}

interface RedditComment {
  author: string;
  score?: string;
  time: string;
  body: string;
  isOp: boolean;
  depth: number;
  replies: RedditComment[];
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
  return parts.length >= 4 && parts[0] === "r" && parts[2] === "comments";
}

// ── Parsing ────────────────────────────────────────────────────

function extractPost(postEl: Element, baseUrl: string): RedditPost {
  const subreddit = getText(postEl.querySelector(".post_subreddit"));
  const author = getText(postEl.querySelector(".post_author"));
  const time = getText(postEl.querySelector("span.created"));
  const scoreEl = postEl.querySelector(".post_score");
  const score = getAttr(scoreEl, "title");
  const commentsEl = postEl.querySelector(".post_comments");
  const commentCount = commentsEl ? getText(commentsEl) : undefined;

  const titleEl = postEl.querySelector("h2.post_title") || postEl.querySelector("h1.post_title");
  let title = "";
  let flair: string | undefined;
  if (titleEl) {
    const flairEl = titleEl.querySelector(".post_flair span");
    if (flairEl) flair = getText(flairEl);
    const titleLinks = titleEl.querySelectorAll("a:not(.post_flair)");
    if (titleLinks.length > 0) {
      title = getText(titleLinks[0] as Element);
    } else {
      const full = getText(titleEl);
      title = flair ? full.replace(flair, "").trim() : full;
    }
  }

  let url: string | undefined;
  if (titleEl) {
    const link = titleEl.querySelector("a:not(.post_flair)");
    const href = getAttr(link, "href");
    if (href) url = href.startsWith("/") ? baseUrl + href : href;
  }

  const bodyEl = postEl.querySelector(".post_body .md");
  const body = bodyEl ? getText(bodyEl) : undefined;

  return { title, author, subreddit, time, score, flair, commentCount, body, url };
}

function extractComment(el: Element, depth: number, opAuthor: string): RedditComment {
  const author = getText(el.querySelector(".comment_author"));
  const score = getAttr(el.querySelector(".comment_score"), "title");
  const time = getText(el.querySelector("a.created"));
  const bodyEl = el.querySelector(".comment_body .md");
  const body = bodyEl ? getText(bodyEl) : "";

  const replies: RedditComment[] = [];
  const detailsEls = el.querySelectorAll(":scope > details");
  for (const details of detailsEls) {
    const repliesBlock = (details as Element).querySelector("blockquote.replies");
    if (repliesBlock) {
      for (const child of repliesBlock.querySelectorAll(":scope > div.comment")) {
        replies.push(extractComment(child as Element, depth + 1, opAuthor));
      }
    }
  }

  return { author, score, time, body, isOp: author === opAuthor, depth, replies };
}

// ── Rendering ──────────────────────────────────────────────────

function renderListing(posts: RedditPost[], subreddit: string): string {
  const lines = [`# ${subreddit}`, ""];
  for (const p of posts) {
    const parts = [`- **${p.title}**`];
    if (p.flair) parts.push(` [${p.flair}]`);
    parts.push(` — ${p.author}, ${p.time}`);
    if (p.score) parts.push(`, ${p.score} pts`);
    if (p.commentCount) parts.push(`, ${p.commentCount}`);
    if (p.url) parts.push(`  (${p.url})`);
    lines.push(parts.join(""));
    if (p.body) {
      const preview = p.body.length > 300 ? p.body.slice(0, 300) + "..." : p.body;
      lines.push(`  ${preview}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderThread(post: RedditPost, comments: RedditComment[], maxDepth: number, maxComments?: number): string {
  const lines: string[] = [];
  lines.push(`# ${post.title}`);
  const meta = [post.author, post.time];
  if (post.score) meta.push(`${post.score} pts`);
  meta.push(post.subreddit);
  if (post.flair) meta.push(post.flair);
  lines.push(meta.join(" | "), "");
  if (post.body) lines.push(post.body, "");
  lines.push("---");

  const shown = maxComments != null ? comments.slice(0, maxComments) : comments;
  let truncatedDepth = 0;
  lines.push(`## Comments (${comments.length})`, "");

  for (const c of shown) {
    truncatedDepth += renderComment(c, lines, maxDepth);
    lines.push("");
  }

  const footerParts: string[] = [];
  if (maxComments != null && maxComments < comments.length) {
    footerParts.push(`Showing ${maxComments} of ${comments.length} top-level comments`);
  }
  if (truncatedDepth > 0) {
    footerParts.push(`${truncatedDepth} nested reply thread(s) truncated at depth ${maxDepth}`);
  }
  if (footerParts.length > 0) {
    lines.push(`*${footerParts.join(". ")}. Use verbose=true to see everything.*`);
  }

  return lines.join("\n");
}

function renderComment(c: RedditComment, lines: string[], maxDepth: number, depth = 0): number {
  const prefix = depth > 0 ? "> ".repeat(depth) : "";
  const score = c.score ? ` (${c.score} pts)` : "";
  const op = c.isOp ? " [OP]" : "";
  lines.push(`${prefix}**${c.author}**${score}${op}, ${c.time}`);
  for (const bline of c.body.split("\n")) lines.push(`${prefix}${bline}`);

  let truncated = 0;
  if (c.replies.length > 0) {
    if (depth >= maxDepth) {
      truncated += 1;
    } else {
      for (const reply of c.replies) truncated += renderComment(reply, lines, maxDepth, depth + 1);
    }
  }
  return truncated;
}

// ── Public API ─────────────────────────────────────────────────

export async function fetchReddit(
  url: string,
  config: PiInternetConfig,
  options: FetchUrlOptions,
): Promise<FetchResult> {
  const proxyHost = config.reddit.proxyHost;
  if (!proxyHost) throw new Error("Reddit proxy host not configured");

  const proxyUrl = rewriteToProxy(url, proxyHost);
  const baseUrl = `https://${proxyHost}`;

  const res = await fetchWithProxy(proxyUrl, {
    headers: { "User-Agent": "pi-internet/0.1" },
    signal: combinedSignal(options.signal, 15_000),
  }, {
    socksProxy: config.fetch.socksProxy,
  });

  if (!res.ok) throw new Error(`Redlib proxy returned HTTP ${res.status}`);

  const html = await res.text();
  const doc = parse(html);

  if (isThreadUrl(url)) {
    const postEl = doc.querySelector("div.post");
    if (!postEl) throw new Error("Could not find post content in thread page");
    const post = extractPost(postEl, baseUrl);

    // Full body for thread pages
    const bodyEl = postEl.querySelector(".post_body .md");
    if (bodyEl) post.body = getText(bodyEl);

    const comments: RedditComment[] = [];
    const section = doc.querySelector("#comments") || doc.querySelector(".comments");
    const commentEls = section
      ? section.querySelectorAll(":scope > div.comment")
      : doc.querySelectorAll("div.comment");
    for (const el of commentEls) {
      const parent = el.parentElement;
      if (!section && parent && parent.tagName?.toLowerCase() === "blockquote") continue;
      comments.push(extractComment(el as Element, 0, post.author));
    }

    const maxDepth = options.verbose ? 99 : config.reddit.commentDepth;
    const content = renderThread(post, comments, maxDepth, options.maxComments);
    return { url, title: post.title, content, error: null };
  }

  // Listing
  const posts: RedditPost[] = [];
  for (const el of doc.querySelectorAll("div.post")) {
    posts.push(extractPost(el as Element, baseUrl));
  }

  if (posts.length === 0) {
    throw new Error("Proxy returned no content — possibly rate-limited or blocked");
  }

  let subreddit = "";
  const firstSub = doc.querySelector(".post_subreddit");
  if (firstSub) subreddit = getText(firstSub);

  const content = renderListing(posts, subreddit);
  return { url, title: subreddit, content, error: null };
}
