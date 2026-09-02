import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { truncateToolText } from "../src/util/truncation.ts";

test("truncateToolText: leaves bounded output unchanged", async () => {
  const output = await truncateToolText("short output", {
    continuation: "Refine the request.",
  });

  assert.deepEqual(output, { text: "short output" });
});

test("truncateToolText: truncates by line count with an actionable notice", async () => {
  const text = Array.from({ length: DEFAULT_MAX_LINES + 1 }, (_, index) => `line ${index}`).join("\n");
  const output = await truncateToolText(text, {
    continuation: "Refine the query or request fewer results.",
  });

  assert.equal(output.truncation?.truncatedBy, "lines");
  assert.equal(output.truncation?.outputLines, DEFAULT_MAX_LINES - 2);
  assert.ok(output.text.split("\n").length <= DEFAULT_MAX_LINES);
  assert.ok(Buffer.byteLength(output.text, "utf8") <= DEFAULT_MAX_BYTES);
  assert.match(output.text, /Output truncated/);
  assert.match(output.text, /Refine the query or request fewer results/);
});

test("truncateToolText: applies the byte limit to UTF-8 output", async () => {
  const text = Array.from({ length: 1_000 }, () => "😀".repeat(20)).join("\n");
  const output = await truncateToolText(text, {
    continuation: "Refine the request.",
  });

  assert.equal(output.truncation?.truncatedBy, "bytes");
  assert.ok((output.truncation?.outputBytes ?? Infinity) <= DEFAULT_MAX_BYTES);
  assert.ok(output.text.split("\n").length <= DEFAULT_MAX_LINES);
  assert.ok(Buffer.byteLength(output.text, "utf8") <= DEFAULT_MAX_BYTES);
});

test("truncateToolText: saves complete output when requested", async () => {
  const text = "report line\n".repeat(DEFAULT_MAX_LINES + 1);
  const output = await truncateToolText(text, {
    continuation: "Read the full report.",
    fullOutput: { prefix: "pi-internet-test-", filename: "report.md" },
  });

  assert.ok(output.fullOutputPath);
  try {
    assert.equal(await readFile(output.fullOutputPath, "utf8"), text);
    assert.equal((await stat(output.fullOutputPath)).mode & 0o777, 0o600);
    assert.match(output.text, new RegExp(`Full output: ${output.fullOutputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    await rm(dirname(output.fullOutputPath), { recursive: true, force: true });
  }
});
