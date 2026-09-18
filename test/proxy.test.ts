import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { Readable } from "node:stream";
import { channel } from "node:diagnostics_channel";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { listen, startSocksServer } from "./helpers/socks-server.ts";
import { fetchWithProxy, resetSocksProxyDispatchers, __test__ } from "../src/util/proxy.ts";
import { safeFetch } from "../src/util/safe-fetch.ts";
import { readResponseBuffer } from "../src/util/download.ts";

const { applySocksProxyEnv, parseSocksProxyUrl, resolveSocksProxy } = __test__;

function withEnv<T>(entries: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("parseSocksProxyUrl: parses socks5h URLs with auth", () => {
  const parsed = parseSocksProxyUrl("socks5h://user:pass@127.0.0.1:25344");
  assert.equal(parsed.protocol, "socks5h:");
  assert.equal(parsed.type, 5);
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 25344);
  assert.equal(parsed.userId, "user");
  assert.equal(parsed.password, "pass");
});

test("parseSocksProxyUrl: rejects unsupported protocols", () => {
  assert.throws(
    () => parseSocksProxyUrl("http://127.0.0.1:8080"),
    /Unsupported SOCKS proxy protocol/,
  );
});

test("resolveSocksProxy: explicit null disables proxy without consulting config", () => {
  const proxy = withEnv({ PI_INTERNET_SOCKS_PROXY: "socks5h://127.0.0.1:25344" }, () => (
    resolveSocksProxy({ socksProxy: null })
  ));

  assert.equal(proxy, null);
});

test("applySocksProxyEnv: sets curl-compatible env vars when enabled", () => {
  const env = applySocksProxyEnv({ PATH: process.env.PATH }, { socksProxy: "socks5h://127.0.0.1:25344" });
  assert.equal(env.ALL_PROXY, "socks5h://127.0.0.1:25344");
  assert.equal(env.all_proxy, "socks5h://127.0.0.1:25344");
  assert.ok(env.PATH);
});

test("fetchWithProxy: leaves dispatcher unset when proxy is disabled", async () => {
  const originalFetch = globalThis.fetch;
  let seenInit: RequestInit | undefined;

  try {
    globalThis.fetch = async (_input, init) => {
      seenInit = init;
      return new Response("ok", { status: 200 });
    };

    await fetchWithProxy("https://example.com", { method: "GET" }, { socksProxy: null });

    assert.equal((seenInit as RequestInit & { dispatcher?: unknown })?.dispatcher, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    await resetSocksProxyDispatchers();
  }
});

test("fetchWithProxy: connects to the pinned address without re-resolving the hostname", async (t) => {
  const server = createServer((_request, response) => response.end("pinned"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await resetSocksProxyDispatchers();
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  const response = await fetchWithProxy(`http://does-not-resolve.invalid:${address.port}/`, {}, {
    socksProxy: null,
    connection: { hostname: "does-not-resolve.invalid", address: "127.0.0.1", family: 4 },
  });
  assert.equal(await response.text(), "pinned");
});

test("fetchWithProxy: attaches an undici dispatcher when proxy is enabled", async () => {
  const originalFetch = globalThis.fetch;
  let seenInit: (RequestInit & { dispatcher?: unknown }) | undefined;

  try {
    globalThis.fetch = async (_input, init) => {
      seenInit = init as RequestInit & { dispatcher?: unknown };
      return new Response("ok", { status: 200 });
    };

    await fetchWithProxy("https://example.com", { method: "GET" }, { socksProxy: "socks5h://127.0.0.1:25344" });

    assert.ok(seenInit);
    assert.equal(seenInit?.method, "GET");
    assert.ok(seenInit?.dispatcher);
  } finally {
    globalThis.fetch = originalFetch;
    await resetSocksProxyDispatchers();
  }
});

async function withBunTransport(fn: () => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
  const originalFetch = globalThis.fetch;
  Object.defineProperty(process.versions, "bun", { value: "transport-test", configurable: true });
  globalThis.fetch = async () => { throw new Error("Native fetch must not handle Bun dispatcher requests"); };
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(process.versions, "bun", descriptor);
    else delete process.versions.bun;
    await resetSocksProxyDispatchers();
  }
}

test("fetchWithProxy: Bun transport consumes large pinned bodies without native fetch", async (t) => {
  const payload = Buffer.alloc(256 * 1024, 65);
  const server = createServer((request, response) => {
    assert.match(request.headers.host ?? "", /^does-not-resolve\.invalid:/);
    response.end(payload);
  });
  const port = await listen(server);
  t.after(() => server.close());
  await withBunTransport(async () => {
    const url = new URL(`http://does-not-resolve.invalid:${port}/image`);
    const result = await fetchWithProxy(url, {}, {
      socksProxy: null,
      connection: { hostname: url.hostname, address: "127.0.0.1", family: 4 },
    });
    assert.equal(result.url, url.href);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), payload);
  });
});

