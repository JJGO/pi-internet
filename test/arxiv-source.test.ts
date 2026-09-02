import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { pack, type Headers } from "tar-stream";
import {
  fetchAndExtractArxivSource,
  safeArchivePath,
} from "../src/fetch/arxiv-source.ts";

async function makeTar(entries: Array<{ header: Headers; body?: string }>): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  archive.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const complete = new Promise<void>((resolve, reject) => {
    archive.on("end", resolve);
    archive.on("error", reject);
  });
  for (const entry of entries) {
    archive.entry(entry.header, entry.body ?? "");
  }
  archive.finalize();
  await complete;
  return Buffer.concat(chunks);
}

test("arXiv source extraction retains payload, manifest, tree, and root preview", async () => {
  const tar = await makeTar([
    { header: { name: "figures/", type: "directory" } },
    { header: { name: "main.tex" }, body: "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n" },
    { header: { name: "sections/intro.tex" }, body: "Introduction" },
  ]);
  const result = await fetchAndExtractArxivSource(
    new Response(gzipSync(tar), {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": 'attachment; filename="paper.tar.gz"',
      },
    }),
    "https://arxiv.org/src/2401.01234v1",
    "Useful Paper",
  );

  const directory = dirname(result.artifacts!.sourceManifest!);
  try {
    assert.equal(result.error, null);
    assert.match(result.content, /Format: gzip-tar/);
    assert.match(result.content, /Likely root TeX file/);
    assert.match(result.content, /\\documentclass\{article\}/);
    assert.deepEqual(await readFile(result.artifacts!.sourceDownload!), gzipSync(tar));
    const manifest = JSON.parse(await readFile(result.artifacts!.sourceManifest!, "utf8"));
    assert.equal(manifest.format, "gzip-tar");
    assert.deepEqual(manifest.likelyRoots, ["main.tex", "sections/intro.tex"]);
    assert.equal(await readFile(join(result.artifacts!.sourceDirectory!, "main.tex"), "utf8"), "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("arXiv source extraction handles a single plain TeX source", async () => {
  const source = "\\documentclass{article}\n\\begin{document}Plain source\\end{document}\n";
  const result = await fetchAndExtractArxivSource(
    new Response(source, { headers: { "content-type": "text/plain" } }),
    "https://arxiv.org/src/2401.01234v1",
    "Plain Paper",
  );
  const directory = dirname(result.artifacts!.sourceManifest!);
  try {
    assert.equal(result.error, null);
    assert.match(result.content, /Format: text/);
    assert.equal(await readFile(join(result.artifacts!.sourceDirectory!, "source.tex"), "utf8"), source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("arXiv source extraction rejects symlinks and removes partial output", async () => {
  const tar = await makeTar([
    { header: { name: "main.tex" }, body: "\\documentclass{article}" },
    { header: { name: "escape", type: "symlink", linkname: "/etc/passwd" } },
  ]);
  const result = await fetchAndExtractArxivSource(
    new Response(gzipSync(tar), { headers: { "content-type": "application/gzip" } }),
    "https://arxiv.org/src/2401.01234v1",
    "Unsafe Paper",
  );
  const directory = dirname(result.artifacts!.sourceManifest!);
  try {
    assert.match(result.error ?? "", /unsupported symlink entry/);
    assert.deepEqual(await readdir(result.artifacts!.sourceDirectory!), []);
    assert.ok((await readFile(result.artifacts!.sourceDownload!)).byteLength > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("arXiv source extraction retains unknown payloads without unpacking", async () => {
  const payload = Buffer.from([0, 1, 2, 3, 4]);
  const result = await fetchAndExtractArxivSource(
    new Response(payload, { headers: { "content-type": "application/octet-stream" } }),
    "https://arxiv.org/src/2401.01234v1",
    "Unknown Paper",
  );
  const directory = dirname(result.artifacts!.sourceManifest!);
  try {
    assert.match(result.error ?? "", /unsupported/);
    assert.deepEqual(await readdir(result.artifacts!.sourceDirectory!), []);
    assert.deepEqual(await readFile(result.artifacts!.sourceDownload!), payload);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safeArchivePath rejects traversal, absolute, NUL, and Windows escape paths", () => {
  assert.equal(safeArchivePath("sections/intro.tex"), "sections/intro.tex");
  for (const path of [
    "../escape",
    "/absolute",
    "C:/windows",
    "..\\escape",
    "bad\0name",
    "NUL",
    "CON.txt",
    "folder/COM1.log",
    "name:stream",
    "trailing-dot.",
    "trailing-space ",
  ]) {
    assert.throws(() => safeArchivePath(path));
  }
});
