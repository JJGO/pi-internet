/**
 * GitHub URL handling — clone repos locally for real file access.
 *
 * Provenance: pi-web-access/github-extract.ts
 * Borrowed: Clone cache, gh/git clone with depth=1, NOISE_DIRS filtering,
 * binary detection (first 512 bytes), tree building, README extraction,
 * NON_CODE_SEGMENTS set, API fallback for large repos.
 *
 * Key difference from pi-web-access: clones persist across sessions
 * (user preference — OS cleans /tmp on reboot).
 */

import {
  existsSync, readFileSync, readdirSync, statSync,
  openSync, readSync, closeSync, mkdirSync, rmSync, writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { extname, join, resolve as resolvePath } from "node:path";
import type { PiInternetConfig } from "../config.js";
import type { FetchResult } from "./http.js";

// ── URL parsing ────────────────────────────────────────────────

const NON_CODE_SEGMENTS = new Set([
  "issues", "pull", "pulls", "discussions", "releases", "wiki",
  "actions", "settings", "security", "projects", "graphs",
  "compare", "commits", "tags", "branches", "stargazers",
  "watchers", "network", "forks", "milestone", "labels",
  "packages", "codespaces", "contribute", "community",
  "sponsors", "invitations", "notifications", "insights",
]);

interface GitHubUrlInfo {
  owner: string;
  repo: string;
  ref?: string;
  path?: string;
  type: "root" | "blob" | "tree";
  showReadme?: boolean;
}

function shouldShowReadmePreview(parsed: URL, type: GitHubUrlInfo["type"]): boolean {
  if (type === "blob") return false;
  if (parsed.hash.length > 1) return true;
  const tab = parsed.searchParams.get("tab")?.toLowerCase();
  return typeof tab === "string" && tab.startsWith("readme");
}

export function parseGitHubUrl(url: string): GitHubUrlInfo | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }

  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const segments = parsed.pathname.split("/").filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");

  if (NON_CODE_SEGMENTS.has(segments[2]?.toLowerCase())) return null;

  if (segments.length === 2) {
    return {
      owner,
      repo,
      type: "root",
      ...(shouldShowReadmePreview(parsed, "root") ? { showReadme: true } : {}),
    };
  }

  const action = segments[2];
  if (action !== "blob" && action !== "tree") return null;
  if (segments.length < 4) {
    return {
      owner,
      repo,
      type: "root",
      ...(shouldShowReadmePreview(parsed, "root") ? { showReadme: true } : {}),
    };
  }

  const ref = segments[3];
  const pathParts = segments.slice(4);
  const type = action as "blob" | "tree";
  return {
    owner,
    repo,
    ref,
    path: pathParts.length > 0 ? pathParts.join("/") : "",
    type,
    ...(shouldShowReadmePreview(parsed, type) ? { showReadme: true } : {}),
  };
}

// ── Clone cache (persistent on disk, deduped in memory) ─────────

const cloneCache = new Map<string, Promise<CloneResult>>();
const GIT_TIMEOUT_MS = 30_000;

interface CloneMetadata {
  activePath: string;
  lastRefreshAt: number;
  resolvedRef?: string;
}

