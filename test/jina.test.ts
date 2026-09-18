import assert from "node:assert/strict";
import test from "node:test";
import { parseJinaResponse } from "../src/fetch/jina.ts";

const longContent = "meaningful markdown content ".repeat(10);

test("parseJinaResponse: extracts title from the metadata header", () => {
  const response = [
    "Title: torch.distributed.fsdp.fully_shard",
    "",
    "URL Source: https://docs.pytorch.org/docs/stable/distributed.fsdp.fully_shard.html",
    "",
    "Markdown Content:",
    longContent,
  ].join("\n");

  const parsed = parseJinaResponse(response);
  assert(parsed);
  assert.equal(parsed.title, "torch.distributed.fsdp.fully_shard");
  assert.equal(parsed.content, longContent.trim());
});

test("parseJinaResponse: missing title yields null title", () => {
  const parsed = parseJinaResponse(`Markdown Content:\n${longContent}`);
  assert(parsed);
  assert.equal(parsed.title, null);
  assert.equal(parsed.content, longContent.trim());
});

test("parseJinaResponse: only reads Title from the header, not the content", () => {
  const content = `Title: Not The Page Title\n${longContent}`;
  const parsed = parseJinaResponse(`Markdown Content:\n${content}`);
  assert(parsed);
  assert.equal(parsed.title, null);
});

test("parseJinaResponse: rejects malformed and failed-rendering responses", () => {
  assert.equal(parseJinaResponse("no marker here"), null);
  assert.equal(parseJinaResponse("Markdown Content:\nshort"), null);
  assert.equal(parseJinaResponse(`Markdown Content:\nLoading...${"x".repeat(200)}`), null);
  assert.equal(
    parseJinaResponse(`Markdown Content:\nPlease enable JavaScript${"x".repeat(200)}`),
    null,
  );
});
