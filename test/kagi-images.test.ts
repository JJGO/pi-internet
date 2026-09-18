import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  KAGI_IMAGES_PARSE_GUIDANCE,
  parseKagiImageResults,
  searchKagiImages,
} from "../src/search/providers/kagi-images.ts";
import { formatImageResults, runImageSearch } from "../src/search/image-search.ts";
import piInternet from "../src/index.ts";

const FIXTURE_PATH = join(import.meta.dirname, "fixtures", "kagi-images.html");

async function loadFixture(): Promise<string> {
  return readFile(FIXTURE_PATH, "utf8");
}

function withKagiToken<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.KAGI_SESSION_TOKEN;
  process.env.KAGI_SESSION_TOKEN = "test-token";
  return fn().finally(() => {
    if (previous === undefined) delete process.env.KAGI_SESSION_TOKEN;
    else process.env.KAGI_SESSION_TOKEN = previous;
  });
}

// A 1x1 GIF — a valid readable-format thumbnail body.
const GIF_BODY = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

// ── parseKagiImageResults ───────────────────────────────

test("parseKagiImageResults: extracts structured results from the fixture", async () => {
  const results = parseKagiImageResults(await loadFixture(), 10);

  assert.equal(results.length, 3);
  const first = results[0];
  assert.equal(first.title, "Terra Cotta Golden Gate Bridge – LNNXD");
  assert.equal(first.pageUrl, "https://landesturnfest-freiburg.de/terra-cotta-golden-gate-bridge/");
  assert.equal(first.imageUrl, "https://i.redd.it/fqvf5108v9a21.jpg");
  assert.equal(first.width, 6716);
  assert.equal(first.height, 4477);
  assert.equal(first.published, "Aug 21, 2025");
  assert.match(first.thumbnailUrl ?? "", /^https:\/\/p\.kagi\.com\/proxy\//);
});

test("parseKagiImageResults: respects the limit", async () => {
  const results = parseKagiImageResults(await loadFixture(), 2);
  assert.equal(results.length, 2);
});

test("parseKagiImageResults: returns empty for a page without image items", () => {
  const html = "<html><body><div class='_0_main-search-results'></div></body></html>";
  assert.deepEqual(parseKagiImageResults(html, 10), []);
});

test("parseKagiImageResults: skips items missing page or image URL", () => {
  const html = `<html><body>
    <div class="item _0_image_item" data-title="No URLs"></div>
    <div class="item _0_image_item" data-title="Valid" data-host_url="https://a.test/p" data-content_url="https://a.test/i.jpg"></div>
  </body></html>`;
  const results = parseKagiImageResults(html, 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Valid");
});

// ── searchKagiImages ────────────────────────────────────

test("searchKagiImages: requires a Kagi session token", async () => {
  const previous = process.env.KAGI_SESSION_TOKEN;
  delete process.env.KAGI_SESSION_TOKEN;
  try {
    await assert.rejects(
      searchKagiImages({ query: "bridge", numResults: 5 }),
      /kagi-login/,
    );
  } finally {
    if (previous !== undefined) process.env.KAGI_SESSION_TOKEN = previous;
  }
});

test("searchKagiImages: zero parsed results on a 200 page throws parse guidance", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("<html><body><p>something else</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });

    await withKagiToken(() =>
      assert.rejects(
        searchKagiImages({ query: "bridge", numResults: 5, socksProxy: null }),
        (error: Error) => {
          assert.equal(error.message, KAGI_IMAGES_PARSE_GUIDANCE);
          assert.match(error.message, /tell the user/);
          return true;
        },
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("searchKagiImages: redirect (Turnstile bot check) is classified as an auth failure", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    };

    await withKagiToken(() =>
      assert.rejects(
        searchKagiImages({ query: "bridge", numResults: 5, socksProxy: null }),
        /session token is likely invalid or expired.*kagi-login/s,
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("searchKagiImages: 403 maps to an auth error", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("forbidden", { status: 403 });

    await withKagiToken(() =>
      assert.rejects(
        searchKagiImages({ query: "bridge", numResults: 5, socksProxy: null }),
        /Invalid or expired Kagi session token/,
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── runImageSearch (thumbnail downloads) ────────────────

test("runImageSearch: downloads thumbnails and degrades failures to URL-only rows", async () => {
  const fixture = await loadFixture();
  const originalFetch = globalThis.fetch;
  let thumbnailDir: string | undefined;
  let thumbRequests = 0;

  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://kagi.com/html/images")) {
        return new Response(fixture, { status: 200, headers: { "content-type": "text/html" } });
      }
      thumbRequests++;
      if (thumbRequests === 2) return new Response("nope", { status: 404 });
      return new Response(Buffer.from(GIF_BODY), { status: 200, headers: { "content-type": "image/gif" } });
    };

    const outcome = await withKagiToken(() =>
      runImageSearch({ query: "golden gate bridge", numResults: 3, socksProxy: null }),
    );
    thumbnailDir = outcome.thumbnailDir;

    assert.equal(outcome.provider, "kagi");
    assert.equal(outcome.results.length, 3);
    assert.equal(outcome.downloadedCount, 2);
    assert.equal(typeof thumbnailDir, "string");

    const downloaded = outcome.results.filter((r) => r.thumbnailPath);
    assert.equal(downloaded.length, 2);
    for (const row of downloaded) {
      assert.match(row.thumbnailPath!, /image-\d+\.gif$/);
      assert.deepEqual(await readFile(row.thumbnailPath!), GIF_BODY);
    }

    const failed = outcome.results.find((r) => !r.thumbnailPath);
    assert.ok(failed?.thumbnailUrl, "failed row keeps its thumbnail URL");

    const text = formatImageResults(outcome);
    assert.match(text, /Downloaded 2 thumbnail\(s\)/);
    assert.match(text, /read tool/);
    assert.match(text, /## 1\. Terra Cotta Golden Gate Bridge/);
    assert.match(text, /6716x4477/);
    assert.match(text, /- Page: https:\/\/landesturnfest-freiburg\.de/);
    assert.match(text, /- Full image: https:\/\/i\.redd\.it/);
    assert.match(text, /- Thumbnail: \S+image-\d+\.gif/);
    assert.match(text, /- Thumbnail \(not downloaded\): https:\/\/p\.kagi\.com/);
  } finally {
    globalThis.fetch = originalFetch;
    if (thumbnailDir) await rm(thumbnailDir, { recursive: true, force: true });
  }
});

test("runImageSearch: non-image thumbnail content type is not written to disk", async () => {
  const fixture = await loadFixture();
  const originalFetch = globalThis.fetch;
  let thumbnailDir: string | undefined;

  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://kagi.com/html/images")) {
        return new Response(fixture, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("<html>block page</html>", { status: 200, headers: { "content-type": "text/html" } });
    };

    const outcome = await withKagiToken(() =>
      runImageSearch({ query: "golden gate bridge", numResults: 2, socksProxy: null }),
    );
    thumbnailDir = outcome.thumbnailDir;

    assert.equal(outcome.downloadedCount, 0);
    assert.equal(outcome.thumbnailDir, undefined);
    assert.ok(outcome.results.every((r) => !r.thumbnailPath));
  } finally {
    globalThis.fetch = originalFetch;
    if (thumbnailDir) await rm(thumbnailDir, { recursive: true, force: true });
  }
});

// ── Tool registration gating ────────────────────────────

interface CapturedExtension {
  tools: string[];
  commands: Map<string, { handler(args: string, ctx: unknown): Promise<void> }>;
  activeTools: string[];
}

function loadExtension(): CapturedExtension {
  const captured: CapturedExtension = { tools: [], commands: new Map(), activeTools: [] };
  piInternet({
    on() {},
    registerTool(tool: { name: string }) { captured.tools.push(tool.name); },
    registerCommand(name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) {
      captured.commands.set(name, command);
    },
    getActiveTools() { return captured.activeTools; },
    setActiveTools(names: string[]) { captured.activeTools = names; },
  } as never);
  return captured;
}

test("image_search: hidden by default, registered when PI_INTERNET_IMAGESEARCH=1", () => {
  const previous = process.env.PI_INTERNET_IMAGESEARCH;
  try {
    delete process.env.PI_INTERNET_IMAGESEARCH;
    assert.ok(!loadExtension().tools.includes("image_search"));

    process.env.PI_INTERNET_IMAGESEARCH = "1";
    assert.ok(loadExtension().tools.includes("image_search"));
  } finally {
    if (previous === undefined) delete process.env.PI_INTERNET_IMAGESEARCH;
    else process.env.PI_INTERNET_IMAGESEARCH = previous;
  }
});

test("image_search: /image-search toggles registration and active state", async () => {
  const previous = process.env.PI_INTERNET_IMAGESEARCH;
  try {
    delete process.env.PI_INTERNET_IMAGESEARCH;
    const extension = loadExtension();
    assert.ok(!extension.tools.includes("image_search"));

    const notifications: string[] = [];
    const ctx = { ui: { notify(message: string) { notifications.push(message); } } };

    await extension.commands.get("image-search")!.handler("", ctx);
    assert.ok(extension.tools.includes("image_search"));
    assert.ok(extension.activeTools.includes("image_search"));
    assert.match(notifications[0], /enabled/);

    await extension.commands.get("image-search")!.handler("", ctx);
    assert.ok(!extension.activeTools.includes("image_search"));
    assert.match(notifications[1], /disabled/);
  } finally {
    if (previous === undefined) delete process.env.PI_INTERNET_IMAGESEARCH;
    else process.env.PI_INTERNET_IMAGESEARCH = previous;
  }
});
