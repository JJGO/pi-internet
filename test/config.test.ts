import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { loadConfig, __test__ } from "../src/config.ts";

const { mergeWithDefaults, mergeObjects, normalizeProxyHost } = __test__;

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
    PI_INTERNET_SOCKS_PROXY: undefined,
  }, () => mergeWithDefaults({
    searchProviders: ["brave"],
    reddit: { commentDepth: 2 },
    github: { refreshTtlMs: 12345 },
    fetch: { includeLinks: true, timeoutMs: 1234, socksProxy: "socks5h://127.0.0.1:25344" },
  }));

  assert.deepEqual(config.searchProviders, ["brave"]);
  assert.deepEqual(config.fallbackProviders, ["tavily"]);
  assert.equal(config.reddit.commentDepth, 2);
  assert.equal(config.reddit.proxyHost, null);
  assert.equal(config.fetch.includeLinks, true);
  assert.equal(config.fetch.timeoutMs, 1234);
  assert.equal(config.fetch.socksProxy, "socks5h://127.0.0.1:25344");
  assert.equal(config.fetch.allowPrivateNetworks, false);
  assert.equal(config.github.enabled, true);
  assert.equal(config.github.refreshTtlMs, 12345);
  assert.equal(config.pdf.converter, "auto");
});

test("mergeWithDefaults: pdf.converter accepts known values and rejects unknown ones", () => {
  const env = {
    PI_INTERNET_REDLIB_PROXY: undefined,
    PI_INTERNET_NITTER_PROXY: undefined,
    PI_INTERNET_SOCKS_PROXY: undefined,
  };
  const valid = withEnv(env, () => mergeWithDefaults({ pdf: { converter: "pdftotext" } }));
  assert.equal(valid.pdf.converter, "pdftotext");
  const invalid = withEnv(env, () => mergeWithDefaults({ pdf: { converter: "marker" } }));
  assert.equal(invalid.pdf.converter, "auto");
});

test("mergeWithDefaults: invalid values fall back to defaults", () => {
  const config = withEnv({
    PI_INTERNET_REDLIB_PROXY: undefined,
    PI_INTERNET_NITTER_PROXY: undefined,
    PI_INTERNET_SOCKS_PROXY: undefined,
  }, () => mergeWithDefaults({
    searchProviders: [],
    reddit: { commentDepth: -1, rateLimitMs: 0 },
    github: { enabled: "yes", maxRepoSizeMB: NaN },
    fetch: { includeLinks: "true", timeoutMs: -50, socksProxy: 1234 },
  } as unknown as Record<string, unknown>));

  assert.deepEqual(config.searchProviders, ["brave", "kagi"]);
  assert.equal(config.reddit.commentDepth, 4);
  assert.equal(config.reddit.rateLimitMs, 1000);
  assert.equal(config.github.enabled, true);
  assert.equal(config.github.maxRepoSizeMB, 350);
  assert.equal(config.github.refreshTtlMs, 300000);
  assert.equal(config.fetch.includeLinks, true);
  assert.equal(config.fetch.timeoutMs, 30000);
  assert.equal(config.fetch.socksProxy, null);
  assert.equal(config.fetch.allowPrivateNetworks, false);
});

test("mergeWithDefaults: proxy env vars override config", () => {
  const config = withEnv({
    PI_INTERNET_REDLIB_PROXY: "redlib.internal.example",
    PI_INTERNET_NITTER_PROXY: "nitter.internal.example",
    PI_INTERNET_SOCKS_PROXY: "socks5h://127.0.0.1:25344",
  }, () => mergeWithDefaults({
    reddit: { proxyHost: "ignored.example" },
    twitter: { proxyHost: "also-ignored.example" },
    fetch: { socksProxy: "socks5://10.0.0.1:1080" },
  }));

  assert.equal(config.reddit.proxyHost, "redlib.internal.example");
  assert.equal(config.twitter.proxyHost, "nitter.internal.example");
  assert.equal(config.fetch.socksProxy, "socks5h://127.0.0.1:25344");
});

test("normalizeProxyHost: accepts hostnames and full URLs", () => {
  assert.equal(normalizeProxyHost("Redlib.EXAMPLE"), "redlib.example");
  assert.equal(normalizeProxyHost("https://redlib.example:8443/"), "redlib.example:8443");
});

test("loadConfig reads project settings only for trusted projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-internet-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      piInternet: { fetch: { timeoutMs: 1111 } },
    }));
    await writeFile(join(cwd, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({
      piInternet: { fetch: { timeoutMs: 2222, allowPrivateNetworks: true } },
    }));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const untrusted = loadConfig({ cwd, isProjectTrusted: () => false });
    assert.equal(untrusted.fetch.timeoutMs, 1111);
    assert.equal(untrusted.fetch.allowPrivateNetworks, false);

    const trusted = loadConfig({ cwd, isProjectTrusted: () => true });
    assert.equal(trusted.fetch.timeoutMs, 2222);
    assert.equal(trusted.fetch.allowPrivateNetworks, true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
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
