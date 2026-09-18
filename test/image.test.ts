import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import {
  MAX_IMAGE_BYTES,
  downloadImageToTemp,
  parseImageDimensions,
  readableImageExtension,
} from "../src/fetch/image.ts";
import { httpFetch } from "../src/fetch/http.ts";

// ── Synthetic image headers ─────────────────────────────

function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR length
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gifHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(10);
  buf.write("GIF89a", 0, "latin1");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function bmpHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(26);
  buf.write("BM", 0, "latin1");
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  return buf;
}

function jpegHeader(width: number, height: number): Buffer {
  // SOI, APP0 (16 bytes), SOF0 with dimensions
  const app0 = Buffer.alloc(18);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  const sof0 = Buffer.alloc(11);
  sof0.writeUInt16BE(0xffc0, 0);
  sof0.writeUInt16BE(9, 2);
  sof0[4] = 8; // bit depth
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

function webpVp8Header(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(22, 4);
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8 ", 12, "latin1");
  buf.writeUInt16LE(width, 26);
  buf.writeUInt16LE(height, 28);
  return buf;
}

function webpVp8lHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(22, 4);
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8L", 12, "latin1");
  buf[20] = 0x2f; // VP8L signature byte
  // 14-bit width-1, then 14-bit height-1, packed little-endian from bit 0.
  const bits = (width - 1) | ((height - 1) << 14);
  buf.writeUInt32LE(bits >>> 0, 21);
  return buf;
}

function webpVp8xHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(22, 4);
  buf.write("WEBP", 8, "latin1");
  buf.write("VP8X", 12, "latin1");
  buf.writeUIntLE(width - 1, 24, 3); // 24-bit canvas width - 1
  buf.writeUIntLE(height - 1, 27, 3); // 24-bit canvas height - 1
  return buf;
}

// ── readableImageExtension ──────────────────────────────

test("readableImageExtension: supported formats map to extensions", () => {
  assert.equal(readableImageExtension("image/jpeg"), ".jpg");
  assert.equal(readableImageExtension("image/jpg"), ".jpg");
  assert.equal(readableImageExtension("image/PNG; charset=binary"), ".png");
  assert.equal(readableImageExtension("image/webp"), ".webp");
  assert.equal(readableImageExtension("image/gif"), ".gif");
  assert.equal(readableImageExtension("image/bmp"), ".bmp");
});

test("readableImageExtension: unsupported formats return undefined", () => {
  assert.equal(readableImageExtension("image/svg+xml"), undefined);
  assert.equal(readableImageExtension("image/avif"), undefined);
  assert.equal(readableImageExtension("image/tiff"), undefined);
  assert.equal(readableImageExtension(""), undefined);
});

// ── parseImageDimensions ────────────────────────────────

test("parseImageDimensions: parses each supported format", () => {
  assert.deepEqual(parseImageDimensions(pngHeader(640, 480), "image/png"), { width: 640, height: 480 });
  assert.deepEqual(parseImageDimensions(gifHeader(120, 90), "image/gif"), { width: 120, height: 90 });
  assert.deepEqual(parseImageDimensions(bmpHeader(32, 64), "image/bmp"), { width: 32, height: 64 });
  assert.deepEqual(parseImageDimensions(jpegHeader(1024, 768), "image/jpeg"), { width: 1024, height: 768 });
  assert.deepEqual(parseImageDimensions(webpVp8Header(300, 200), "image/webp"), { width: 300, height: 200 });
  assert.deepEqual(parseImageDimensions(webpVp8lHeader(300, 200), "image/webp"), { width: 300, height: 200 });
  assert.deepEqual(parseImageDimensions(webpVp8xHeader(4000, 3000), "image/webp"), { width: 4000, height: 3000 });
});

test("parseImageDimensions: BMP top-down (negative height) is reported as positive", () => {
  assert.deepEqual(parseImageDimensions(bmpHeader(32, -64), "image/bmp"), { width: 32, height: 64 });
});

test("parseImageDimensions: returns undefined for malformed headers", () => {
  assert.equal(parseImageDimensions(Buffer.from("not an image"), "image/png"), undefined);
  assert.equal(parseImageDimensions(Buffer.alloc(0), "image/jpeg"), undefined);
  assert.equal(parseImageDimensions(pngHeader(1, 1), "image/x-unknown"), undefined);
});

// ── downloadImageToTemp ─────────────────────────────────

test("downloadImageToTemp: writes the file and reports metadata", async () => {
  const body = pngHeader(640, 480);
  const response = new Response(body, { headers: { "content-type": "image/png" } });

  const image = await downloadImageToTemp(response, "https://example.com/photos/My Photo (1).PNG");
  try {
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.bytes, body.byteLength);
    assert.deepEqual(image.dimensions, { width: 640, height: 480 });
    assert.match(image.path, /My_Photo_1_\.png$/);
    assert.deepEqual(await readFile(image.path), body);
  } finally {
    await rm(dirname(image.path), { recursive: true, force: true });
  }
});

