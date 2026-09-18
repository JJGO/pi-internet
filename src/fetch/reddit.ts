/**
 * Reddit fetching via Redlib privacy proxy.
 *
 * Provenance: proxyfetch-ts/src/parsers/reddit.ts + proxyfetch-ts/src/render.ts
 * Borrowed: Redlib HTML selectors, post/comment extraction, nested reply traversal,
 * OP detection, depth-limited rendering, truncation notices.
 */

import { parse, getText, getAttr } from "../util/dom.js";
import { combinedSignal } from "../util/signal.js";
import { readResponseText } from "../util/download.js";
import { safeFetch } from "../util/safe-fetch.js";
import type { PiInternetConfig } from "../config.js";
import type { FetchResult } from "./http.js";
import type { FetchUrlOptions } from "./router.js";
import { fetchImageResponse } from "./image.js";
import { redlibMediaPath } from "./reddit-url.js";

const MAX_PROXY_RESPONSE_BYTES = 5 * 1024 * 1024;

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
  imageUrls?: string[];
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
  // Validate before rewriting so a trusted proxy cannot launder an unsafe URL.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) throw new Error("URLs with embedded credentials are not allowed");
  const mediaPath = redlibMediaPath(url);
  const path = mediaPath ?? (/^\/(?:img|preview)\//.test(parsed.pathname)
    ? parsed.pathname
    : parsed.pathname.replace(/\/+$/, ""));
  return `https://${proxyHost}${path}${parsed.search}`;
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

function extractPostImages(postEl: Element, pageUrl: string): string[] {
  const urls = new Set<string>();
  // Only post media containers, not body/comment images, avatars or video posters.
  const media = postEl.querySelectorAll(":scope > .gallery figure, :scope > .post_media_content a.post_media_image");
  for (const element of media) {
    if (element.querySelector("video")) continue;
    const image = element.querySelector("img[src], image[href]");
    if (!image) continue;
    const link = element.matches("a") ? element : element.querySelector("a[href]");
    const candidates = [link?.getAttribute("href"), image.getAttribute("src") ?? image.getAttribute("href")];
    for (const value of candidates) {
      if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) continue;
      try {
        const parsed = new URL(value, pageUrl);
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) continue;
        urls.add(parsed.href);
        break;
      } catch {
        // Ignore malformed media URLs rather than rendering unsafe output.
      }
    }
  }
  return [...urls];
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

const DEFAULT_COMMENT_LIMIT = 20;

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

function renderThread(post: RedditPost, comments: RedditComment[], maxDepth: number, verbose: boolean): string {
  const lines: string[] = [];
  lines.push(`# ${post.title}`);
  const meta = [post.author, post.time];
  if (post.score) meta.push(`${post.score} pts`);
  meta.push(post.subreddit);
  if (post.flair) meta.push(post.flair);
  lines.push(meta.join(" | "), "");
  if (post.body) lines.push(post.body, "");
  if (post.imageUrls?.length) {
    lines.push("## Images", "", ...post.imageUrls.map((url) => `- ${url}`), "");
  }
  lines.push("---");

  const shown = verbose ? comments : comments.slice(0, DEFAULT_COMMENT_LIMIT);
  const totalComments = countComments(comments);
  let hiddenComments = countComments(comments.slice(shown.length));
  lines.push(`## Comments (${totalComments})`, "");

  for (const c of shown) {
    hiddenComments += renderComment(c, lines, maxDepth);
    lines.push("");
  }

  if (hiddenComments > 0) {
    lines.push(`*${hiddenComments}/${totalComments} parsed comments not displayed. Use \`verbose: true\` to see all comments and deeper replies.*`);
  }

  return lines.join("\n");
}

function countComments(comments: RedditComment[]): number {
  let total = 0;
  for (const comment of comments) {
    total += 1 + countComments(comment.replies);
  }
  return total;
}

function renderComment(c: RedditComment, lines: string[], maxDepth: number, depth = 0): number {
  const prefix = depth > 0 ? "> ".repeat(depth) : "";
  const score = c.score ? ` (${c.score} pts)` : "";
  const op = c.isOp ? " [OP]" : "";
  lines.push(`${prefix}**${c.author}**${score}${op}, ${c.time}`);
  for (const bline of c.body.split("\n")) lines.push(`${prefix}${bline}`);

  let hidden = 0;
  if (c.replies.length > 0) {
    if (depth >= maxDepth) {
      hidden += countComments(c.replies);
    } else {
      for (const reply of c.replies) hidden += renderComment(reply, lines, maxDepth, depth + 1);
    }
  }
  return hidden;
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

  const requestSignal = combinedSignal(options.signal, 15_000);
  const res = await safeFetch(proxyUrl, {
    headers: { "User-Agent": "pi-internet/0.1" },
    signal: requestSignal,
  }, {
    socksProxy: config.fetch.socksProxy,
    allowPrivateNetworks: config.fetch.allowPrivateNetworks,
    lookup: options.lookup,
    allowCrossOriginRedirects: false,
  });

  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Reddit proxy ${proxyHost} returned HTTP ${res.status}`);
  }

  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType.startsWith("image/")) return fetchImageResponse(res, url, requestSignal);
  if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
    await res.body?.cancel();
    throw new Error(`Reddit proxy ${proxyHost} returned unsupported content type: ${contentType || "missing"}`);
  }
  if (/^\/(?:img|preview)\//.test(new URL(proxyUrl).pathname)) {
    await res.body?.cancel();
    throw new Error(`Reddit proxy ${proxyHost} returned HTML instead of an image — possibly blocked`);
  }

  const html = await readResponseText(res, MAX_PROXY_RESPONSE_BYTES, requestSignal);
  const doc = parse(html);

  if (isThreadUrl(url)) {
    const postEl = doc.querySelector("div.post");
    if (!postEl) throw new Error("Could not find post content in thread page");
    const post = extractPost(postEl, baseUrl);
    post.imageUrls = extractPostImages(postEl, res.url || proxyUrl);

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

    const verbose = options.verbose ?? false;
    const maxDepth = verbose ? Number.POSITIVE_INFINITY : config.reddit.commentDepth;
    const content = renderThread(post, comments, maxDepth, verbose);
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