interface CloneResult {
  path: string | null;
  error?: string;
  warning?: string;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

function cacheKey(owner: string, repo: string, ref?: string): string {
  return ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;
}

function cloneDir(config: PiInternetConfig, owner: string, repo: string, ref?: string): string {
  const dirName = ref ? `${repo}@${ref}` : repo;
  return join(config.github.clonePath, owner, dirName);
}

function cloneMetadataPath(config: PiInternetConfig, owner: string, repo: string, ref?: string): string {
  const fileName = `.pi-internet-${encodeURIComponent(cacheKey(owner, repo, ref))}.json`;
  return join(config.github.clonePath, owner, fileName);
}

function uniqueCloneDir(config: PiInternetConfig, owner: string, repo: string, ref?: string): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${cloneDir(config, owner, repo, ref)}.refresh-${suffix}`;
}

function readCloneMetadata(path: string): CloneMetadata | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.activePath !== "string" || parsed.activePath.length === 0) return null;
    if (typeof parsed.lastRefreshAt !== "number" || !Number.isFinite(parsed.lastRefreshAt)) return null;
    return {
      activePath: parsed.activePath,
      lastRefreshAt: parsed.lastRefreshAt,
      resolvedRef: typeof parsed.resolvedRef === "string" && parsed.resolvedRef.length > 0
        ? parsed.resolvedRef
        : undefined,
    };
  } catch {
    return null;
  }
}

function writeCloneMetadata(path: string, metadata: CloneMetadata): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(metadata, null, 2));
}

function resolveActiveClonePath(canonicalPath: string, metadata: CloneMetadata | null): string {
  if (metadata?.activePath && existsSync(join(metadata.activePath, ".git"))) return metadata.activePath;
  return canonicalPath;
}

function isCommitRef(ref: string | undefined): boolean {
  return typeof ref === "string" && /^[0-9a-f]{7,40}$/i.test(ref);
}

function shouldRefreshClone(metadata: CloneMetadata | null, ref: string | undefined, ttlMs: number): boolean {
  if (isCommitRef(ref)) return false;
  if (!metadata) return true;
  return Date.now() - metadata.lastRefreshAt >= ttlMs;
}

// ── Clone execution ────────────────────────────────────────────

let ghAvailable: boolean | null = null;

async function checkGhAvailable(): Promise<boolean> {
  if (ghAvailable !== null) return ghAvailable;
  return new Promise((resolve) => {
    execFile("gh", ["--version"], { timeout: 5000 }, (err) => {
      ghAvailable = !err;
      resolve(ghAvailable);
    });
  });
}

function execCommand(
  command: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          ok: false,
          stdout: typeof stdout === "string" ? stdout : stdout.toString(),
          stderr: typeof stderr === "string" ? stderr : stderr.toString(),
          error: err.message,
        });
        return;
      }
      resolve({
        ok: true,
        stdout: typeof stdout === "string" ? stdout : stdout.toString(),
        stderr: typeof stderr === "string" ? stderr : stderr.toString(),
      });
    });

    if (signal) {
      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("exit", () => signal.removeEventListener("abort", onAbort));
    }
  });
}

async function cloneRepo(
  owner: string,
  repo: string,
  ref: string | undefined,
  config: PiInternetConfig,
  signal: AbortSignal | undefined,
  localPath = cloneDir(config, owner, repo, ref),
  remoteUrl?: string,
): Promise<CloneResult> {
  if (existsSync(join(localPath, ".git"))) return { path: localPath };

  try { rmSync(localPath, { recursive: true, force: true }); } catch {}

  if (!remoteUrl) {
    const hasGh = await checkGhAvailable();
    if (hasGh) {
      const args = ["repo", "clone", `${owner}/${repo}`, localPath, "--", "--depth", "1", "--single-branch"];
      if (ref) args.push("--branch", ref);
      const result = await execCommand("gh", args, undefined, GIT_TIMEOUT_MS, signal);
      if (result.ok) return { path: localPath };
      try { rmSync(localPath, { recursive: true, force: true }); } catch {}
      return { path: null, error: result.stderr.trim() || result.error || "gh clone failed" };
    }
  }

  const sourceUrl = remoteUrl ?? `https://github.com/${owner}/${repo}.git`;
  const args = ["clone", "--depth", "1", "--single-branch"];
  if (ref) args.push("--branch", ref);
  args.push(sourceUrl, localPath);
  const result = await execCommand("git", args, undefined, GIT_TIMEOUT_MS, signal);
  if (result.ok) return { path: localPath };
  try { rmSync(localPath, { recursive: true, force: true }); } catch {}
  return { path: null, error: result.stderr.trim() || result.error || "git clone failed" };
}

async function getOriginUrl(localPath: string, signal?: AbortSignal): Promise<string | undefined> {
  const result = await execCommand("git", ["remote", "get-url", "origin"], localPath, GIT_TIMEOUT_MS, signal);
  if (!result.ok) return undefined;
  const originUrl = result.stdout.trim();
  return originUrl.length > 0 ? originUrl : undefined;
}

async function resolveCurrentRef(localPath: string, signal?: AbortSignal): Promise<string | undefined> {
  const result = await execCommand("git", ["branch", "--show-current"], localPath, GIT_TIMEOUT_MS, signal);
  if (!result.ok) return undefined;
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : undefined;
}

async function isWorkingTreeDirty(localPath: string, signal?: AbortSignal): Promise<boolean | null> {
  const result = await execCommand("git", ["status", "--porcelain"], localPath, GIT_TIMEOUT_MS, signal);
  if (!result.ok) return null;
  return result.stdout.trim().length > 0;
}

async function refreshClone(localPath: string, ref: string | undefined, signal?: AbortSignal): Promise<CloneResult> {
  const targetRef = ref ?? await resolveCurrentRef(localPath, signal) ?? "HEAD";

  // We reset to the remote target instead of using git pull so the cache stays
  // deterministic and never accumulates merge commits from background refreshes.
  const fetchResult = await execCommand("git", ["fetch", "--depth", "1", "origin", targetRef], localPath, GIT_TIMEOUT_MS, signal);
  if (!fetchResult.ok) {
    return { path: null, error: fetchResult.stderr.trim() || fetchResult.error || `git fetch ${targetRef} failed` };
  }

  const resetResult = await execCommand("git", ["reset", "--hard", "FETCH_HEAD"], localPath, GIT_TIMEOUT_MS, signal);
  if (!resetResult.ok) {
    return { path: null, error: resetResult.stderr.trim() || resetResult.error || "git reset --hard FETCH_HEAD failed" };
  }

  return { path: localPath };
}

