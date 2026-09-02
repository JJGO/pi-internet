import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadResponseToFile, readResponseText } from "../src/util/download.ts";

test("downloadResponseToFile enforces actual streamed bytes without Content-Length", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-internet-download-test-"));
  const path = join(directory, "output");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from("12345"));
      controller.enqueue(Buffer.from("67890"));
      controller.close();
    },
  });
  try {
    await assert.rejects(
      downloadResponseToFile(new Response(stream), path, 8),
      /exceeds the 8 B limit/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloadResponseToFile rejects an oversized declared length before reading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-internet-download-test-"));
  const path = join(directory, "output");
  try {
    await assert.rejects(
      downloadResponseToFile(new Response("small", { headers: { "content-length": "101" } }), path, 100),
      /exceeds the 100 B limit/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloadResponseToFile records bytes, header, and hash while writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-internet-download-test-"));
  const path = join(directory, "output");
  try {
    const result = await downloadResponseToFile(new Response("hello"), path, 100);
    assert.equal(result.bytes, 5);
    assert.equal(Buffer.from(result.header).toString(), "hello");
    assert.equal(result.sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    assert.equal(await readFile(path, "utf8"), "hello");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readResponseText enforces the actual byte limit", async () => {
  await assert.rejects(readResponseText(new Response("éé"), 3), /exceeds/);
  assert.equal(await readResponseText(new Response("éé"), 4), "éé");
});
