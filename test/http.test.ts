import assert from "node:assert/strict";
import test from "node:test";
import { httpFetch, rewriteGithubBlobToRaw, isLikelyJSRendered } from "../src/fetch/http.ts";

// ── rewriteGithubBlobToRaw ──────────────────────────────

test("rewriteGithubBlobToRaw: rewrites blob to raw", () => {
  const result = rewriteGithubBlobToRaw("https://github.com/owner/repo/blob/main/src/file.ts");
  assert.equal(result, "https://raw.githubusercontent.com/owner/repo/main/src/file.ts");
});

test("rewriteGithubBlobToRaw: rewrites raw to raw", () => {
  const result = rewriteGithubBlobToRaw("https://github.com/owner/repo/raw/main/file.txt");
  assert.equal(result, "https://raw.githubusercontent.com/owner/repo/main/file.txt");
});

test("rewriteGithubBlobToRaw: ignores non-GitHub URLs", () => {
  const url = "https://gitlab.com/owner/repo/blob/main/file.ts";
  assert.equal(rewriteGithubBlobToRaw(url), url);
});

test("rewriteGithubBlobToRaw: ignores short paths", () => {
  const url = "https://github.com/owner/repo";
  assert.equal(rewriteGithubBlobToRaw(url), url);
});

test("rewriteGithubBlobToRaw: ignores non-blob/raw paths", () => {
  const url = "https://github.com/owner/repo/tree/main/src";
  assert.equal(rewriteGithubBlobToRaw(url), url);
});

test("rewriteGithubBlobToRaw: handles www.github.com", () => {
  const result = rewriteGithubBlobToRaw("https://www.github.com/owner/repo/blob/main/file.ts");
  assert.equal(result, "https://raw.githubusercontent.com/owner/repo/main/file.ts");
});

// ── isLikelyJSRendered ──────────────────────────────────

test("isLikelyJSRendered: detects SPA with many scripts and little text", () => {
  const html = `<html><body>
    <div id="root"></div>
    <script src="a.js"></script>
    <script src="b.js"></script>
    <script src="c.js"></script>
    <script src="d.js"></script>
  </body></html>`;
  assert.equal(isLikelyJSRendered(html), true);
});

test("isLikelyJSRendered: returns false for content-rich pages", () => {
  const html = `<html><body>
    <article>${"Lorem ipsum dolor sit amet. ".repeat(50)}</article>
    <script src="a.js"></script>
    <script src="b.js"></script>
  </body></html>`;
  assert.equal(isLikelyJSRendered(html), false);
});

test("isLikelyJSRendered: returns false for no body", () => {
  assert.equal(isLikelyJSRendered("<html><head></head></html>"), false);
});

test("httpFetch cancels unsupported response bodies", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      pull() {},
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "video/mp4" } });

    const result = await httpFetch("https://example.test/video", {
      allowPrivateNetworks: true,
      socksProxy: null,
    });
    assert.match(result.error ?? "", /Unsupported content type/);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("httpFetch: only Reddit media subdomains receive Accept */*", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const headers: string[] = [];
    globalThis.fetch = async (_input, init) => {
      headers.push(new Headers(init?.headers).get("accept") ?? "");
      return new Response("plain content", { headers: { "content-type": "text/plain" } });
    };
    for (const host of ["i.redd.it", "preview.redd.it", "external-preview.redd.it", "styles.redd.it", "I.REDD.IT"]) {
      await httpFetch(`https://${host}/image.jpg`, { allowPrivateNetworks: true, socksProxy: null });
      assert.equal(headers.at(-1), "*/*");
    }
    for (const host of ["example.com", "reddit.com", "redd.it", "notredd.it", "i.redd.it.evil.test"]) {
      await httpFetch(`https://${host}/image.jpg`, { allowPrivateNetworks: true, socksProxy: null });
      assert.equal(headers.at(-1), "text/html,application/xhtml+xml,application/pdf,application/xml;q=0.9,*/*;q=0.8");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
