import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      refreshTtlMs: 300_000,
    },
    youtube: {
      enabled: true,
    },
    fetch: {
      includeLinks: false,
      timeoutMs: 30_000,
      socksProxy: null,
    },
  };
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

function createOriginRepo(tempRoot: string): { originPath: string; workPath: string } {
  const originPath = join(tempRoot, "origin.git");
  const workPath = join(tempRoot, "work");

  git(["init", "--bare", "--initial-branch=main", originPath]);
  git(["init", "--initial-branch=main", workPath]);
  git(["config", "user.name", "Pi Internet Tests"], workPath);
  git(["config", "user.email", "pi-internet@example.com"], workPath);
  git(["remote", "add", "origin", originPath], workPath);

  return { originPath, workPath };
}

function commitPackageVersion(workPath: string, readme: string, message: string): void {
  const packagePath = join(workPath, "packages", "pi-tmux");
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(join(packagePath, "README.md"), readme);
  writeFileSync(join(packagePath, "index.ts"), "export const name = 'pi-tmux';\n");
  git(["add", "."], workPath);
  git(["commit", "-m", message], workPath);
  try {
    git(["push", "-u", "origin", "main"], workPath);
  } catch {
    git(["push", "origin", "main"], workPath);
  }
}

function cloneOriginToCache(originPath: string, cachePath: string): void {
  git(["clone", "--depth", "1", "--single-branch", "--branch", "main", originPath, cachePath]);
}

function writeCacheMetadata(
  cloneRoot: string,
  owner: string,
  repo: string,
  activePath: string,
  ref?: string,
): void {
  const key = ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;
  const metadataPath = join(cloneRoot, owner, `.pi-internet-${encodeURIComponent(key)}.json`);
  writeFileSync(metadataPath, JSON.stringify({
    activePath,
    lastRefreshAt: Date.now(),
    ...(ref ? { resolvedRef: ref } : {}),
  }));
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

test("parseGitHubUrl: tree README anchor requests README preview", () => {
  const r = parseGitHubUrl("https://github.com/user/repo/tree/main/src#readme");
  assert.equal(r?.type, "tree");
  assert.equal(r?.ref, "main");
  assert.equal(r?.path, "src");
  assert.equal(r?.showReadme, true);
});

test("parseGitHubUrl: tree README tab requests README preview", () => {
  const r = parseGitHubUrl("https://github.com/user/repo/tree/main/src?tab=readme-ov-file");
  assert.equal(r?.type, "tree");
  assert.equal(r?.showReadme, true);
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
    writeCacheMetadata(tempRoot, "user", "repo", repoPath);

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

test("fetchGitHub: tree README anchor includes directory listing and README", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-internet-github-"));
  const originalFetch = globalThis.fetch;

  try {
    const repoPath = join(tempRoot, "user", "repo@main");
    const packagePath = join(repoPath, "packages", "pi-tmux");

    mkdirSync(join(repoPath, ".git"), { recursive: true });
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(join(packagePath, "README.md"), "# pi-tmux\n\nDirectory README preview.");
    writeFileSync(join(packagePath, "index.ts"), "export const name = 'pi-tmux';\n");
    writeCacheMetadata(tempRoot, "user", "repo", repoPath, "main");

    globalThis.fetch = async () => new Response(JSON.stringify({ size: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    clearCloneCache();
    const result = await fetchGitHub(
      "https://github.com/user/repo/tree/main/packages/pi-tmux#readme",
      makeConfig(tempRoot),
    );

    assert.ok(result);
    assert.equal(result?.error, null);
    assert.ok(result?.content.includes("## packages/pi-tmux"));
    assert.ok(result?.content.includes("README.md  ("));
    assert.ok(result?.content.includes("index.ts  ("));
    assert.ok(result?.content.includes("## README.md"));
    assert.ok(result?.content.includes("# pi-tmux"));
  } finally {
    clearCloneCache();
    globalThis.fetch = originalFetch;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("fetchGitHub: stale clean clone refreshes in place", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-internet-github-"));
  const originalFetch = globalThis.fetch;

  try {
    const { originPath, workPath } = createOriginRepo(tempRoot);
    const repoPath = join(tempRoot, "user", "repo@main");

    commitPackageVersion(workPath, "# Old README\n", "initial");
    cloneOriginToCache(originPath, repoPath);
    commitPackageVersion(workPath, "# New README\n", "update");

    globalThis.fetch = async () => new Response(JSON.stringify({ size: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    clearCloneCache();
    const result = await fetchGitHub(
      "https://github.com/user/repo/tree/main/packages/pi-tmux#readme",
      makeConfig(tempRoot),
    );

    assert.ok(result);
    assert.equal(result?.error, null);
    assert.ok(result?.content.includes("# New README"));
    assert.ok(result?.content.includes(`Repository cloned to: ${repoPath}`));
    assert.ok(readFileSync(join(repoPath, "packages", "pi-tmux", "README.md"), "utf-8").includes("# New README"));
  } finally {
    clearCloneCache();
    globalThis.fetch = originalFetch;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("fetchGitHub: dirty cached clone gets a fresh sibling clone", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-internet-github-"));
  const originalFetch = globalThis.fetch;

  try {
    const { originPath, workPath } = createOriginRepo(tempRoot);
    const repoPath = join(tempRoot, "user", "repo@main");

    commitPackageVersion(workPath, "# Remote v1\n", "initial");
    cloneOriginToCache(originPath, repoPath);
    writeFileSync(join(repoPath, "packages", "pi-tmux", "README.md"), "# Dirty local README\n");
    commitPackageVersion(workPath, "# Remote v2\n", "update");

    globalThis.fetch = async () => new Response(JSON.stringify({ size: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    clearCloneCache();
    const result = await fetchGitHub(
      "https://github.com/user/repo/tree/main/packages/pi-tmux#readme",
      makeConfig(tempRoot),
    );

    assert.ok(result);
    assert.equal(result?.error, null);
    assert.ok(result?.content.includes("# Remote v2"));
    assert.equal(readFileSync(join(repoPath, "packages", "pi-tmux", "README.md"), "utf-8"), "# Dirty local README\n");

    const refreshedPath = result?.content.match(/^Repository cloned to: (.+)$/m)?.[1] ?? "";
    assert.notEqual(refreshedPath, repoPath);
    assert.ok(refreshedPath.startsWith(`${repoPath}.refresh-`));
    assert.ok(readFileSync(join(refreshedPath, "packages", "pi-tmux", "README.md"), "utf-8").includes("# Remote v2"));
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
    writeCacheMetadata(tempRoot, "user", "repo", repoPath);

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