test("fetchWithProxy: SOCKS transmits pinned addresses and unpinned hostnames on Node and Bun", async (t) => {
  const payload = Buffer.alloc(192 * 1024, 66);
  const server = createServer((_req, response) => response.end(payload));
  const port = await listen(server);
  const socks = await startSocksServer();
  t.after(async () => { await socks.close(); server.close(); });
  const run = async () => {
    for (const pinned of [false, true]) {
      const result = await fetchWithProxy(`http://destination.invalid:${port}/`, {}, {
        socksProxy: socks.url,
        ...(pinned ? { connection: { hostname: "destination.invalid", address: "127.0.0.1", family: 4 as const } } : {}),
      });
      assert.deepEqual(Buffer.from(await result.arrayBuffer()), payload);
      assert.deepEqual(socks.destinations.at(-1), { host: pinned ? "127.0.0.1" : "destination.invalid", port });
    }
  };
  await run();
  await resetSocksProxyDispatchers();
  await withBunTransport(run);
});

test("fetchWithProxy: rejected SOCKS connections fail without direct fallback", async (t) => {
  let directRequests = 0;
  const server = createServer((_req, res) => { directRequests++; res.end("must not reach"); });
  const port = await listen(server);
  const socks = await startSocksServer(true);
  t.after(async () => { await socks.close(); server.close(); });
  await withBunTransport(async () => {
    await assert.rejects(fetchWithProxy(`http://127.0.0.1:${port}/`, {}, { socksProxy: socks.url }));
    assert.equal(directRequests, 0);
  });
});

test("fetchWithProxy: Bun transport decompresses gzip and preserves native Request fields", async (t) => {
  const payload = Buffer.alloc(200 * 1024, 67);
  const server = createServer(async (req, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.method, "POST");
    assert.equal(req.headers["x-test"], "kept");
    assert.equal(Buffer.concat(chunks).toString(), "request body");
    const compressed = gzipSync(payload);
    response.writeHead(200, { "content-encoding": "gzip", "content-length": compressed.length });
    response.end(compressed);
  });
  const port = await listen(server);
  t.after(() => server.close());
  await withBunTransport(async () => {
    const req = new Request(`http://test.invalid:${port}/`, { method: "POST", headers: { "x-test": "kept" }, body: "request body" });
    const result = await fetchWithProxy(req, {}, {
      socksProxy: null, connection: { hostname: "test.invalid", address: "127.0.0.1", family: 4 },
    });
    assert.equal(result.headers.get("content-encoding"), null);
    assert.equal(result.headers.get("content-length"), null);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), payload);
  });
});