test("downloadImageToTemp: rejects unsupported formats and cancels the body", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull() {},
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "image/svg+xml" } });

  await assert.rejects(
    downloadImageToTemp(response, "https://example.com/logo.svg"),
    /Unsupported image format: image\/svg\+xml/,
  );
  assert.equal(cancelled, true);
});

test("downloadImageToTemp: rejects images over the size limit without leaking the temp dir", async () => {
  const { readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dirsBefore = (await readdir(tmpdir())).filter((d) => d.startsWith("pi-internet-image-"));

  // Declared oversized (content-length) and streamed oversized both throw.
  const declared = new Response(pngHeader(1, 1), {
    headers: {
      "content-type": "image/png",
      "content-length": String(MAX_IMAGE_BYTES + 1),
    },
  });
  await assert.rejects(
    downloadImageToTemp(declared, "https://example.com/huge.png"),
    /exceeds the 10 MiB limit/,
  );

  const streamed = new Response(Buffer.alloc(2048, 1), { headers: { "content-type": "image/png" } });
  await assert.rejects(
    downloadImageToTemp(streamed, "https://example.com/huge2.png", { maxBytes: 1024 }),
    /exceeds the 1024 B limit/,
  );

  const dirsAfter = (await readdir(tmpdir())).filter((d) => d.startsWith("pi-internet-image-"));
  assert.deepEqual(dirsAfter, dirsBefore);
});

test("downloadImageToTemp: falls back to a generic filename", async () => {
  const body = gifHeader(2, 2);
  const response = new Response(body, { headers: { "content-type": "image/gif" } });

  const image = await downloadImageToTemp(response, "https://example.com/");
  try {
    assert.match(image.path, /image\.gif$/);
  } finally {
    await rm(dirname(image.path), { recursive: true, force: true });
  }
});

// ── httpFetch integration ───────────────────────────────

test("httpFetch: downloads a direct image URL to a local path", async () => {
  const originalFetch = globalThis.fetch;
  let downloadPath: string | undefined;
  try {
    globalThis.fetch = async () => new Response(jpegHeader(800, 600), {
      headers: { "content-type": "image/jpeg" },
    });

    const result = await httpFetch("https://example.com/photo.jpg", {
      allowPrivateNetworks: true,
      socksProxy: null,
    });
    downloadPath = result.artifacts?.imageDownload;

    assert.equal(result.error, null);
    assert.match(result.content, /Downloaded image to: /);
    assert.match(result.content, /Type: image\/jpeg/);
    assert.match(result.content, /Dimensions: 800x600/);
    assert.match(result.content, /read tool/);
    assert.equal(typeof downloadPath, "string");
  } finally {
    globalThis.fetch = originalFetch;
    if (downloadPath) await rm(dirname(downloadPath), { recursive: true, force: true });
  }
});

test("httpFetch: unsupported image format returns a URL-only note, not an error", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      pull() {},
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "image/avif" } });

    const result = await httpFetch("https://example.com/photo.avif", {
      allowPrivateNetworks: true,
      socksProxy: null,
    });

    assert.equal(result.error, null);
    assert.match(result.content, /image\/avif cannot be displayed/);
    assert.match(result.content, /https:\/\/example\.com\/photo\.avif/);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("httpFetch: image content-type detection is case-insensitive", async () => {
  const originalFetch = globalThis.fetch;
  let downloadPath: string | undefined;
  try {
    globalThis.fetch = async () => new Response(pngHeader(2, 2), {
      headers: { "content-type": "Image/PNG" },
    });

    const result = await httpFetch("https://example.com/upper.png", {
      allowPrivateNetworks: true,
      socksProxy: null,
    });
    downloadPath = result.artifacts?.imageDownload;

    assert.equal(result.error, null);
    assert.match(result.content, /Downloaded image to: /);
  } finally {
    globalThis.fetch = originalFetch;
    if (downloadPath) await rm(dirname(downloadPath), { recursive: true, force: true });
  }
});

test("httpFetch: oversized image surfaces a size-limit error", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(pngHeader(1, 1), {
      headers: {
        "content-type": "image/png",
        "content-length": String(MAX_IMAGE_BYTES + 1),
      },
    });

    const result = await httpFetch("https://example.com/huge.png", {
      allowPrivateNetworks: true,
      socksProxy: null,
    });

    assert.match(result.error ?? "", /exceeds the 10 MiB limit/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
