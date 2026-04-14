import assert from "node:assert/strict";
import test from "node:test";
import { __test__ } from "../src/config.ts";

const { mergeWithDefaults, mergeObjects } = __test__;

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

test("mergeWithDefaults: applies defaults and normalizes valid values", () => {
  const config = withEnv({
    PI_INTERNET_REDLIB_PROXY: undefined,
    PI_INTERNET_NITTER_PROXY: undefined,
  }, () => mergeWithDefaults({
    searchProviders: ["brave"],
    reddit: { commentDepth: 2 },
    fetch: { includeLinks: true, timeoutMs: 1234 },
  }));

  assert.deepEqual(config.searchProviders, ["brave"]);
  assert.deepEqual(config.fallbackProviders, ["tavily"]);
  assert.equal(config.reddit.commentDepth, 2);
  assert.equal(config.reddit.proxyHost, null);
  assert.equal(config.fetch.includeLinks, true);
  assert.equal(config.fetch.timeoutMs, 1234);
  assert.equal(config.github.enabled, true);
});

test("mergeWithDefaults: invalid values fall back to defaults", () => {
  const config = withEnv({
    PI_INTERNET_REDLIB_PROXY: undefined,
    PI_INTERNET_NITTER_PROXY: undefined,
  }, () => mergeWithDefaults({
    searchProviders: [],
    reddit: { commentDepth: -1, rateLimitMs: 0 },
    github: { enabled: "yes", maxRepoSizeMB: NaN },
    fetch: { includeLinks: "true", timeoutMs: -50 },
  } as unknown as Record<string, unknown>));

  assert.deepEqual(config.searchProviders, ["brave", "kagi"]);
  assert.equal(config.reddit.commentDepth, 4);
  assert.equal(config.reddit.rateLimitMs, 1000);
  assert.equal(config.github.enabled, true);
  assert.equal(config.github.maxRepoSizeMB, 350);
  assert.equal(config.fetch.includeLinks, false);
  assert.equal(config.fetch.timeoutMs, 30000);
});

test("mergeWithDefaults: social proxy env vars override config", () => {
  const config = withEnv({
    PI_INTERNET_REDLIB_PROXY: "redlib.internal.example",
    PI_INTERNET_NITTER_PROXY: "nitter.internal.example",
  }, () => mergeWithDefaults({
    reddit: { proxyHost: "ignored.example" },
    twitter: { proxyHost: "also-ignored.example" },
  }));

  assert.equal(config.reddit.proxyHost, "redlib.internal.example");
  assert.equal(config.twitter.proxyHost, "nitter.internal.example");
});

test("mergeObjects: recursively merges nested config objects", () => {
  const merged = mergeObjects(
    {
      reddit: { commentDepth: 4, proxyHost: "redlib-default.example" },
      fetch: { includeLinks: false, timeoutMs: 30000 },
    },
    {
      reddit: { proxyHost: "redlib.example" },
      fetch: { timeoutMs: 5000 },
    },
  );

  assert.deepEqual(merged, {
    reddit: { commentDepth: 4, proxyHost: "redlib.example" },
    fetch: { includeLinks: false, timeoutMs: 5000 },
  });
});