test("fetchWithProxy: Node and Bun use the same single-hop redirect contract", async (t) => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    res.writeHead(req.url === "/choices" ? 300 : 302, { location: "/unexpected-follow" });
    res.end();
  });
  const port = await listen(server);
  t.after(() => server.close());
  const options = { socksProxy: null, connection: { hostname: "127.0.0.1", address: "127.0.0.1", family: 4 as const } };
  const url = `http://127.0.0.1:${port}/`;
  const run = async () => {
    const before = requests;
    await assert.rejects(fetchWithProxy(url, { redirect: "follow" }, options), /use safeFetch/);
    assert.equal(requests, before, "explicit follow must fail before sending a request");
    for (const input of [url, new Request(url), new Request(url, { redirect: "error" })]) {
      await assert.rejects(fetchWithProxy(input, {}, options), /fetch failed|Unexpected redirect/);
    }
    for (const input of [url, new Request(url, { redirect: "manual" })]) {
      const manual = await fetchWithProxy(input, typeof input === "string" ? { redirect: "manual" } : {}, options);
      assert.equal(manual.status, 302);
      assert.equal(manual.url, url);
      await manual.body?.cancel();
    }
    const choices = await fetchWithProxy(`${url}choices`, {}, options);
    assert.equal(choices.status, 300);
    await choices.body?.cancel();
    assert.equal(requests - before, 6, "no response may cause another low-level request");
  };
  await run();
  await resetSocksProxyDispatchers();
  await withBunTransport(run);
});

test("safeFetch: Bun follows validated hops and preserves redirect method/body rules", async (t) => {
  let destinationRequests = 0;
  const destination = createServer(async (req, res) => {
    destinationRequests++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    res.end(JSON.stringify({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() }));
  });
  const destinationPort = await listen(destination);
  const target = `http://destination.example:${destinationPort}/final`;
  const source = createServer(async (req, res) => {
    for await (const _ of req) { /* consume the original request body */ }
    res.writeHead(req.url === "/307" ? 307 : 302, {
      location: req.url === "/private" ? `http://127.0.0.1:${destinationPort}/blocked` : target,
    });
    res.end();
  });
  const sourcePort = await listen(source);
  const socks = await startSocksServer();
  t.after(async () => { await socks.close(); source.close(); destination.close(); });
  await withBunTransport(async () => {
    const resolved: string[] = [];
    const options = { socksProxy: socks.url, lookup: async (hostname: string) => {
      resolved.push(hostname);
      return [{ address: hostname === "source.example" ? "93.184.216.34" : "93.184.216.35", family: 4 }];
    } };
    for (const status of [302, 307]) {
      const result = await safeFetch(`http://source.example:${sourcePort}/${status}`, {
        method: "POST", body: new Uint8Array([65, 66, 67]),
        headers: { "content-length": "3", "content-type": "text/plain", authorization: "secret", cookie: "session", "proxy-authorization": "proxy-secret" },
      }, options);
      assert.equal(result.url, target);
      const echo = await result.json();
      assert.equal(echo.method, status === 302 ? "GET" : "POST");
      assert.equal(echo.body, status === 302 ? "" : "ABC");
      assert.equal(echo.headers["content-type"], status === 302 ? undefined : "text/plain");
      assert.equal(echo.headers["content-length"], status === 302 ? undefined : "3");
      for (const header of ["authorization", "cookie", "proxy-authorization"]) assert.equal(echo.headers[header], undefined);
    }
    assert.deepEqual(resolved, ["source.example", "destination.example", "source.example", "destination.example"]);
    assert.deepEqual([...new Set(socks.destinations.map(({ host }) => host))], ["93.184.216.34", "93.184.216.35"]);
    await assert.rejects(safeFetch(`http://source.example:${sourcePort}/private`, {}, options), /Blocked private/);
    assert.equal(destinationRequests, 2, "private redirect must not reach the destination");
    assert.ok(socks.destinations.every(({ host }) => host !== "127.0.0.1"));
  });
});