async function checkRepoSize(owner: string, repo: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "pi-internet" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.size === "number" ? data.size : null;
  } catch {
    return null;
  }
}

async function ensureRepoReady(
  owner: string,
  repo: string,
  ref: string | undefined,
  config: PiInternetConfig,
  signal?: AbortSignal,
): Promise<CloneResult> {
  const key = cacheKey(owner, repo, ref);
  const cached = cloneCache.get(key);
  if (cached) return cached;

  const operation = (async () => {
    const canonicalPath = cloneDir(config, owner, repo, ref);
    const metadataPath = cloneMetadataPath(config, owner, repo, ref);
    const metadata = readCloneMetadata(metadataPath);
    const activePath = resolveActiveClonePath(canonicalPath, metadata);

    if (existsSync(join(activePath, ".git"))) {
      if (!shouldRefreshClone(metadata, ref, config.github.refreshTtlMs)) {
        return { path: activePath };
      }

      const dirty = await isWorkingTreeDirty(activePath, signal);
      if (dirty === true || dirty === null) {
        const freshPath = uniqueCloneDir(config, owner, repo, ref);
        const originUrl = await getOriginUrl(activePath, signal);
        const cloned = await cloneRepo(owner, repo, ref, config, signal, freshPath, originUrl);
        if (!cloned.path) {
          return {
            path: activePath,
            warning: `GitHub refresh failed (${cloned.error || "clone failed"}); showing cached snapshot.`,
          };
        }

        const resolvedRef = ref ?? await resolveCurrentRef(cloned.path, signal) ?? metadata?.resolvedRef;
        writeCloneMetadata(metadataPath, {
          activePath: cloned.path,
          lastRefreshAt: Date.now(),
          ...(resolvedRef ? { resolvedRef } : {}),
        });
        return { path: cloned.path };
      }

      const refreshed = await refreshClone(activePath, ref ?? metadata?.resolvedRef, signal);
      if (!refreshed.path) {
        return {
          path: activePath,
          warning: `GitHub refresh failed (${refreshed.error || "refresh failed"}); showing cached snapshot.`,
        };
      }

      const resolvedRef = ref ?? await resolveCurrentRef(activePath, signal) ?? metadata?.resolvedRef;
      writeCloneMetadata(metadataPath, {
        activePath,
        lastRefreshAt: Date.now(),
        ...(resolvedRef ? { resolvedRef } : {}),
      });
      return { path: activePath };
    }

    const sizeKB = await checkRepoSize(owner, repo);
    if (sizeKB !== null) {
      const sizeMB = sizeKB / 1024;
      if (sizeMB > config.github.maxRepoSizeMB) {
        return {
          path: null,
          error: `Repo too large (${Math.round(sizeMB)}MB). Use web_search or fetch specific file URLs instead.`,
        };
      }
    }

    const cloned = await cloneRepo(owner, repo, ref, config, signal, canonicalPath);
    if (!cloned.path) return cloned;

    const resolvedRef = ref ?? await resolveCurrentRef(cloned.path, signal);
    writeCloneMetadata(metadataPath, {
      activePath: cloned.path,
      lastRefreshAt: Date.now(),
      ...(resolvedRef ? { resolvedRef } : {}),
    });
    return cloned;
  })().finally(() => {
    cloneCache.delete(key);
  });

  cloneCache.set(key, operation);
  return operation;
}

// ── Content generation ─────────────────────────────────────────

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg", ".tiff",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".ogg", ".webm", ".flac",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a",
  ".woff", ".woff2", ".ttf", ".otf",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".sqlite", ".db", ".pyc", ".class", ".jar",
]);

const NOISE_DIRS = new Set([
  "node_modules", "vendor", ".next", "dist", "build", "__pycache__",
  ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
  "target", ".gradle", ".idea", ".vscode",
]);

const MAX_TREE_ENTRIES = 200;
const MAX_INLINE_FILE_CHARS = 100_000;

