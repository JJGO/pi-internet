import assert from "node:assert/strict";
import test from "node:test";
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
