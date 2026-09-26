import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { PiInternetConfig } from "../src/config.js";
import { fetchUrl, resetProxyState } from "../src/fetch/router.js";
import { parse } from "../src/util/dom.js";
import { __test__ } from "../src/fetch/twitter.js";

test("detects X/Twitter article URLs", () => {
  assert.equal(__test__.isArticleUrl("https://x.com/TheAhmadOsman/article/2041331757329285589"), true);
  assert.equal(__test__.isArticleUrl("https://twitter.com/i/article/2041331757329285589"), true);
  assert.equal(__test__.isArticleUrl("https://x.com/TheAhmadOsman/status/2041331757329285589"), false);
});

test("parses Nitter article pages into markdown", () => {
  const html = `<!doctype html>
<html>
  <head><title>Memory Bandwidth for Local AI Hardware (2026 Edition) | Nitter</title></head>
  <body>
    <div class="article timeline-item">
      <div class="article-author tweet-header">
        <a class="fullname" href="/TheAhmadOsman" title="Ahmad">Ahmad</a>
        <a class="username" href="/TheAhmadOsman" title="@TheAhmadOsman">@TheAhmadOsman</a>
        <span class="tweet-date"><a href="/TheAhmadOsman/status/2041331757329285589#m" title="Apr 7, 2026 · 1:46 AM UTC">Apr 7, 2026</a></span>
      </div>
      <h1 class="article-title">Memory Bandwidth for Local AI Hardware (2026 Edition)</h1>
      <div class="article-content">
        <div class="article-block"><p><span>Capacity decides whether the model fits.</span></p></div>
        <div class="article-block"><blockquote><span>Local AI hardware = capacity × bandwidth × software stack</span></blockquote></div>
        <div class="article-block"><h3><span>The Hardware Number You Should Actually Care About</span></h3></div>
        <div class="article-block"><ul class="article-list"><li><span>RTX 5090 → 1792 GB/s</span></li></ul></div>
        <div class="article-block"><p><span>See <a href="https://example.com/specs">specs</a>.</span></p></div>
      </div>
    </div>
  </body>
</html>`;

  const article = __test__.parseArticlePage(parse(html), true);
  const rendered = __test__.renderArticle(article);

  assert.equal(article.title, "Memory Bandwidth for Local AI Hardware (2026 Edition)");
  assert.equal(article.username, "@TheAhmadOsman");
  assert.match(rendered, /^# Memory Bandwidth for Local AI Hardware/m);
  assert.match(rendered, /\*\*@TheAhmadOsman — Apr 7, 2026 · 1:46 AM UTC\*\*/);
  assert.match(rendered, /Capacity decides whether the model fits\./);
  assert.match(rendered, /> Local AI hardware = capacity × bandwidth × software stack/);
  assert.match(rendered, /### The Hardware Number You Should Actually Care About/);
  assert.match(rendered, /-\s+RTX 5090 → 1792 GB\/s/);
  assert.match(rendered, /\[specs\]\(https:\/\/example\.com\/specs\)/);
});

test("strips article links by default", () => {
  const html = `<div class="article-content"><p>See <a href="https://example.com/specs">specs</a>.</p></div>`;
  const article = __test__.parseArticlePage(parse(html), false);
  assert.equal(article.content, "See specs.");
});

function makeConfig(): PiInternetConfig {
  return {
    searchProviders: [],
    fallbackProviders: [],
    reddit: { commentDepth: 4, proxyHost: null, rateLimitMs: 1 },
    twitter: { proxyHost: "nitter.example:8443", rateLimitMs: 1 },
    github: { enabled: false, maxRepoSizeMB: 350, clonePath: "/tmp/pi-internet-test-github", refreshTtlMs: 300000 },
    youtube: { enabled: false },
    pdf: { converter: "unpdf" },
    fetch: { includeLinks: false, timeoutMs: 1000, socksProxy: null, allowPrivateNetworks: true },
  };
}

async function withMockFetch(handler: (input: string | URL | Request) => Response, fn: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  resetProxyState();
  try {
    globalThis.fetch = async (input) => handler(input);
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
    resetProxyState();
  }
}

function response(html: string): Response {
  return new Response(html, { headers: { "content-type": "text/html" } });
}

function tweetHtml(username: string, content: string, extra = ""): string {
  return `<div class="timeline-item">
    <a class="tweet-link" href="/${username}/status/123#m"></a>
    <div class="tweet-body">
      <div class="tweet-header">
        <a class="tweet-avatar"><img src="/avatar.png"></a>
        <a class="fullname" title="${username}">${username}</a>
        <a class="username" title="@${username}">@${username}</a>
        <span class="tweet-date"><a title="Jun 6, 2026">now</a></span>
      </div>
      <div class="tweet-content">${content}</div>
      ${extra}
      <div class="tweet-stats"><span class="tweet-stat">1</span><span class="tweet-stat">2</span><span class="tweet-stat">3</span></div>
    </div>
  </div>`;
}

function attachmentsHtml(images: string): string {
  return `<div class="attachments"><div class="gallery-row">${images}</div></div>`;
}

function stillImage(href: string, src = "/thumbnail.png"): string {
  return `<div class="attachment"><a class="still-image" href="${href}"><img src="${src}"></a></div>`;
}

function quoteHtml(images: string): string {
  return `<div class="quote quote-big">
    <a class="quote-link" href="/quoted/status/456"></a>
    <img class="mini" src="/quote-avatar.png">
    <a class="username" title="@quoted">@quoted</a>
    <div class="quote-text">Quoted text.</div>
    <div class="quote-media-container">${attachmentsHtml(images)}</div>
  </div>`;
}

const TWEET_URL = "https://x.com/mitsuhiko/status/2103530775216001096";
const REPRO_ATTACHMENTS = `<div class="attachments"><div class="gallery-row"><div class="attachment"><a class="still-image" href="/pic/orig/media%2FHTE99V8WUAAwusp.png" target="_blank"><img src="/pic/media%2FHTE99V8WUAAwusp.png%3Fname%3Dsmall%26format%3Dwebp" alt="" loading="lazy"></a></div></div></div>`;

function mainTweetHtml(extra = REPRO_ATTACHMENTS): string {
  return `<div class="main-tweet">${tweetHtml("mitsuhiko", "Saved myself 1.4 USD here :)", extra)}</div>`;
}

test("fetchTwitter: discloses the reproduced main-tweet image without downloading it", async () => {
  const requests: string[] = [];
  await withMockFetch((input) => {
    requests.push(String(input));
    return response(mainTweetHtml());
  }, async () => {
    const result = await fetchUrl(TWEET_URL, makeConfig());
    assert.equal(result.error, null);
    assert.equal(result.url, TWEET_URL);
    assert.equal(result.title, "@mitsuhiko: Saved myself 1.4 USD here :)");
    assert.deepEqual(requests, ["https://nitter.example:8443/mitsuhiko/status/2103530775216001096"]);
    assert.match(result.content, /Saved myself 1\.4 USD here :\)/);
    assert.match(result.content, /Images:\n- https:\/\/nitter\.example:8443\/pic\/orig\/media%2FHTE99V8WUAAwusp\.png/);
    assert.match(result.content, /1 replies \| 2 RT \| 3 likes/);
    assert.doesNotMatch(result.content, /name%3Dsmall|thumbnail|avatar/);
    assert.equal(result.artifacts, undefined);
    assert.equal(result.images, undefined);
  });
});

test("fetchTwitter: images prefer full resolution, deduplicate in order and use the final proxy page URL", async () => {
  const redirected = "https://redirected.example/user/status/page/";
  const images = attachmentsHtml([
    stillImage("/pic/orig/first.png?a=1&amp;b=2"),
    stillImage("second.png"),
    stillImage("https://redirected.example/pic/orig/first.png?a=1&amp;b=2", "/duplicate-thumbnail.png"),
    stillImage("//cdn.example/third.jpg"),
    stillImage("http://cdn.example/fourth.png"),
  ].join(""));
  const requests: string[] = [];
  await withMockFetch((input) => {
    requests.push(String(input));
    if (requests.length === 1) return new Response(null, { status: 302, headers: { location: redirected } });
    const res = response(mainTweetHtml(images));
    Object.defineProperty(res, "url", { value: redirected });
    return res;
  }, async () => {
    const result = await fetchUrl(TWEET_URL, makeConfig(), { includeLinks: false });
    assert.equal(result.error, null);
    assert.equal(requests.length, 2);
    assert.equal(requests[1], redirected);
    assert.deepEqual(result.content.match(/^- https?:\/\/\S+$/gm), [
      "- https://redirected.example/pic/orig/first.png?a=1&b=2",
      "- https://redirected.example/user/status/page/second.png",
      "- https://cdn.example/third.jpg",
      "- http://cdn.example/fourth.png",
    ]);
    assert.doesNotMatch(result.content, /thumbnail/);
  });
});

test("fetchTwitter: attributes quote images separately and deduplicates per owner", async () => {
  const shared = stillImage("/pic/orig/shared.png");
  const quoted = quoteHtml(shared + stillImage("/pic/orig/quote.png") + shared);
  for (const own of ["", attachmentsHtml(shared + stillImage("/pic/orig/own.png") + shared)]) {
    await withMockFetch(() => response(mainTweetHtml(own + quoted)), async () => {
      const result = await fetchUrl(TWEET_URL, makeConfig());
      assert.equal(result.error, null);
      const [main, quote] = result.content.split("> QT @quoted: Quoted text.");
      assert.ok(quote);
      assert.deepEqual(main.match(/^- https?:\/\/\S+$/gm) ?? [], own ? [
        "- https://nitter.example:8443/pic/orig/shared.png",
        "- https://nitter.example:8443/pic/orig/own.png",
      ] : []);
      assert.deepEqual(quote.match(/^> - https?:\/\/\S+$/gm), [
        "> - https://nitter.example:8443/pic/orig/shared.png",
        "> - https://nitter.example:8443/pic/orig/quote.png",
      ]);
      assert.match(quote, /> Images:/);
      assert.doesNotMatch(main, /\/quote\.png/);
      assert.doesNotMatch(quote, /\/own\.png/);
      assert.doesNotMatch(result.content, /avatar|thumbnail/);
    });
  }
});

test("fetchTwitter: thread continuations and compact replies retain their own and quoted images", async () => {
  const longText = "r".repeat(550);
  const html = mainTweetHtml()
    + `<div class="after-tweet">${tweetHtml("author", "Thread continuation.", attachmentsHtml(stillImage("/thread.png")))}</div>`
    + `<div class="replies">${tweetHtml("reply", longText, attachmentsHtml(stillImage("/reply.png")) + quoteHtml(stillImage("/quoted-reply.png")))}</div>`;
  await withMockFetch(() => response(html), async () => {
    for (const verbose of [false, true]) {
      const result = await fetchUrl(TWEET_URL, makeConfig(), { verbose });
      assert.equal(result.error, null);
      assert.match(result.content, /## Replies \(1\)/);
      assert.match(result.content, /Thread continuation\.\nImages:\n- https:\/\/nitter\.example:8443\/thread\.png/);
      const replies = result.content.split("## Replies (1)")[1];
      assert.ok(replies.includes(verbose ? longText : "r".repeat(500) + "..."));
      if (!verbose) assert.ok(!replies.includes(longText));
      assert.match(replies, /Images:\n- https:\/\/nitter\.example:8443\/reply\.png/);
      assert.match(replies, /> QT @quoted: Quoted text\.\n> Images:\n> - https:\/\/nitter\.example:8443\/quoted-reply\.png/);
      assert.doesNotMatch(replies, /\/thread\.png|HTE99V8WUAAwusp/);
    }
  });
});

test("fetchTwitter: compact profiles preserve metadata, RT/pin markers and image-only tweets", async () => {
  const longText = "p".repeat(550);
  const html = `<a class="profile-card-fullname" title="Profile">Profile</a>
    <a class="profile-card-username" title="@profile">@profile</a>
    <div class="profile-bio">Profile bio.</div>
    <div class="profile-statlist"><span class="followers"><span class="profile-stat-num">42</span></span></div>`
    + tweetHtml("profile", longText, `<div class="pinned">Pinned</div><div class="retweet-header">Friend retweeted</div>`
      + attachmentsHtml(stillImage("/profile.png")) + quoteHtml(stillImage("/profile-quote.png")))
    + tweetHtml("photo", "", attachmentsHtml(stillImage("/image-only.png")));
  await withMockFetch(() => response(html), async () => {
    const result = await fetchUrl("https://twitter.com/profile", makeConfig());
    assert.equal(result.error, null);
    assert.equal(result.title, "Profile (@profile)");
    assert.match(result.content, /# Profile \(@profile\)\nProfile bio\.\n42 followers/);
    assert.match(result.content, /\[pinned\] \*\*@profile\*\* \(RT by Friend\) — Jun 6, 2026/);
    assert.ok(result.content.includes("p".repeat(500) + "..."));
    assert.ok(!result.content.includes(longText));
    assert.match(result.content, /^- https:\/\/nitter\.example:8443\/profile\.png$/m);
    assert.match(result.content, /^> - https:\/\/nitter\.example:8443\/profile-quote\.png$/m);
    assert.match(result.content, /\*\*@photo\*\*[^\n]+\nImages:\n- https:\/\/nitter\.example:8443\/image-only\.png/);
  });
});

test("fetchTwitter: unsafe image URLs are omitted and only usable thumbnails are fallback candidates", async () => {
  const unsafe = [
    "javascript:alert(1)", "data:image/png,abc", "ftp://cdn.example/image.png",
    "https://user:secret@cdn.example/image.png", "https://user@cdn.example/image.png", "http://[invalid",
    "/pic/evil&#10;row.png", "/pic/evil&#13;row.png", "/pic/evil&#9;row.png", "/pic/evil&#127;row.png", "/pic/space image.png",
  ];
  const images = attachmentsHtml(unsafe.map((value) => stillImage(value, value)).join("")
    + stillImage("javascript:alert(1)", "/pic/usable-fallback.png")
    + stillImage("", "/pic/empty-href-fallback.png")
    + `<div class="attachment"><a class="still-image"><img src="/pic/missing-href-fallback.png"></a></div>`
    + stillImage("/pic/valid-anchor.png", "data:image/png,abc"));
  await withMockFetch(() => response(mainTweetHtml(images + quoteHtml(unsafe.map((value) => stillImage(value, value)).join("")))), async () => {
    const result = await fetchUrl(TWEET_URL, makeConfig());
    assert.equal(result.error, null);
    assert.match(result.content, /Saved myself 1\.4 USD here :\)/);
    assert.match(result.content, /> QT @quoted: Quoted text\./);
    assert.deepEqual(result.content.match(/^- https?:\/\/\S+$/gm), [
      "- https://nitter.example:8443/pic/usable-fallback.png",
      "- https://nitter.example:8443/pic/empty-href-fallback.png",
      "- https://nitter.example:8443/pic/missing-href-fallback.png",
      "- https://nitter.example:8443/pic/valid-anchor.png",
    ]);
    assert.doesNotMatch(result.content, /javascript:|data:image|ftp:|secret|user@|invalid|evil|space|> Images:/);
  });
});

test("fetchTwitter: text, cards and quotes stay unchanged without still-image attachments", async () => {
  const extras = `<a class="card-container" href="https://example.com/story"><img src="/card.png"><h2 class="card-title">Story title</h2></a>`
    + attachmentsHtml(`<div class="attachment"><video poster="/video-poster.png"></video></div>
      <div class="attachment"><img src="/disabled-video.png"><div class="video-overlay">Enable video</div></div>`)
    + `<a class="still-image" href="/outside-attachments.png"><img src="/outside-thumbnail.png"></a>`
    + quoteHtml("");
  await withMockFetch(() => response(mainTweetHtml(extras)), async () => {
    for (const includeLinks of [false, true]) {
      const result = await fetchUrl(TWEET_URL, makeConfig(), { includeLinks });
      assert.equal(result.error, null);
      assert.equal(result.content, "**@mitsuhiko** — Jun 6, 2026  (https://nitter.example:8443/mitsuhiko/status/123)\n"
        + "Saved myself 1.4 USD here :)\n> [Story title] (https://example.com/story)\n> QT @quoted: Quoted text.\n1 replies | 2 RT | 3 likes\n");
    }
  });
});

test("fetchTwitter: a disclosed image can be selected with fetchUrl and read from the generic download path", async () => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const requests: string[] = [];
  await withMockFetch((input) => {
    requests.push(String(input));
    return requests.length === 1 ? response(mainTweetHtml())
      : new Response(gif, { headers: { "content-type": "image/gif" } });
  }, async () => {
    const tweet = await fetchUrl(TWEET_URL, makeConfig());
    assert.equal(tweet.error, null);
    assert.equal(requests.length, 1);
    assert.equal(tweet.artifacts, undefined);
    const imageUrl = tweet.content.match(/^- (https:\/\/\S+)$/m)?.[1];
    assert.ok(imageUrl);
    const image = await fetchUrl(imageUrl, makeConfig());
    const path = image.artifacts?.imageDownload;
    try {
      assert.equal(image.error, null);
      assert.equal(requests.length, 2);
      assert.equal(requests[1], imageUrl);
      assert.ok(path);
      assert.deepEqual(await readFile(path), gif);
      assert.match(image.content, /Dimensions: 1x1/);
      assert.match(image.content, /read/);
      assert.equal(image.images, undefined);
    } finally {
      if (path) await rm(dirname(path), { recursive: true, force: true });
    }
  });
});