test("fetchWithProxy: Bun cancellation closes a streaming response without buffering all of it", async (t) => {
  let sentBytes = 0;
  let requestClosed: Promise<void>;
  const server = createServer((_req, response) => {
    requestClosed = new Promise<void>((resolve) => response.once("close", resolve));
    response.writeHead(200);
    response.on("error", () => {});
    const timer = setInterval(() => { response.write(Buffer.alloc(32 * 1024)); sentBytes += 32 * 1024; }, 5);
    response.once("close", () => clearInterval(timer));
  });
  const port = await listen(server);
  t.after(() => server.close());
  await withBunTransport(async () => {
    for (const abort of [false, true]) {
      const controller = new AbortController();
      const result = await fetchWithProxy(`http://cancel.invalid:${port}/`, { signal: controller.signal }, {
        socksProxy: null, connection: { hostname: "cancel.invalid", address: "127.0.0.1", family: 4 },
      });
      const closed = requestClosed!;
      const reader = result.body!.getReader();
      assert.equal((await reader.read()).done, false);
      if (abort) {
        controller.abort();
        await assert.rejects(async () => { while (!(await reader.read()).done) {} });
      } else {
        await reader.cancel();
      }
      await closed;
      await resetSocksProxyDispatchers();
    }
    assert.ok(sentBytes < 1024 * 1024, `unexpected buffering: ${sentBytes}`);
  });
});

test("fetchWithProxy: SOCKS TLS preserves SNI, certificate checks and full decoded bodies", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "th_proxy-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const exec = promisify(execFile);
  try {
    await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
      "-subj", "/CN=test.invalid", "-addext", "subjectAltName=DNS:test.invalid",
      "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return t.skip("openssl unavailable for ephemeral TLS certificate");
    throw error;
  }
  const helper = new URL("./helpers/proxy-tls-check.ts", import.meta.url).href;
  for (const bun of [false, true]) {
    await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `${bun ? "Object.defineProperty(process.versions,'bun',{value:'transport-test'});" : ""}
       const {checkProxyTls} = await import(${JSON.stringify(helper)});
       await checkProxyTls(${JSON.stringify(directory)});`], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: join(directory, "cert.pem") },
      timeout: 20_000,
    });
  }
});

test("fetchWithProxy: Bun null bodies bypass decoding and Identity is case-insensitive", async (t) => {
  const server = createServer((req, response) => {
    const path = new URL(req.url!, "http://test/");
    const encoding = path.searchParams.get("encoding") ?? "gzip";
    response.writeHead(Number(path.pathname.slice(1)) || 200, { "content-encoding": encoding });
    response.end(encoding === "Identity" ? "identity body" : undefined);
  });
  const port = await listen(server);
  t.after(() => server.close());
  await withBunTransport(async () => {
    const options = { socksProxy: null, connection: { hostname: "empty.invalid", address: "127.0.0.1", family: 4 as const } };
    const url = `http://empty.invalid:${port}`;
    for (const [status, method] of [[204, "GET"], [205, "GET"], [304, "GET"], [200, "HEAD"]] as const) {
      for (const encoding of ["gzip", "unknown-compression"]) {
        const result = await fetchWithProxy(`${url}/${status}?encoding=${encoding}`, { method }, options);
        assert.equal(result.status, status);
        assert.equal(result.body, null);
        assert.equal(result.headers.get("content-encoding"), encoding);
      }
    }
    const identity = await fetchWithProxy(`${url}/200?encoding=Identity`, {}, options);
    assert.equal(await identity.text(), "identity body");
    assert.equal(identity.headers.get("content-encoding"), "Identity", "undecoded headers stay intact");
    await assert.rejects(fetchWithProxy(`${url}/200?encoding=unknown-compression`, {}, options), /Unsupported response encoding/);
  });
});

