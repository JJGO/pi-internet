import assert from "node:assert/strict";
import test from "node:test";
import { extractHeadingTitle, htmlToMarkdown } from "../src/util/markdown.ts";

test("extractHeadingTitle: extracts H1", () => {
  assert.equal(extractHeadingTitle("# Hello World\n\nContent"), "Hello World");
});

test("extractHeadingTitle: extracts H2", () => {
  assert.equal(extractHeadingTitle("Some text\n## API Reference\n\nMore"), "API Reference");
});

test("extractHeadingTitle: strips bold markers", () => {
  assert.equal(extractHeadingTitle("# **Bold Title**"), "Bold Title");
});

test("extractHeadingTitle: returns null when no heading", () => {
  assert.equal(extractHeadingTitle("Just plain text"), null);
});

test("extractHeadingTitle: ignores H3+", () => {
  assert.equal(extractHeadingTitle("### Not a title"), null);
});

test("extractHeadingTitle: returns null for empty heading", () => {
  assert.equal(extractHeadingTitle("# "), null);
});

test("htmlToMarkdown keeps links by default and supports explicit compact mode", () => {
  const html = '<p>Read <a href="https://example.com/paper">the paper</a>.</p>';
  assert.equal(htmlToMarkdown(html), "Read [the paper](https://example.com/paper).");
  assert.equal(htmlToMarkdown(html, { includeLinks: false }), "Read the paper.");
});
