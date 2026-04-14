import assert from "node:assert/strict";
import test from "node:test";
import { mergeResults, normalizeUrl } from "../src/search/merge.ts";
import type { SearchResult } from "../src/search/types.ts";

// ── normalizeUrl ──────────────────────────────────────────

test("normalizeUrl strips trailing slash", () => {
  assert.equal(normalizeUrl("https://example.com/"), "https://example.com");
});

test("normalizeUrl strips www prefix", () => {
  assert.equal(normalizeUrl("https://www.example.com/path"), "https://example.com/path");
});

test("normalizeUrl strips fragment", () => {
  assert.equal(normalizeUrl("https://example.com/page#section"), "https://example.com/page");
});

test("normalizeUrl preserves query string", () => {
  assert.equal(normalizeUrl("https://example.com/page?q=test"), "https://example.com/page?q=test");
});

test("normalizeUrl returns input on invalid URL", () => {
  assert.equal(normalizeUrl("not-a-url"), "not-a-url");
});

// ── mergeResults ──────────────────────────────────────────

test("mergeResults deduplicates by URL", () => {
  const set1: SearchResult[] = [
    { title: "A", url: "https://example.com/a", snippet: "short", provider: "brave" },
  ];
  const set2: SearchResult[] = [
    { title: "A", url: "https://example.com/a", snippet: "much longer snippet here", provider: "kagi" },
  ];
  const merged = mergeResults([set1, set2], 10);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].snippet, "much longer snippet here"); // keeps richer snippet
});

test("mergeResults interleaves from multiple providers", () => {
  const set1: SearchResult[] = [
    { title: "A1", url: "https://a.com/1", snippet: "a1" },
    { title: "A2", url: "https://a.com/2", snippet: "a2" },
  ];
  const set2: SearchResult[] = [
    { title: "B1", url: "https://b.com/1", snippet: "b1" },
    { title: "B2", url: "https://b.com/2", snippet: "b2" },
  ];
  const merged = mergeResults([set1, set2], 10);
  assert.equal(merged.length, 4);
  // Round-robin: A1, B1, A2, B2
  assert.equal(merged[0].title, "A1");
  assert.equal(merged[1].title, "B1");
});

test("mergeResults caps at maxResults", () => {
  const set1: SearchResult[] = Array.from({ length: 10 }, (_, i) => ({
    title: `R${i}`, url: `https://example.com/${i}`, snippet: `s${i}`,
  }));
  const merged = mergeResults([set1], 3);
  assert.equal(merged.length, 3);
});

test("mergeResults handles empty input", () => {
  assert.equal(mergeResults([], 10).length, 0);
  assert.equal(mergeResults([[]], 10).length, 0);
});

test("mergeResults deduplicates www vs non-www", () => {
  const set1: SearchResult[] = [
    { title: "A", url: "https://www.example.com/page", snippet: "a" },
  ];
  const set2: SearchResult[] = [
    { title: "A", url: "https://example.com/page", snippet: "longer snippet" },
  ];
  const merged = mergeResults([set1, set2], 10);
  assert.equal(merged.length, 1);
});
