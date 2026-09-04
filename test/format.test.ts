import assert from "node:assert/strict";
import test from "node:test";
import {
  compactSnippet,
  formatResults,
  MAX_SNIPPET_CHARS,
  type SearchResult,
} from "../src/search/types.ts";

// ── compactSnippet ──────────────────────────────────────────

test("compactSnippet leaves short snippets unchanged", () => {
  assert.equal(compactSnippet("A short description."), "A short description.");
});

test("compactSnippet collapses whitespace runs", () => {
  assert.equal(
    compactSnippet("First paragraph.\n\nSecond   paragraph.\t tabbed"),
    "First paragraph. Second paragraph. tabbed",
  );
});

test("compactSnippet caps oversized snippets with an ellipsis", () => {
  const compacted = compactSnippet("word ".repeat(1_000));
  assert.ok(compacted.length <= MAX_SNIPPET_CHARS);
  assert.ok(compacted.endsWith("\u2026"));
});

test("compactSnippet does not split a surrogate pair at the cap", () => {
  // The emoji occupies UTF-16 indices 498-499; slicing at 499 would split it.
  const snippet = `${"x".repeat(MAX_SNIPPET_CHARS - 2)}\u{1F600} trailing text that exceeds the cap`;
  const compacted = compactSnippet(snippet);
  assert.ok(compacted.length <= MAX_SNIPPET_CHARS);
  assert.ok(compacted.isWellFormed());
  assert.ok(compacted.endsWith("\u2026"));
});

// ── formatResults ──────────────────────────────────────────

/** Snippet portion of each rendered `## n. title\nurl\n\nsnippet` section. */
function renderedSnippets(text: string): string[] {
  return text
    .split("\n\n---\n\n")
    .map((section) => section.split("\n\n").slice(1).join("\n\n"));
}

test("formatResults caps every model-visible snippet", () => {
  const results: SearchResult[] = [
    { title: "Verbose", url: "https://a.example", snippet: "x".repeat(4_000), provider: "brave" },
    { title: "Terse", url: "https://b.example", snippet: "short", provider: "kagi" },
  ];
  const text = formatResults(results);

  for (const snippet of renderedSnippets(text)) {
    assert.ok(snippet.length <= MAX_SNIPPET_CHARS);
  }
  assert.match(text, /## 1\. Verbose \(via brave\)/);
  assert.match(text, /## 2\. Terse \(via kagi\)/);
  assert.match(text, /short/);
});

test("formatResults keeps a default-size response compact", () => {
  const results: SearchResult[] = Array.from({ length: 10 }, (_, i) => ({
    title: `Result ${i} with a reasonably long descriptive title for testing`,
    url: `https://example.com/some/long/path/segment/${i}`,
    snippet: "s".repeat(3_000),
    provider: "tavily",
  }));
  const text = formatResults(results);

  for (const snippet of renderedSnippets(text)) {
    assert.ok(snippet.length <= MAX_SNIPPET_CHARS);
  }
  // 10 capped results stay well under 8KB even with pathological providers.
  assert.ok(Buffer.byteLength(text, "utf8") < 8_192);
});

test("formatResults handles empty input", () => {
  assert.equal(formatResults([]), "No results found.");
});
