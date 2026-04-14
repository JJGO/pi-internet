import assert from "node:assert/strict";
import test from "node:test";
import { rewriteGithubBlobToRaw, isLikelyJSRendered } from "../src/fetch/http.ts";

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
