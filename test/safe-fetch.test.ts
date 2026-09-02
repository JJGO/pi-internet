import assert from "node:assert/strict";
import test from "node:test";
import { safeFetch, validateUserUrl, type UrlLookup } from "../src/util/safe-fetch.ts";

const publicLookup: UrlLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("validateUserUrl blocks local names, private literals, and private DNS answers", async () => {
  await assert.rejects(validateUserUrl("http://localhost/"), /Blocked local hostname/);
  await assert.rejects(validateUserUrl("http://127.1/"), /Blocked private or reserved address/);
  await assert.rejects(validateUserUrl("http://[::1]/"), /Blocked private or reserved address/);
  await assert.rejects(validateUserUrl("file:///etc/passwd"), /Unsupported URL scheme/);
  await assert.rejects(validateUserUrl("https://user:secret@example.com/", { lookup: publicLookup }), /embedded credentials/);
  await assert.rejects(validateUserUrl("https://example.test/", {
    lookup: async () => [{ address: "192.168.1.20", family: 4 }],
  }), /Blocked private or reserved address/);
});

test("validateUserUrl allows local development only through the explicit opt-in", async () => {
  const url = await validateUserUrl("http://127.0.0.1:3000/", { allowPrivateNetworks: true });
  assert.equal(url.href, "http://127.0.0.1:3000/");
});

test("safeFetch validates redirect targets before requesting them", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  try {
    globalThis.fetch = async (input) => {
      requested.push(input.toString());
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
    };

    await assert.rejects(
      safeFetch("https://example.test/start", {}, { socksProxy: null, lookup: publicLookup }),
      /Blocked private or reserved address/,
    );
    assert.deepEqual(requested, ["https://example.test/start"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("safeFetch follows public redirects manually and strips cross-origin credentials", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  try {
    globalThis.fetch = async (input, init) => {
      requests.push({ url: input.toString(), init });
      if (requests.length === 1) {
        return new Response(null, { status: 302, headers: { location: "https://other.test/final" } });
      }
      return new Response("ok", { status: 200 });
    };

    const response = await safeFetch("https://example.test/start", {
      method: "POST",
      body: "payload",
      headers: { authorization: "Bearer secret", cookie: "session=secret", "content-type": "text/plain" },
    }, { socksProxy: null, lookup: publicLookup });

    assert.equal(await response.text(), "ok");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, "https://other.test/final");
    assert.equal(requests[1].init?.method, "GET");
    const headers = new Headers(requests[1].init?.headers);
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);
    assert.equal(headers.has("content-type"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
