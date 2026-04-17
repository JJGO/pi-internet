import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithProxy, resetSocksProxyDispatchers, __test__ } from "../src/util/proxy.ts";

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
