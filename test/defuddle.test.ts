import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { extractWithDefuddle } from "../src/fetch/defuddle.ts";
import { httpFetch } from "../src/fetch/http.ts";

const schemaArticleBody =
  `<a href="guide">Guide</a> ${"A detailed explanation of safe concurrent interpreter design and its implementation tradeoffs. ".repeat(15)}`;

function schemaOnlyArticle(): string {
  const schema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "Schema Article",
    articleBody: schemaArticleBody,
  });
  return `<html><head><title>Fallback fixture</title><script type="application/ld+json">${schema}</script></head><body><div id="root"></div></body></html>`;
}

test("httpFetch: uses Defuddle after Readability and RSC return too little content", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/start") {
      response.writeHead(302, { location: "/final/article" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(schemaOnlyArticle());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert(address && typeof address === "object");
  const result = await httpFetch(`http://127.0.0.1:${address.port}/start`, {
    includeLinks: true,
    socksProxy: null,
  });

  assert.equal(result.error, null);
  assert.equal(result.title, "Schema Article");
  assert.match(result.content, /safe concurrent interpreter design/);
  assert.match(result.content, new RegExp(`\\[Guide\\]\\(http://127\\.0\\.0\\.1:${address.port}/final/guide\\)`));
  assert(result.content.length >= 500);
});

test("extractWithDefuddle: remains local and preserves selectors and Markdown options", async () => {
  const html = `<html><head><title>Fixture</title></head><body>
    <main id="wanted"><h1>Wanted</h1><p><a href="https://example.com/source">linked text</a> ${"target words ".repeat(80)}</p><img src="image.png" alt="image alt"></main>
    <section id="mw-content-text"><h1>Noise</h1><p>${"noise words ".repeat(80)}</p></section>
  </body></html>`;
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error("unexpected network request");
  };

  try {
    const withoutLinks = await extractWithDefuddle(
      html,
      "https://en.wikipedia.org/wiki/Fixture",
      "#wanted",
      { includeLinks: false },
    );
    const withLinks = await extractWithDefuddle(
      html,
      "https://en.wikipedia.org/wiki/Fixture",
      "#wanted",
      { includeLinks: true },
    );

    assert(withoutLinks);
    assert(withLinks);
    assert.match(withoutLinks.content, /linked text/);
    assert.doesNotMatch(withoutLinks.content, /https:\/\/example\.com\/source/);
    assert.match(withLinks.content, /\[linked text\]\(https:\/\/example\.com\/source\)/);
    assert.doesNotMatch(withoutLinks.content, /Noise|noise words|image alt/);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extractWithDefuddle: fails closed on cancellation and adapter errors", async () => {
  const controller = new AbortController();
  controller.abort();

  assert.equal(
    await extractWithDefuddle(schemaOnlyArticle(), "https://example.com/article", undefined, {}, controller.signal),
    null,
  );
  assert.equal(
    await extractWithDefuddle(schemaOnlyArticle(), "https://example.com/article", "[", {}),
    null,
  );
});
