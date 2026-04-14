import assert from "node:assert/strict";
import test from "node:test";
import { parseSubtitles } from "../src/fetch/youtube.ts";

test("parseSubtitles: basic VTT parsing", () => {
  const vtt = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:04.000
Hello world

00:00:05.000 --> 00:00:08.000
This is a test
`;
  const result = parseSubtitles(vtt);
  assert.ok(result.includes("[00:00:01]"));
  assert.ok(result.includes("Hello world"));
  assert.ok(result.includes("This is a test"));
});

test("parseSubtitles: deduplicates repeated lines", () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
Hello world

00:00:02.000 --> 00:00:04.000
Hello world

00:00:05.000 --> 00:00:08.000
Different text
`;
  const result = parseSubtitles(vtt);
  const count = (result.match(/Hello world/g) || []).length;
  assert.equal(count, 1, "Duplicate lines should be removed");
});

test("parseSubtitles: strips HTML tags", () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<c.colorE5E5E5>Hello</c> <b>world</b>
`;
  const result = parseSubtitles(vtt);
  assert.ok(result.includes("Hello world"));
  assert.ok(!result.includes("<c."));
  assert.ok(!result.includes("<b>"));
});

test("parseSubtitles: groups into paragraphs at >30s gaps", () => {
  // Create 3 clusters of subtitles separated by >30s gaps
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:05.000
First cluster line 1

00:00:10.000 --> 00:00:15.000
First cluster line 2

00:01:00.000 --> 00:01:05.000
Second cluster line 1

00:01:10.000 --> 00:01:15.000
Second cluster line 2

00:02:30.000 --> 00:02:35.000
Third cluster line 1
`;
  const result = parseSubtitles(vtt);
  const paragraphs = result.split("\n\n").filter(Boolean);
  assert.ok(paragraphs.length >= 3, `Expected >= 3 paragraphs, got ${paragraphs.length}`);
});

test("parseSubtitles: handles SRT format", () => {
  const srt = `1
00:00:01,000 --> 00:00:04,000
Hello SRT

2
00:00:05,000 --> 00:00:08,000
Second line
`;
  const result = parseSubtitles(srt);
  assert.ok(result.includes("Hello SRT"));
  assert.ok(result.includes("Second line"));
});

test("parseSubtitles: returns empty on empty input", () => {
  assert.equal(parseSubtitles(""), "");
  assert.equal(parseSubtitles("WEBVTT\n\n"), "");
});
