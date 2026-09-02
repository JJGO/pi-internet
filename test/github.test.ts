import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PiInternetConfig } from "../src/config.ts";
import { fetchGitHub, clearCloneCache, parseGitHubUrl } from "../src/fetch/github.ts";
import { fetchUrl } from "../src/fetch/router.ts";
import { fetchGitHubResource, parseGitHubResourceUrl, __test__ as githubApiTest } from "../src/fetch/github-api.ts";
import { truncateToolText } from "../src/util/truncation.ts";

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
      allowPrivateNetworks: true,
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

function commitPackageVersion(workPath: string, readme: string, message: string, branch = "main"): string {
  const packagePath = join(workPath, "packages", "pi-tmux");
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(join(packagePath, "README.md"), readme);
  writeFileSync(join(packagePath, "index.ts"), "export const name = 'pi-tmux';\n");
  git(["add", "."], workPath);
  git(["commit", "-m", message], workPath);
  try {
    git(["push", "-u", "origin", branch], workPath);
  } catch {
    git(["push", "origin", branch], workPath);
  }
  return git(["rev-parse", "HEAD"], workPath);
}

function cloneOriginToCache(originPath: string, cachePath: string, branch = "main"): void {
  git(["clone", "--depth", "1", "--single-branch", "--branch", branch, originPath, cachePath]);
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

test("parseGitHubUrl: rejects identifiers that could escape the clone cache", () => {
  assert.equal(parseGitHubUrl("https://github.com/%2e%2e/repo"), null);
  assert.equal(parseGitHubUrl("https://github.com/user/%2e%2e"), null);
  assert.equal(parseGitHubUrl("https://github.com/user/repo%2foutside"), null);
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

test("fetchGitHub rejects symlinks in README, tree, and blob rendering", { skip: process.platform === "win32" }, async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-internet-github-symlink-"));

  try {
    const repoPath = join(tempRoot, "user", "repo");
    const outsidePath = join(tempRoot, "outside");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    mkdirSync(outsidePath, { recursive: true });
    writeFileSync(join(outsidePath, "secret.txt"), "outside-secret");
    symlinkSync(join(outsidePath, "secret.txt"), join(repoPath, "README.md"));
    symlinkSync(outsidePath, join(repoPath, "linked-dir"), "dir");
    symlinkSync(join(outsidePath, "secret.txt"), join(repoPath, "linked-file.txt"));
    writeCacheMetadata(tempRoot, "user", "repo", repoPath);
    writeCacheMetadata(tempRoot, "user", "repo", repoPath, "main");

    clearCloneCache();
    const root = await fetchGitHub("https://github.com/user/repo", makeConfig(tempRoot));
    assert.ok(root);
    assert.doesNotMatch(root.content, /outside-secret|README\.md|linked-dir|linked-file/);

    const blob = await fetchGitHub("https://github.com/user/repo/blob/main/linked-file.txt", makeConfig(tempRoot));
    assert.ok(blob);
    assert.doesNotMatch(blob.content, /outside-secret/);
    assert.match(blob.content, /outside the repository checkout/);

    const tree = await fetchGitHub("https://github.com/user/repo/tree/main/linked-dir", makeConfig(tempRoot));
    assert.ok(tree);
    assert.doesNotMatch(tree.content, /outside-secret/);
    assert.match(tree.content, /outside the repository checkout/);
  } finally {
    clearCloneCache();
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

test("fetchGitHub: branch names with slashes resolve before reading paths", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-internet-github-"));

  try {
    const { originPath, workPath } = createOriginRepo(tempRoot);
    const branch = "feature/demo";
    const repoPath = join(tempRoot, "user", `repo@${encodeURIComponent(branch)}`);

    commitPackageVersion(workPath, "# Main README\n", "main");
    git(["checkout", "-b", branch], workPath);
    commitPackageVersion(workPath, "# Slash Branch README\n", "branch", branch);
    cloneOriginToCache(originPath, repoPath, branch);

    clearCloneCache();
    const result = await fetchGitHub(
      "https://github.com/user/repo/tree/feature/demo/packages/pi-tmux#readme",
      makeConfig(tempRoot),
    );

    assert.ok(result);
    assert.equal(result?.error, null);
    assert.ok(result?.content.includes("# Slash Branch README"));
    assert.ok(result?.content.includes(`Repository cloned to: ${repoPath}`));
  } finally {
    clearCloneCache();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("fetchGitHub: cached commit URLs verify HEAD before returning content", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-internet-github-"));

  try {
    const { originPath, workPath } = createOriginRepo(tempRoot);
    const oldCommit = commitPackageVersion(workPath, "# Old Commit README\n", "old");
    commitPackageVersion(workPath, "# New Main README\n", "new");

    const repoPath = join(tempRoot, "user", `repo@${oldCommit}`);
    cloneOriginToCache(originPath, repoPath, "main");
    assert.ok(readFileSync(join(repoPath, "packages", "pi-tmux", "README.md"), "utf-8").includes("# New Main README"));

    clearCloneCache();
    const result = await fetchGitHub(
      `https://github.com/user/repo/blob/${oldCommit}/packages/pi-tmux/README.md`,
      makeConfig(tempRoot),
    );

    assert.ok(result);
    assert.equal(result?.error, null);
    assert.ok(result?.content.includes("# Old Commit README"));
    assert.ok(readFileSync(join(repoPath, "packages", "pi-tmux", "README.md"), "utf-8").includes("# Old Commit README"));
  } finally {
    clearCloneCache();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("fetchUrl: bare repo keeps README in truncated tool output", async () => {
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
    const output = await truncateToolText(result.content, {
      continuation: "Refine the request to inspect omitted content.",
    });
    assert.equal(output.truncation?.truncated, true);
    assert.ok(output.text.includes("## README.md"));
    assert.ok(output.text.includes("# Repo README"));
  } finally {
    clearCloneCache();
    globalThis.fetch = originalFetch;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("parseGitHubResourceUrl: collaboration URL classes", () => {
  assert.deepEqual(parseGitHubResourceUrl("https://github.com/HomebrewML/HeavyBall/pull/88"), {
    kind: "pull",
    owner: "HomebrewML",
    repo: "HeavyBall",
    number: 88,
    url: "https://github.com/HomebrewML/HeavyBall/pull/88",
  });
  assert.deepEqual(parseGitHubResourceUrl("https://github.com/user/repo/issues/123"), {
    kind: "issue",
    owner: "user",
    repo: "repo",
    number: 123,
    url: "https://github.com/user/repo/issues/123",
  });
  assert.deepEqual(parseGitHubResourceUrl("https://github.com/user/repo/releases/tag/v1.2.3"), {
    kind: "release",
    owner: "user",
    repo: "repo",
    tag: "v1.2.3",
    url: "https://github.com/user/repo/releases/tag/v1.2.3",
  });
  assert.deepEqual(parseGitHubResourceUrl("https://github.com/user/repo/actions/runs/456"), {
    kind: "actions-run",
    owner: "user",
    repo: "repo",
    runId: "456",
    url: "https://github.com/user/repo/actions/runs/456",
  });
  assert.deepEqual(parseGitHubResourceUrl("https://gist.github.com/octo/abcdef"), {
    kind: "gist",
    owner: "octo",
    gistId: "abcdef",
    url: "https://gist.github.com/octo/abcdef",
  });
  assert.equal(parseGitHubResourceUrl("https://github.com/user/repo/blob/main/README.md"), null);
});

test("fetchUrl: GitHub PR uses native GitHub route instead of generic HTML", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-internet-github-"));
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => {
      throw new Error("generic fetch should not be called for GitHub PRs");
    };

    githubApiTest.setCommandRunner(async (_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return { ok: true, stdout: "gh version test", stderr: "", code: 0, timedOut: false };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return {
          ok: true,
          stdout: JSON.stringify({
            number: 88,
            title: "Fix ECC correction range: ±0.5 ULP → ±1 ULP",
            state: "MERGED",
            author: { login: "josejg" },
            body: "PR body from gh JSON",
            comments: [{ author: { login: "ClashLuke" }, createdAt: "2026-03-16T20:22:14Z", body: "Thanks for the detailed analysis.", url: "https://github.com/HomebrewML/HeavyBall/pull/88#issuecomment-1" }],
            reviews: [{ author: { login: "chatgpt-codex-connector" }, submittedAt: "2026-03-16T18:12:03Z", state: "COMMENTED", body: "Codex Review" }],
            commits: [{ oid: "f5b526a14132", messageHeadline: "fix ECC correction range" }],
            files: [{ path: "heavyball/utils.py", additions: 8, deletions: 2, changeType: "MODIFIED" }],
            additions: 12,
            deletions: 4,
            changedFiles: 2,
            url: "https://github.com/HomebrewML/HeavyBall/pull/88",
            createdAt: "2026-03-16T18:07:40Z",
            updatedAt: "2026-04-26T21:37:14Z",
            mergedAt: "2026-04-26T21:37:14Z",
            baseRefName: "main",
            headRefName: "ecc-range",
          }),
          stderr: "",
          code: 0,
          timedOut: false,
        };
      }
      if (args[0] === "api" && String(args[1]).includes("/pulls/88/comments")) {
        return {
          ok: true,
          stdout: JSON.stringify([{ user: { login: "reviewer" }, created_at: "2026-03-16T18:12:03Z", path: "heavyball/utils.py", line: 42, body: "Inline review comment", html_url: "https://github.com/HomebrewML/HeavyBall/pull/88#discussion" }]),
          stderr: "",
          code: 0,
          timedOut: false,
        };
      }
      return { ok: false, stdout: "", stderr: `unexpected args: ${args.join(" ")}`, code: 1, timedOut: false, error: "unexpected gh call" };
    });

    const result = await fetchUrl("https://github.com/HomebrewML/HeavyBall/pull/88", makeConfig(tempRoot));

    assert.equal(result.error, null);
    assert.ok(result.content.includes("PR #88"));
    assert.ok(result.content.includes("PR body from gh JSON"));
    assert.ok(result.content.includes("Thanks for the detailed analysis."));
    assert.ok(result.content.includes("Inline review comment"));
    assert.ok(result.content.includes("heavyball/utils.py (+8/-2)"));
    assert.ok(!result.content.includes("\u001f�"));
  } finally {
    githubApiTest.resetCommandRunner();
    clearCloneCache();
    globalThis.fetch = originalFetch;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("fetchGitHubResource: Actions verbose saves logs to a temp path", async () => {
  try {
    githubApiTest.setCommandRunner(async (_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return { ok: true, stdout: "gh version test", stderr: "", code: 0, timedOut: false };
      }
      if (args[0] === "run" && args[1] === "view" && args.includes("--json")) {
        return {
          ok: true,
          stdout: JSON.stringify({
            displayTitle: "CI",
            status: "completed",
            conclusion: "failure",
            workflowName: "test",
            event: "pull_request",
            headBranch: "feature",
            headSha: "abcdef1234567890",
            url: "https://github.com/user/repo/actions/runs/456",
            jobs: [{ name: "unit", status: "completed", conclusion: "failure" }],
          }),
          stderr: "",
          code: 0,
          timedOut: false,
        };
      }
      if (args[0] === "run" && args[1] === "view" && args.includes("--log-failed")) {
        return { ok: true, stdout: "unit\tRun tests\tfailing log line\n", stderr: "", code: 0, timedOut: false };
      }
      return { ok: false, stdout: "", stderr: `unexpected args: ${args.join(" ")}`, code: 1, timedOut: false, error: "unexpected gh call" };
    });

    const route = parseGitHubResourceUrl("https://github.com/user/repo/actions/runs/456");
    assert.ok(route && route.kind === "actions-run");
    const result = await fetchGitHubResource(route, makeConfig(tmpdir()), { verbose: true });

    assert.equal(result.error, null);
    const logPath = result.content.match(/Logs were saved to: (.+)$/m)?.[1];
    assert.ok(logPath, "expected log path in output");
    assert.ok(readFileSync(logPath, "utf-8").includes("failing log line"));
    rmSync(logPath.replace(/\/actions-run-456-logs\.txt$/, ""), { recursive: true, force: true });
  } finally {
    githubApiTest.resetCommandRunner();
    clearCloneCache();
  }
});
