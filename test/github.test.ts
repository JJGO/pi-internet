import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PiInternetConfig } from "../src/config.ts";
import { fetchGitHub, clearCloneCache, parseGitHubUrl } from "../src/fetch/github.ts";
import { fetchUrl } from "../src/fetch/router.ts";

function makeConfig(clonePath: string): PiInternetConfig {
  return {
    searchProviders: [],
    fallbackProviders: [],
    reddit: {
      commentDepth: 4,
      proxyHost: null,
      rateLimitMs: 1000,
    },
    twitter: {
      proxyHost: null,
      rateLimitMs: 1000,
    },
    github: {
      enabled: true,
      maxRepoSizeMB: 350,
      clonePath,
    },
    youtube: {
      enabled: true,
    },
    fetch: {
      includeLinks: false,
      timeoutMs: 30_000,
    },
  };
}

test("parseGitHubUrl: repo root", () => {
  const r = parseGitHubUrl("https://github.com/user/repo");
  assert.deepEqual(r, { owner: "user", repo: "repo", type: "root" });
});

test("parseGitHubUrl: repo root with .git suffix", () => {
  const r = parseGitHubUrl("https://github.com/user/repo.git");
  assert.deepEqual(r, { owner: "user", repo: "repo", type: "root" });
});

test("parseGitHubUrl: blob URL", () => {
  const r = parseGitHubUrl("https://github.com/user/repo/blob/main/src/index.ts");
  assert.equal(r?.type, "blob");
  assert.equal(r?.ref, "main");
  assert.equal(r?.path, "src/index.ts");
});

test("parseGitHubUrl: tree URL", () => {
  const r = parseGitHubUrl("https://github.com/user/repo/tree/main/src");
  assert.equal(r?.type, "tree");
  assert.equal(r?.ref, "main");
  assert.equal(r?.path, "src");
});

test("parseGitHubUrl: incomplete tree URL falls back to repo root", () => {
  const r = parseGitHubUrl("https://github.com/user/repo/tree");
  assert.deepEqual(r, { owner: "user", repo: "repo", type: "root" });
});

test("parseGitHubUrl: non-code segments return null", () => {
  assert.equal(parseGitHubUrl("https://github.com/user/repo/issues"), null);
  assert.equal(parseGitHubUrl("https://github.com/user/repo/pull/123"), null);
  assert.equal(parseGitHubUrl("https://github.com/user/repo/actions"), null);
});

test("parseGitHubUrl: non-GitHub URL returns null", () => {
  assert.equal(parseGitHubUrl("https://gitlab.com/user/repo"), null);
});

test("parseGitHubUrl: too few segments returns null", () => {
  assert.equal(parseGitHubUrl("https://github.com/user"), null);
});

test("parseGitHubUrl: www.github.com works", () => {
  const r = parseGitHubUrl("https://www.github.com/user/repo");
  assert.equal(r?.owner, "user");
  assert.equal(r?.repo, "repo");
});

test("parseGitHubUrl: URL-encoded path segments decoded", () => {
  const r = parseGitHubUrl("https://github.com/user/repo/blob/main/dir%20name/file.ts");
  assert.equal(r?.path, "dir name/file.ts");
});

test("fetchGitHub: bare repo includes README before structure", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-internet-github-"));
  const originalFetch = globalThis.fetch;

  try {
    const repoPath = join(tempRoot, "user", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, "README.md"), "# Hello from README\n\nThis should come first.");
    writeFileSync(join(repoPath, "src.ts"), "export const ok = true;\n");

    globalThis.fetch = async () => new Response(JSON.stringify({ size: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    clearCloneCache();
    const result = await fetchGitHub("https://github.com/user/repo", makeConfig(tempRoot));

    assert.ok(result);
    assert.equal(result?.error, null);
    assert.ok(result?.content.includes("## README.md"));
    assert.ok(result?.content.includes("## Structure"));
    assert.ok(result!.content.indexOf("## README.md") < result!.content.indexOf("## Structure"));
  } finally {
    clearCloneCache();
    globalThis.fetch = originalFetch;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("fetchUrl: bare repo keeps README in truncated output", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-internet-github-"));
  const originalFetch = globalThis.fetch;

  try {
    const repoPath = join(tempRoot, "user", "repo");
    const longDir = "nested-directory-" + "x".repeat(40);
    const nestedPath = join(repoPath, longDir);

    mkdirSync(join(repoPath, ".git"), { recursive: true });
    mkdirSync(nestedPath, { recursive: true });
    writeFileSync(join(repoPath, "README.md"), "# Repo README\n\nKeep this visible even when output truncates.");

    for (let i = 0; i < 199; i++) {
      const suffix = String(i).padStart(3, "0");
      const fileName = `file-${suffix}-` + "y".repeat(200) + ".ts";
      writeFileSync(join(nestedPath, fileName), "export const value = 1;\n");
    }

    globalThis.fetch = async () => new Response(JSON.stringify({ size: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    clearCloneCache();
    const result = await fetchUrl("https://github.com/user/repo", makeConfig(tempRoot));

    assert.equal(result.error, null);
    assert.equal(result.truncated, true);
    assert.ok(result.content.includes("## README.md"));
    assert.ok(result.content.includes("# Repo README"));
  } finally {
    clearCloneCache();
    globalThis.fetch = originalFetch;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
