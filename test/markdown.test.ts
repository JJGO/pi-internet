import assert from "node:assert/strict";
import test from "node:test";
import { extractHeadingTitle } from "../src/util/markdown.ts";

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
