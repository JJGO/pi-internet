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
  openSync, readSync, closeSync, mkdirSync, rmSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { extname, join, resolve as resolvePath, sep as pathSep } from "node:path";
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
    return { owner, repo, type: "root" };
  }

  const action = segments[2];
  if (action !== "blob" && action !== "tree") return null;
  if (segments.length < 4) {
    return { owner, repo, type: "root" };
  }

  const ref = segments[3];
  const pathParts = segments.slice(4);
  return {
    owner,
    repo,
    ref,
    path: pathParts.length > 0 ? pathParts.join("/") : "",
    type: action as "blob" | "tree",
  };
}

// ── Clone cache (persists across sessions) ─────────────────────

const cloneCache = new Map<string, { localPath: string; promise: Promise<CloneResult> }>();

function cacheKey(owner: string, repo: string, ref?: string): string {
  return ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;
}

function cloneDir(config: PiInternetConfig, owner: string, repo: string, ref?: string): string {
  const dirName = ref ? `${repo}@${ref}` : repo;
  return join(config.github.clonePath, owner, dirName);
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

interface CloneResult { path: string | null; error?: string }

function execClone(args: string[], localPath: string, timeoutMs: number, signal?: AbortSignal): Promise<CloneResult> {
  return new Promise((resolve) => {
    mkdirSync(join(localPath, ".."), { recursive: true, mode: 0o700 });
    let stderr = "";
    const child = execFile(args[0], args.slice(1), { timeout: timeoutMs }, (err) => {
      if (err) {
        try { rmSync(localPath, { recursive: true, force: true }); } catch {}
        resolve({ path: null, error: stderr.trim() || err.message });
        return;
      }
      resolve({ path: localPath });
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    if (signal) {
      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("exit", () => signal.removeEventListener("abort", onAbort));
    }
  });
}

async function cloneRepo(
  owner: string, repo: string, ref: string | undefined,
  config: PiInternetConfig, signal?: AbortSignal,
): Promise<CloneResult> {
  const localPath = cloneDir(config, owner, repo, ref);

  // If already cloned (from a previous session), reuse it
  if (existsSync(join(localPath, ".git"))) return { path: localPath };

  try { rmSync(localPath, { recursive: true, force: true }); } catch {}

  const timeoutMs = 30_000;
  const hasGh = await checkGhAvailable();

  if (hasGh) {
    const args = ["gh", "repo", "clone", `${owner}/${repo}`, localPath, "--", "--depth", "1", "--single-branch"];
    if (ref) args.push("--branch", ref);
    return execClone(args, localPath, timeoutMs, signal);
  }

  const gitUrl = `https://github.com/${owner}/${repo}.git`;
  const args = ["git", "clone", "--depth", "1", "--single-branch"];
  if (ref) args.push("--branch", ref);
  args.push(gitUrl, localPath);
  return execClone(args, localPath, timeoutMs, signal);
}

// ── Repo size check (GitHub API, no auth needed for public repos) ──

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

function readReadme(localPath: string): string | null {
  for (const name of ["README.md", "readme.md", "README", "README.txt", "README.rst"]) {
    const p = join(localPath, name);
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, "utf-8");
      return content.length > 8192 ? content.slice(0, 8192) + "\n\n[README truncated at 8K chars]" : content;
    } catch { continue; }
  }
  return null;
}

function generateContent(localPath: string, info: GitHubUrlInfo): string {
  const lines: string[] = [`Repository cloned to: ${localPath}`, ""];

  if (info.type === "root") {
    const readme = readReadme(localPath);
    if (readme) lines.push("## README.md", readme, "");
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
  const key = cacheKey(owner, repo, info.ref);

  // Check cache
  const cached = cloneCache.get(key);
  if (cached) {
    const result = await cached.promise;
    if (result.path) {
      const content = generateContent(result.path, info);
      return { url, title: `${owner}/${repo}`, content, error: null };
    }
    return { url, title: "", content: "", error: result.error || "Clone failed (cached)" };
  }

  // Size check for large repos
  const sizeKB = await checkRepoSize(owner, repo);
  if (sizeKB !== null) {
    const sizeMB = sizeKB / 1024;
    if (sizeMB > config.github.maxRepoSizeMB) {
      return {
        url,
        title: `${owner}/${repo}`,
        content: `Repository is ${Math.round(sizeMB)}MB (threshold: ${config.github.maxRepoSizeMB}MB). Too large to clone.`,
        error: `Repo too large (${Math.round(sizeMB)}MB). Use web_search or fetch specific file URLs instead.`,
      };
    }
  }

  // Clone
  const promise = cloneRepo(owner, repo, info.ref, config, signal);
  const localPath = cloneDir(config, owner, repo, info.ref);
  cloneCache.set(key, { localPath, promise });

  const result = await promise;
  if (!result.path) {
    cloneCache.delete(key);
    const errMsg = result.error ? `Clone failed: ${result.error}` : "Failed to clone repository";
    return { url, title: "", content: "", error: errMsg };
  }

  const content = generateContent(result.path, info);
  return { url, title: `${owner}/${repo}`, content, error: null };
}

/** Clear the in-memory clone cache. Called on session_shutdown. */
export function clearCloneCache(): void {
  cloneCache.clear();
}