test("fetchWithProxy: compressed queues stay bounded and stop after network completion", { timeout: 10_000 }, async (t) => {
  const compressed = gzipSync(Buffer.alloc(32 * 1024 * 1024));
  const server = createServer((_req, response) => {
    response.writeHead(200, { "content-encoding": "gzip", "content-length": compressed.length });
    response.end(compressed);
  });
  const port = await listen(server);
  t.after(() => server.close());
  const originalToWeb = Readable.toWeb;
  let decoded: Readable | undefined;
  Readable.toWeb = ((stream, options) => {
    decoded = stream;
    return originalToWeb(stream, options);
  }) as typeof Readable.toWeb;
  t.after(() => { Readable.toWeb = originalToWeb; });
  await withBunTransport(async () => {
    for (const mode of ["cancel", "abort", "limit"]) {
      const trailers = channel("undici:request:trailers");
      let listener: (message: unknown) => void;
      const networkComplete = new Promise<void>((resolve) => {
        listener = (message) => {
          if ((message as { request: { path: string } }).request.path === `/${mode}`) resolve();
        };
        trailers.subscribe(listener);
      });
      const controller = new AbortController();
      let response: Response | undefined;
      try {
        response = await fetchWithProxy(`http://compressed.invalid:${port}/${mode}`, { signal: controller.signal }, {
          socksProxy: null, connection: { hostname: "compressed.invalid", address: "127.0.0.1", family: 4 },
        });
        await networkComplete; // Abort must work even after Undici stops watching the network signal.
        await delay(50);
        assert.ok(decoded);
        assert.ok(decoded.readableLength <= decoded.readableHighWaterMark + 16 * 1024,
          `unbounded no-reader queue: ${decoded.readableLength}`);
        assert.equal(response.headers.get("content-length"), null);
        if (mode === "cancel") {
          const reader = response.body!.getReader();
          assert.equal((await reader.read()).done, false);
          await delay(30); // Slow consumer must not allow the inflater to run ahead.
          assert.ok(decoded.readableLength <= decoded.readableHighWaterMark + 16 * 1024);
          await reader.cancel();
          reader.releaseLock();
        } else if (mode === "abort") {
          controller.abort();
          await assert.rejects(response.arrayBuffer(), /abort/i);
        } else {
          await assert.rejects(readResponseBuffer(response, 128 * 1024), /exceeds the 131072 B limit/);
        }
        await delay(0);
        assert.equal(decoded.destroyed, true, `${mode} must destroy the decoder after the network ends`);
      } finally {
        trailers.unsubscribe(listener!);
        controller.abort();
        await response?.body?.cancel().catch(() => {});
        decoded?.destroy();
      }
    }
  });
});

test("fetchWithProxy: Bun decoding reverses encoding order and rejects invalid chains", async (t) => {
  const payload = Buffer.alloc(200 * 1024, 69);
  const server = createServer((req, response) => {
    const encoding = req.url === "/stacked" ? "gzip, br"
      : req.url === "/too-many" ? Array(6).fill("gzip").join(", ") : "gzip";
    const bytes = req.url === "/stacked" ? brotliCompressSync(gzipSync(payload)) : Buffer.from("invalid compressed body");
    response.writeHead(200, { "content-encoding": encoding, "content-length": bytes.length });
    response.end(bytes);
  });
  const port = await listen(server);
  t.after(() => server.close());
  await withBunTransport(async () => {
    const options = { socksProxy: null, connection: { hostname: "encoding.invalid", address: "127.0.0.1", family: 4 as const } };
    const base = `http://encoding.invalid:${port}`;
    const stacked = await fetchWithProxy(`${base}/stacked`, {}, options);
    assert.deepEqual(Buffer.from(await stacked.arrayBuffer()), payload);
    assert.equal(stacked.headers.get("content-encoding"), null);
    assert.equal(stacked.headers.get("content-length"), null);
    await assert.rejects(fetchWithProxy(`${base}/too-many`, {}, options), /Too many response content encodings/);
    const corrupt = await fetchWithProxy(`${base}/corrupt`, {}, options);
    await assert.rejects(corrupt.arrayBuffer(), (error: Error) => /header|compression|decompress/i.test(`${error.message} ${error.cause}`));
  });
});
