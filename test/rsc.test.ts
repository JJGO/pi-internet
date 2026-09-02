import assert from "node:assert/strict";
import test from "node:test";
import { extractRSCContent } from "../src/fetch/rsc.ts";

/** Wrap an RSC flight chunk line into the script tag Next.js emits. */
function flightScript(line: string): string {
  const escaped = JSON.stringify(line).slice(1, -1);
  return `<script>self.__next_f.push([1,"${escaped}"])</script>`;
}

function page(title: string, ...scripts: string[]): string {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${scripts.join("")}</body></html>`;
}

test("extractRSCContent: returns null for pages without flight data", () => {
  assert.equal(extractRSCContent("<html><body><p>regular page</p></body></html>"), null);
});

test("extractRSCContent: extracts headings, paragraphs, code, and links from the main chunk", () => {
  const tree = ["$", "div", null, {
    children: [
      ["$", "h1", null, { children: "Hello Docs" }],
      ["$", "p", null, { children: "This is a paragraph of documentation content long enough to pass the minimum useful-content threshold." }],
      ["$", "pre", null, { children: ["$", "code", null, { children: "const x = 1;" }] }],
      ["$", "p", null, { children: ["See ", ["$", "a", null, { href: "https://example.com", children: "the docs" }], " for details."] }],
      ["$", "script", null, { children: "ignored()" }],
    ],
  }];
  const html = page("My Page | Site", flightScript(`23:${JSON.stringify(tree)}`));

  const result = extractRSCContent(html);
  assert.ok(result);
  assert.equal(result.title, "My Page");
  assert.match(result.content, /^# Hello Docs/);
  assert.match(result.content, /paragraph of documentation content/);
  assert.match(result.content, /```\nconst x = 1;\n```/);
  assert.match(result.content, /\[the docs\]\(https:\/\/example\.com\)/);
  assert.doesNotMatch(result.content, /ignored\(\)/);
});

test("extractRSCContent: resolves $L chunk references without looping on cycles", () => {
  const referenced = ["$", "p", null, { children: "Referenced chunk content that is definitely long enough to count as useful extracted page text for the extractor threshold." }];
  // Chunk 2a references itself; the extractor must not recurse forever.
  const cyclic = ["$", "div", null, { children: "$L2a" }];
  const main = ["$", "div", null, { children: ["$L1f", "$L2a"] }];
  const html = page("Ref Page", flightScript(
    [`23:${JSON.stringify(main)}`, `1f:${JSON.stringify(referenced)}`, `2a:${JSON.stringify(cyclic)}`].join("\n"),
  ));

  const result = extractRSCContent(html);
  assert.ok(result);
  assert.match(result.content, /Referenced chunk content/);
});

test("extractRSCContent: renders tables as markdown with escaped pipes", () => {
  const table = ["$", "table", null, {
    children: [
      ["$", "thead", null, { children: ["$", "tr", null, { children: [
        ["$", "th", null, { children: "Name" }],
        ["$", "th", null, { children: "Value" }],
      ] }] }],
      ["$", "tbody", null, { children: ["$", "tr", null, { children: [
        ["$", "td", null, { children: "a|b" }],
        ["$", "td", null, { children: "1" }],
      ] }] }],
    ],
  }];
  const tree = ["$", "div", null, {
    children: [
      ["$", "p", null, { children: "Some surrounding paragraph text so the extracted content clears the length threshold easily." }],
      table,
    ],
  }];
  const html = page("Table Page", flightScript(`23:${JSON.stringify(tree)}`));

  const result = extractRSCContent(html);
  assert.ok(result);
  assert.match(result.content, /\| Name \| Value \|/);
  assert.match(result.content, /\| --- \| --- \|/);
  assert.match(result.content, /\| a\\\|b \| 1 \|/);
});

test("extractRSCContent: falls back to other chunks when chunk 23 is missing", () => {
  const tree = ["$", "div", null, {
    children: ["$", "p", null, { children: "Fallback chunk content that is long enough to be treated as the useful body of the page under test by the extractor." }],
  }];
  const html = page("Fallback Page", flightScript(`2:${JSON.stringify(tree)}`));

  const result = extractRSCContent(html);
  assert.ok(result);
  assert.match(result.content, /Fallback chunk content/);
});