function isBinaryFile(filePath: string): boolean {
  if (BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())) return true;
  try {
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(512);
      const bytesRead = readSync(fd, buf, 0, 512, 0);
      for (let i = 0; i < bytesRead; i++) if (buf[i] === 0) return true;
    } finally { closeSync(fd); }
  } catch {}
  return false;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildTree(rootPath: string): string {
  const entries: string[] = [];
  const skippedDirs: string[] = [];
  function walk(dir: string, relPath: string): void {
    if (entries.length >= MAX_TREE_ENTRIES) return;
    let items: string[];
    try { items = readdirSync(dir).sort(); } catch { return; }
    for (const item of items) {
      if (entries.length >= MAX_TREE_ENTRIES) return;
      if (item === ".git") continue;
      const rel = relPath ? `${relPath}/${item}` : item;
      const fullPath = resolvePath(rootPath, rel);
      let stat;
      try { stat = statSync(fullPath); } catch { continue; }
      if (stat.isDirectory()) {
        if (NOISE_DIRS.has(item)) { skippedDirs.push(item); continue; }
        entries.push(`${rel}/`);
        walk(fullPath, rel);
      } else {
        entries.push(rel);
      }
    }
  }
  walk(rootPath, "");
  if (entries.length >= MAX_TREE_ENTRIES) entries.push(`... (truncated at ${MAX_TREE_ENTRIES} entries)`);
  if (skippedDirs.length > 0) {
    const unique = [...new Set(skippedDirs)];
    entries.push(`(${unique.length} director${unique.length === 1 ? "y" : "ies"} skipped: ${unique.join(", ")})`);
  }
  return entries.join("\n");
}

interface ReadmeResult {
  name: string;
  content: string;
}

function readReadme(localPath: string): ReadmeResult | null {
  for (const name of ["README.md", "readme.md", "README", "README.txt", "README.rst"]) {
    const p = join(localPath, name);
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, "utf-8");
      return {
        name,
        content: content.length > 8192 ? content.slice(0, 8192) + "\n\n[README truncated at 8K chars]" : content,
      };
    } catch { continue; }
  }
  return null;
}

function generateContent(localPath: string, info: GitHubUrlInfo): string {
  const lines: string[] = [`Repository cloned to: ${localPath}`, ""];

  if (info.type === "root") {
    const readme = readReadme(localPath);
    if (readme) lines.push(`## ${readme.name}`, readme.content, "");
    lines.push("## Structure", buildTree(localPath), "");
    lines.push("Use `read` and `bash` tools at the path above to explore further.");
    return lines.join("\n");
  }

  if (info.type === "tree") {
    const dirPath = info.path || "";
    const fullPath = resolvePath(localPath, dirPath);
    if (!existsSync(fullPath)) {
      lines.push(`Path \`${dirPath}\` not found. Showing root instead.`, "", "## Structure", buildTree(localPath));
    } else {
      lines.push(`## ${dirPath || "/"}`);
      try {
        for (const item of readdirSync(fullPath).sort()) {
          if (item === ".git") continue;
          const s = statSync(resolvePath(fullPath, item));
          lines.push(s.isDirectory() ? `  ${item}/` : `  ${item}  (${formatFileSize(s.size)})`);
        }
      } catch { lines.push("  (directory not readable)"); }

      if (info.showReadme) {
        const readme = readReadme(fullPath);
        if (readme) {
          lines.push("", `## ${readme.name}`, readme.content);
        }
      }
    }
    lines.push("", "Use `read` and `bash` tools at the path above to explore further.");
    return lines.join("\n");
  }

  if (info.type === "blob") {
    const filePath = info.path || "";
    const fullPath = resolvePath(localPath, filePath);
    if (!existsSync(fullPath)) {
      lines.push(`Path \`${filePath}\` not found. Showing root instead.`, "", "## Structure", buildTree(localPath));
    } else if (isBinaryFile(fullPath)) {
      lines.push(`## ${filePath}`, `Binary file (${formatFileSize(statSync(fullPath).size)}). Use \`read\` at the path above.`);
    } else {
      const content = readFileSync(fullPath, "utf-8");
      lines.push(`## ${filePath}`);
      lines.push(content.length > MAX_INLINE_FILE_CHARS
        ? content.slice(0, MAX_INLINE_FILE_CHARS) + `\n\n[Truncated at 100K chars. Full file: ${fullPath}]`
        : content);
    }
    lines.push("", "Use `read` and `bash` tools at the path above to explore further.");
    return lines.join("\n");
  }

  return lines.join("\n");
}

// ── Public API ─────────────────────────────────────────────────

export async function fetchGitHub(
  url: string,
  config: PiInternetConfig,
  signal?: AbortSignal,
): Promise<FetchResult | null> {
  const info = parseGitHubUrl(url);
  if (!info) return null; // Not a code URL → fall through to HTTP

  const { owner, repo } = info;
  const result = await ensureRepoReady(owner, repo, info.ref, config, signal);
  if (!result.path) {
    return {
      url,
      title: `${owner}/${repo}`,
      content: "",
      error: result.error || "Failed to prepare repository clone",
    };
  }

  const content = generateContent(result.path, info);
  return {
    url,
    title: `${owner}/${repo}`,
    content,
    error: result.warning ?? null,
  };
}

/** Clear the in-memory clone cache. Called on session_shutdown. */
export function clearCloneCache(): void {
  cloneCache.clear();
}
