/**
 * GitHub collaboration URL handling via `gh`/REST API.
 *
 * GitHub issue/PR/release/actions/gist pages are application HTML and do not
 * extract reliably with generic Readability/Jina. This module keeps those URL
 * classes on GitHub-native APIs and renders normalized Markdown for Pi.
 */

import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiInternetConfig } from "../config.js";
import { fetchWithProxy } from "../util/proxy.js";
import type { FetchResult } from "./http.js";

const GH_TIMEOUT_MS = 60_000;
const GH_LOG_TIMEOUT_MS = 120_000;
const MAX_SECTION_ITEMS = 100;
const MAX_BODY_CHARS = 20_000;
const MAX_COMMENT_CHARS = 12_000;
const MAX_INLINE_GIST_FILE_CHARS = 40_000;
const MAX_INLINE_RELEASE_ASSETS = 30;

export type GitHubResourceRoute =
  | { kind: "user"; login: string; url: string }
  | { kind: "issue"; owner: string; repo: string; number: number; url: string }
  | { kind: "pull"; owner: string; repo: string; number: number; url: string }
  | { kind: "release"; owner: string; repo: string; tag?: string; latest?: boolean; url: string }
  | { kind: "actions-run"; owner: string; repo: string; runId: string; url: string }
  | { kind: "commit"; owner: string; repo: string; sha: string; url: string }
  | { kind: "compare"; owner: string; repo: string; base: string; head: string; url: string }
  | { kind: "gist"; owner?: string; gistId: string; url: string }
  | { kind: "unsupported"; owner?: string; repo?: string; path: string; url: string };

export interface GitHubResourceOptions {
  verbose?: boolean;
  includeLinks?: boolean;
  signal?: AbortSignal;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  error?: string;
}

type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<CommandResult>;

let ghAvailable: boolean | null = null;
let commandRunner: CommandRunner = runCommand;

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 25 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : stdout.toString();
        const errText = typeof stderr === "string" ? stderr : stderr.toString();
        if (err) {
          const nodeErr = err as NodeJS.ErrnoException & { code?: number | string | null; killed?: boolean };
          resolve({
            ok: false,
            stdout: out,
            stderr: errText,
            code: typeof nodeErr.code === "number" ? nodeErr.code : null,
            timedOut: Boolean(nodeErr.killed) && /timed out|timeout/i.test(nodeErr.message),
            error: nodeErr.message,
          });
          return;
        }
        resolve({ ok: true, stdout: out, stderr: errText, code: 0, timedOut: false });
      },
    );

    if (signal) {
      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("exit", () => signal.removeEventListener("abort", onAbort));
    }
  });
}

async function checkGhAvailable(signal?: AbortSignal): Promise<boolean> {
  if (process.env.PI_INTERNET_GITHUB_DISABLE_GH === "1") return false;
  if (ghAvailable !== null) return ghAvailable;
  const result = await commandRunner("gh", ["--version"], 5_000, signal);
  ghAvailable = result.ok;
  return ghAvailable;
}

async function ghJson<T>(args: string[], signal?: AbortSignal): Promise<{ ok: true; data: T } | { ok: false; error: string; stderr?: string }> {
  if (!(await checkGhAvailable(signal))) return { ok: false, error: "gh is not installed or not available" };
  const result = await commandRunner("gh", args, GH_TIMEOUT_MS, signal);
  if (!result.ok) {
    return {
      ok: false,
      error: result.timedOut ? `gh command timed out after ${GH_TIMEOUT_MS}ms` : result.error ?? `gh exited with code ${result.code}`,
      stderr: result.stderr,
    };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) as T };
  } catch (err) {
    return { ok: false, error: `Failed to parse gh JSON: ${err instanceof Error ? err.message : String(err)}`, stderr: result.stderr };
  }
}

async function ghText(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; error: string; stderr?: string }> {
  if (!(await checkGhAvailable(signal))) return { ok: false, error: "gh is not installed or not available" };
  const result = await commandRunner("gh", args, timeoutMs, signal);
  if (!result.ok) {
    return {
      ok: false,
      error: result.timedOut ? `gh command timed out after ${timeoutMs}ms` : result.error ?? `gh exited with code ${result.code}`,
      stderr: result.stderr,
    };
  }
  return { ok: true, text: result.stdout };
}

async function ghApiJson<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  const result = await ghJson<T>(["api", path], signal);
  return result.ok ? result.data : null;
}

async function restJson<T>(path: string, config: PiInternetConfig, signal?: AbortSignal): Promise<T | null> {
  try {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "pi-internet",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetchWithProxy(`https://api.github.com/${path.replace(/^\/+/, "")}`, {
      headers,
      signal,
    }, { socksProxy: config.fetch.socksProxy });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

async function apiJson<T>(path: string, config: PiInternetConfig, signal?: AbortSignal): Promise<T | null> {
  return await ghApiJson<T>(path, signal) ?? await restJson<T>(path, config, signal);
}

// ── URL parsing ────────────────────────────────────────────────

function decodePathSegment(segment: string): string {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

function parsePositiveInt(segment: string | undefined): number | null {
  if (!segment || !/^\d+$/.test(segment)) return null;
  const value = Number.parseInt(segment, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed;
  } catch {
    return null;
  }
}

export function parseGitHubResourceUrl(rawUrl: string): GitHubResourceRoute | null {
  const parsed = normalizeUrl(rawUrl);
  if (!parsed) return null;

  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean).map(decodePathSegment);
  const url = parsed.toString();

  if (host === "gist.github.com") {
    if (parts.length === 1) return { kind: "gist", gistId: parts[0], url };
    if (parts.length >= 2) return { kind: "gist", owner: parts[0], gistId: parts[1], url };
    return { kind: "unsupported", path: parsed.pathname, url };
  }

  if (host !== "github.com" && host !== "www.github.com") return null;

  if (parts.length === 1) return { kind: "user", login: parts[0], url };
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, "");
  const kind = parts[2]?.toLowerCase();
  const rest = parts.slice(3);
  const number = parsePositiveInt(rest[0]);

  if (kind === "issues" && number) return { kind: "issue", owner, repo, number, url };
  if ((kind === "pull" || kind === "pulls") && number) return { kind: "pull", owner, repo, number, url };
  if (kind === "releases") {
    if (rest[0] === "tag" && rest[1]) return { kind: "release", owner, repo, tag: rest.slice(1).join("/"), url };
    if (rest[0] === "latest") return { kind: "release", owner, repo, latest: true, url };
    return { kind: "release", owner, repo, url };
  }
  if (kind === "actions" && rest[0] === "runs" && rest[1]) {
    return { kind: "actions-run", owner, repo, runId: rest[1], url };
  }
  if (kind === "commit" && rest[0]) return { kind: "commit", owner, repo, sha: rest[0], url };
  if (kind === "compare" && rest.length > 0) {
    const spec = rest.join("/");
    const [base, head] = spec.split("...");
    if (base && head) return { kind: "compare", owner, repo, base, head, url };
  }

  // Code URLs are handled by the clone path in github.ts. Return null so the
  // existing local-repo behavior remains the first-class code experience.
  if (!kind || kind === "blob" || kind === "tree" || kind === "raw") return null;

  return { kind: "unsupported", owner, repo, path: `/${parts.slice(2).join("/")}`, url };
}

// ── Markdown helpers ───────────────────────────────────────────

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function loginOf(value: any): string {
  return stringValue(value?.login) || stringValue(value?.user?.login) || stringValue(value?.author?.login) || "unknown";
}

function labelName(label: any): string {
  return stringValue(label?.name) || stringValue(label);
}

function truncateBlock(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n\n[section truncated: ${text.length - maxChars} chars omitted]`;
}

function pushSection(lines: string[], title: string, body: unknown, maxChars = MAX_BODY_CHARS): void {
  const text = stringValue(body).trim();
  if (!text) return;
  lines.push("", `## ${title}`, "", truncateBlock(text.replace(/\r\n/g, "\n"), maxChars));
}

function formatDate(value: unknown): string {
  return stringValue(value) || "unknown date";
}

function formatCount(count: unknown, noun: string): string {
  const n = numberValue(count) ?? 0;
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function issueOrPrHeader(owner: string, repo: string, kind: "Issue" | "PR", item: any, fallbackNumber: number): string[] {
  const number = numberValue(item?.number) ?? fallbackNumber;
  const title = stringValue(item?.title) || `${kind} #${number}`;
  const state = stringValue(item?.state) || "unknown";
  const labels = asArray(item?.labels).map(labelName).filter(Boolean);
  const lines = [`# ${owner}/${repo} ${kind} #${number} — ${title}`, ""];
  lines.push(`State: ${state}`);
  lines.push(`Author: ${loginOf(item?.author ?? item?.user)}`);
  if (labels.length > 0) lines.push(`Labels: ${labels.join(", ")}`);
  if (item?.createdAt || item?.created_at) lines.push(`Created: ${formatDate(item.createdAt ?? item.created_at)}`);
  if (item?.updatedAt || item?.updated_at) lines.push(`Updated: ${formatDate(item.updatedAt ?? item.updated_at)}`);
  if (item?.closedAt || item?.closed_at) lines.push(`Closed: ${formatDate(item.closedAt ?? item.closed_at)}`);
  if (item?.mergedAt || item?.merged_at) lines.push(`Merged: ${formatDate(item.mergedAt ?? item.merged_at)}`);
  if (item?.url || item?.html_url) lines.push(`URL: ${stringValue(item.url ?? item.html_url)}`);
  return lines;
}

function renderComments(lines: string[], title: string, comments: any[], maxBodyChars = MAX_COMMENT_CHARS): void {
  if (comments.length === 0) return;
  lines.push("", `## ${title} (${comments.length})`);
  for (const comment of comments.slice(0, MAX_SECTION_ITEMS)) {
    const author = loginOf(comment.author ?? comment.user ?? comment);
    const created = formatDate(comment.createdAt ?? comment.created_at ?? comment.submittedAt ?? comment.submitted_at);
    const state = comment.state ? ` — ${comment.state}` : "";
    const path = comment.path ? ` — ${comment.path}${comment.line ? `:${comment.line}` : ""}` : "";
    lines.push("", `### ${author}${state}${path} — ${created}`, "");
    lines.push(truncateBlock(stringValue(comment.body).trim() || "(no body)", maxBodyChars));
    const url = stringValue(comment.html_url ?? comment.url);
    if (url) lines.push("", `Comment URL: ${url}`);
  }
  if (comments.length > MAX_SECTION_ITEMS) {
    lines.push("", `[${comments.length - MAX_SECTION_ITEMS} additional comments omitted]`);
  }
}

function renderFiles(lines: string[], files: any[]): void {
  if (files.length === 0) return;
  lines.push("", `## Files changed (${files.length})`, "");
  for (const file of files.slice(0, MAX_SECTION_ITEMS)) {
    const path = stringValue(file.path ?? file.filename) || "unknown";
    const additions = numberValue(file.additions) ?? 0;
    const deletions = numberValue(file.deletions) ?? 0;
    const changeType = stringValue(file.changeType ?? file.status);
    lines.push(`- ${path} (+${additions}/-${deletions})${changeType ? ` — ${changeType}` : ""}`);
  }
  if (files.length > MAX_SECTION_ITEMS) lines.push(`- ... ${files.length - MAX_SECTION_ITEMS} more files`);
}

function renderCommits(lines: string[], commits: any[]): void {
  if (commits.length === 0) return;
  lines.push("", `## Commits (${commits.length})`, "");
  for (const commit of commits.slice(0, MAX_SECTION_ITEMS)) {
    const sha = stringValue(commit.oid ?? commit.sha).slice(0, 12);
    const message = stringValue(commit.messageHeadline ?? commit.commit?.message?.split("\n")[0] ?? commit.message).trim();
    const author = loginOf(commit.authors?.[0] ?? commit.author ?? commit.commit?.author);
    lines.push(`- ${sha || "unknown"} ${message || "(no message)"}${author !== "unknown" ? ` — ${author}` : ""}`);
  }
  if (commits.length > MAX_SECTION_ITEMS) lines.push(`- ... ${commits.length - MAX_SECTION_ITEMS} more commits`);
}

// ── Data fetch/render per route ────────────────────────────────

async function fetchPull(route: Extract<GitHubResourceRoute, { kind: "pull" }>, config: PiInternetConfig, options: GitHubResourceOptions): Promise<FetchResult> {
  const fields = [
    "number", "title", "state", "author", "body", "labels", "comments", "reviews", "latestReviews",
    "commits", "files", "additions", "deletions", "changedFiles", "url", "createdAt", "updatedAt",
    "mergedAt", "closed", "closedAt", "baseRefName", "headRefName", "reviewDecision", "statusCheckRollup",
  ].join(",");

  const gh = await ghJson<any>(["pr", "view", route.url, "--json", fields, "--comments"], options.signal);
  let pr: any | null = gh.ok ? gh.data : null;

  if (!pr) {
    const [restPr, issueComments, reviews, reviewComments, files, commits] = await Promise.all([
      restJson<any>(`repos/${route.owner}/${route.repo}/pulls/${route.number}`, config, options.signal),
      restJson<any[]>(`repos/${route.owner}/${route.repo}/issues/${route.number}/comments?per_page=100`, config, options.signal),
      restJson<any[]>(`repos/${route.owner}/${route.repo}/pulls/${route.number}/reviews?per_page=100`, config, options.signal),
      restJson<any[]>(`repos/${route.owner}/${route.repo}/pulls/${route.number}/comments?per_page=100`, config, options.signal),
      restJson<any[]>(`repos/${route.owner}/${route.repo}/pulls/${route.number}/files?per_page=100`, config, options.signal),
      restJson<any[]>(`repos/${route.owner}/${route.repo}/pulls/${route.number}/commits?per_page=100`, config, options.signal),
    ]);
    if (!restPr) return githubError(route.url, `${route.owner}/${route.repo} PR #${route.number}`, gh.ok ? "GitHub PR not found" : gh.error, gh.ok ? undefined : gh.stderr);
    pr = {
      ...restPr,
      number: restPr.number,
      title: restPr.title,
      state: restPr.merged_at ? "MERGED" : restPr.state?.toUpperCase?.() ?? restPr.state,
      author: restPr.user,
      createdAt: restPr.created_at,
      updatedAt: restPr.updated_at,
      closedAt: restPr.closed_at,
      mergedAt: restPr.merged_at,
      comments: issueComments ?? [],
      reviews: reviews ?? [],
      files: files ?? [],
      commits: commits ?? [],
      additions: restPr.additions,
      deletions: restPr.deletions,
      changedFiles: restPr.changed_files,
      url: restPr.html_url,
      baseRefName: restPr.base?.ref,
      headRefName: restPr.head?.ref,
      _reviewComments: reviewComments ?? [],
    };
  } else {
    pr._reviewComments = await apiJson<any[]>(`repos/${route.owner}/${route.repo}/pulls/${route.number}/comments?per_page=100`, config, options.signal) ?? [];
  }

  const lines = issueOrPrHeader(route.owner, route.repo, "PR", pr, route.number);
  if (pr.baseRefName || pr.headRefName) lines.push(`Branches: ${stringValue(pr.headRefName) || "?"} → ${stringValue(pr.baseRefName) || "?"}`);
  if (pr.changedFiles !== undefined || pr.additions !== undefined || pr.deletions !== undefined) {
    lines.push(`Diff: ${formatCount(pr.changedFiles, "file")} (+${numberValue(pr.additions) ?? 0}/-${numberValue(pr.deletions) ?? 0})`);
  }
  if (pr.reviewDecision) lines.push(`Review decision: ${pr.reviewDecision}`);

  pushSection(lines, "Body", pr.body);
  renderComments(lines, "Timeline comments", asArray(pr.comments));
  renderComments(lines, "Reviews", asArray(pr.reviews?.length ? pr.reviews : pr.latestReviews));
  renderComments(lines, "Review comments", asArray(pr._reviewComments));
  renderCommits(lines, asArray(pr.commits));
  renderFiles(lines, asArray(pr.files));
  renderStatusChecks(lines, asArray(pr.statusCheckRollup));

  return { url: route.url, title: `${route.owner}/${route.repo} PR #${route.number}`, content: lines.join("\n"), error: null };
}

function renderStatusChecks(lines: string[], checks: any[]): void {
  if (checks.length === 0) return;
  lines.push("", `## Status checks (${checks.length})`, "");
  for (const check of checks.slice(0, MAX_SECTION_ITEMS)) {
    const name = stringValue(check.name ?? check.context ?? check.workflowName) || "check";
    const state = stringValue(check.state ?? check.status ?? check.conclusion) || "unknown";
    lines.push(`- ${name}: ${state}`);
  }
}

async function fetchIssue(route: Extract<GitHubResourceRoute, { kind: "issue" }>, config: PiInternetConfig, options: GitHubResourceOptions): Promise<FetchResult> {
  const fields = ["number", "title", "state", "author", "body", "labels", "comments", "assignees", "milestone", "createdAt", "updatedAt", "closed", "closedAt", "url"].join(",");
  const gh = await ghJson<any>(["issue", "view", route.url, "--json", fields, "--comments"], options.signal);
  let issue: any | null = gh.ok ? gh.data : null;

  if (!issue) {
    const [restIssue, comments] = await Promise.all([
      restJson<any>(`repos/${route.owner}/${route.repo}/issues/${route.number}`, config, options.signal),
      restJson<any[]>(`repos/${route.owner}/${route.repo}/issues/${route.number}/comments?per_page=100`, config, options.signal),
    ]);
    if (!restIssue) return githubError(route.url, `${route.owner}/${route.repo} issue #${route.number}`, gh.ok ? "GitHub issue not found" : gh.error, gh.ok ? undefined : gh.stderr);
    issue = {
      ...restIssue,
      author: restIssue.user,
      createdAt: restIssue.created_at,
      updatedAt: restIssue.updated_at,
      closedAt: restIssue.closed_at,
      comments: comments ?? [],
      url: restIssue.html_url,
    };
  }

  const lines = issueOrPrHeader(route.owner, route.repo, "Issue", issue, route.number);
  pushSection(lines, "Body", issue.body);
  renderComments(lines, "Comments", asArray(issue.comments));
  return { url: route.url, title: `${route.owner}/${route.repo} issue #${route.number}`, content: lines.join("\n"), error: null };
}

async function fetchRelease(route: Extract<GitHubResourceRoute, { kind: "release" }>, config: PiInternetConfig, options: GitHubResourceOptions): Promise<FetchResult> {
  if (!route.tag && !route.latest) {
    const releases = await apiJson<any[]>(`repos/${route.owner}/${route.repo}/releases?per_page=20`, config, options.signal);
    if (!releases) return githubError(route.url, `${route.owner}/${route.repo} releases`, "Could not fetch GitHub releases");
    const lines = [`# ${route.owner}/${route.repo} releases`, ""];
    for (const release of releases) {
      lines.push(`- ${stringValue(release.name) || stringValue(release.tag_name) || "release"} (${stringValue(release.tag_name)}) — ${formatDate(release.published_at ?? release.created_at)}`);
    }
    return { url: route.url, title: `${route.owner}/${route.repo} releases`, content: lines.join("\n"), error: null };
  }

  const ghArgs = route.tag
    ? ["release", "view", route.tag, "-R", `${route.owner}/${route.repo}`, "--json", "tagName,name,body,author,createdAt,publishedAt,isDraft,isPrerelease,assets,url,targetCommitish"]
    : ["release", "view", "-R", `${route.owner}/${route.repo}`, "--json", "tagName,name,body,author,createdAt,publishedAt,isDraft,isPrerelease,assets,url,targetCommitish"];
  const gh = await ghJson<any>(ghArgs, options.signal);
  const release = gh.ok
    ? gh.data
    : await restJson<any>(route.tag
      ? `repos/${route.owner}/${route.repo}/releases/tags/${encodeURIComponent(route.tag)}`
      : `repos/${route.owner}/${route.repo}/releases/latest`, config, options.signal);
  if (!release) return githubError(route.url, `${route.owner}/${route.repo} release`, gh.ok ? "GitHub release not found" : gh.error, gh.ok ? undefined : gh.stderr);

  const tag = stringValue(release.tagName ?? release.tag_name);
  const name = stringValue(release.name) || tag || "release";
  const lines = [`# ${route.owner}/${route.repo} release — ${name}`, ""];
  if (tag) lines.push(`Tag: ${tag}`);
  lines.push(`Author: ${loginOf(release.author)}`);
  if (release.publishedAt || release.published_at) lines.push(`Published: ${formatDate(release.publishedAt ?? release.published_at)}`);
  if (release.isDraft ?? release.draft) lines.push("Draft: true");
  if (release.isPrerelease ?? release.prerelease) lines.push("Prerelease: true");
  if (release.url || release.html_url) lines.push(`URL: ${stringValue(release.url ?? release.html_url)}`);
  pushSection(lines, "Release notes", release.body);
  const assets = asArray(release.assets);
  if (assets.length > 0) {
    lines.push("", `## Assets (${assets.length})`, "");
    for (const asset of assets.slice(0, MAX_INLINE_RELEASE_ASSETS)) {
      lines.push(`- ${stringValue(asset.name)}${asset.size ? ` (${asset.size} bytes)` : ""}${asset.url || asset.browser_download_url ? ` — ${stringValue(asset.url ?? asset.browser_download_url)}` : ""}`);
    }
    if (assets.length > MAX_INLINE_RELEASE_ASSETS) lines.push(`- ... ${assets.length - MAX_INLINE_RELEASE_ASSETS} more assets`);
  }
  return { url: route.url, title: `${route.owner}/${route.repo} release ${tag}`, content: lines.join("\n"), error: null };
}

async function fetchActionsRun(route: Extract<GitHubResourceRoute, { kind: "actions-run" }>, config: PiInternetConfig, options: GitHubResourceOptions): Promise<FetchResult> {
  const gh = await ghJson<any>(["run", "view", route.runId, "-R", `${route.owner}/${route.repo}`, "--json", "attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,jobs,name,number,startedAt,status,updatedAt,url,workflowName"], options.signal);
  const run = gh.ok ? gh.data : await restJson<any>(`repos/${route.owner}/${route.repo}/actions/runs/${route.runId}`, config, options.signal);
  if (!run) return githubError(route.url, `${route.owner}/${route.repo} actions run ${route.runId}`, gh.ok ? "GitHub Actions run not found" : gh.error, gh.ok ? undefined : gh.stderr);

  const title = stringValue(run.displayTitle ?? run.display_title ?? run.name) || `Actions run ${route.runId}`;
  const lines = [`# ${route.owner}/${route.repo} Actions run — ${title}`, ""];
  lines.push(`Status: ${stringValue(run.status) || "unknown"}`);
  if (run.conclusion) lines.push(`Conclusion: ${run.conclusion}`);
  if (run.workflowName ?? run.workflow_name) lines.push(`Workflow: ${stringValue(run.workflowName ?? run.workflow_name)}`);
  if (run.event) lines.push(`Event: ${run.event}`);
  if (run.headBranch ?? run.head_branch) lines.push(`Branch: ${stringValue(run.headBranch ?? run.head_branch)}`);
  if (run.headSha ?? run.head_sha) lines.push(`Commit: ${stringValue(run.headSha ?? run.head_sha).slice(0, 12)}`);
  if (run.createdAt ?? run.created_at) lines.push(`Created: ${formatDate(run.createdAt ?? run.created_at)}`);
  if (run.updatedAt ?? run.updated_at) lines.push(`Updated: ${formatDate(run.updatedAt ?? run.updated_at)}`);
  if (run.url ?? run.html_url) lines.push(`URL: ${stringValue(run.url ?? run.html_url)}`);

  const jobs = asArray(run.jobs);
  if (jobs.length > 0) {
    lines.push("", `## Jobs (${jobs.length})`, "");
    for (const job of jobs.slice(0, MAX_SECTION_ITEMS)) {
      lines.push(`- ${stringValue(job.name)}: ${stringValue(job.status)}${job.conclusion ? ` / ${job.conclusion}` : ""}`);
    }
  }

  const logPath = await maybeSaveActionLogs(route, options);
  if (logPath) {
    lines.push("", "## Logs", "", `Logs were saved to: ${logPath}`, "", "Use the `read` tool on that path if you need the detailed log text.");
  } else {
    lines.push("", "## Logs", "", "Logs are not included inline. Re-fetch this Actions run with `verbose: true` to save failed logs to a temporary file for follow-up inspection.");
  }

  return { url: route.url, title: `${route.owner}/${route.repo} actions run ${route.runId}`, content: lines.join("\n"), error: null };
}

async function maybeSaveActionLogs(route: Extract<GitHubResourceRoute, { kind: "actions-run" }>, options: GitHubResourceOptions): Promise<string | null> {
  if (!options.verbose) return null;

  let logs = await ghText(["run", "view", route.runId, "-R", `${route.owner}/${route.repo}`, "--log-failed"], GH_LOG_TIMEOUT_MS, options.signal);
  if (!logs.ok || logs.text.trim().length === 0) {
    logs = await ghText(["run", "view", route.runId, "-R", `${route.owner}/${route.repo}`, "--log"], GH_LOG_TIMEOUT_MS, options.signal);
  }
  if (!logs.ok || logs.text.trim().length === 0) return null;

  const dir = await mkdtemp(join(tmpdir(), "pi-internet-gh-"));
  const path = join(dir, `actions-run-${route.runId}-logs.txt`);
  await writeFile(path, logs.text, "utf-8");
  return path;
}

async function fetchCommit(route: Extract<GitHubResourceRoute, { kind: "commit" }>, config: PiInternetConfig, options: GitHubResourceOptions): Promise<FetchResult> {
  const commit = await apiJson<any>(`repos/${route.owner}/${route.repo}/commits/${route.sha}`, config, options.signal);
  if (!commit) return githubError(route.url, `${route.owner}/${route.repo} commit ${route.sha}`, "Could not fetch GitHub commit");
  const message = stringValue(commit.commit?.message ?? commit.message);
  const headline = message.split("\n")[0] || route.sha;
  const lines = [`# ${route.owner}/${route.repo} commit ${stringValue(commit.sha).slice(0, 12)} — ${headline}`, ""];
  lines.push(`Author: ${loginOf(commit.author ?? commit.commit?.author)}`);
  if (commit.commit?.author?.date) lines.push(`Authored: ${commit.commit.author.date}`);
  if (commit.html_url) lines.push(`URL: ${commit.html_url}`);
  pushSection(lines, "Message", message);
  if (commit.stats) lines.push("", "## Stats", "", `Files: ${asArray(commit.files).length}`, `Additions: ${numberValue(commit.stats.additions) ?? 0}`, `Deletions: ${numberValue(commit.stats.deletions) ?? 0}`);
  renderFiles(lines, asArray(commit.files));
  return { url: route.url, title: `${route.owner}/${route.repo} commit ${route.sha}`, content: lines.join("\n"), error: null };
}

async function fetchCompare(route: Extract<GitHubResourceRoute, { kind: "compare" }>, config: PiInternetConfig, options: GitHubResourceOptions): Promise<FetchResult> {
  const compare = await apiJson<any>(`repos/${route.owner}/${route.repo}/compare/${encodeURIComponent(route.base)}...${encodeURIComponent(route.head)}`, config, options.signal);
  if (!compare) return githubError(route.url, `${route.owner}/${route.repo} compare`, "Could not fetch GitHub comparison");
  const lines = [`# ${route.owner}/${route.repo} compare ${route.base}...${route.head}`, ""];
  lines.push(`Status: ${stringValue(compare.status) || "unknown"}`);
  lines.push(`Ahead by: ${numberValue(compare.ahead_by) ?? 0}`);
  lines.push(`Behind by: ${numberValue(compare.behind_by) ?? 0}`);
  if (compare.html_url) lines.push(`URL: ${compare.html_url}`);
  renderCommits(lines, asArray(compare.commits));
  renderFiles(lines, asArray(compare.files));
  return { url: route.url, title: `${route.owner}/${route.repo} compare`, content: lines.join("\n"), error: null };
}

async function fetchGist(route: Extract<GitHubResourceRoute, { kind: "gist" }>, config: PiInternetConfig, options: GitHubResourceOptions): Promise<FetchResult> {
  const gist = await apiJson<any>(`gists/${route.gistId}`, config, options.signal);
  if (!gist) return githubError(route.url, `gist ${route.gistId}`, "Could not fetch GitHub gist");
  const title = stringValue(gist.description) || `Gist ${route.gistId}`;
  const lines = [`# ${title}`, ""];
  lines.push(`Author: ${loginOf(gist.owner)}`);
  if (gist.created_at) lines.push(`Created: ${gist.created_at}`);
  if (gist.updated_at) lines.push(`Updated: ${gist.updated_at}`);
  if (gist.html_url) lines.push(`URL: ${gist.html_url}`);
  const files = Object.values(gist.files ?? {}) as any[];
  lines.push("", `## Files (${files.length})`);
  for (const file of files) {
    const filename = stringValue(file.filename) || "file";
    lines.push("", `### ${filename}`, "");
    const content = stringValue(file.content);
    if (content) lines.push("```", truncateBlock(content, MAX_INLINE_GIST_FILE_CHARS), "```");
    else if (file.raw_url) lines.push(`Raw URL: ${file.raw_url}`);
  }
  return { url: route.url, title, content: lines.join("\n"), error: null };
}

async function fetchUser(route: Extract<GitHubResourceRoute, { kind: "user" }>, config: PiInternetConfig, options: GitHubResourceOptions): Promise<FetchResult> {
  const user = await apiJson<any>(`users/${route.login}`, config, options.signal);
  if (!user) return githubError(route.url, route.login, "Could not fetch GitHub user/org");
  const name = stringValue(user.name) || stringValue(user.login);
  const lines = [`# GitHub profile — ${name}`, ""];
  lines.push(`Login: ${stringValue(user.login)}`);
  if (user.type) lines.push(`Type: ${user.type}`);
  if (user.bio) lines.push(`Bio: ${user.bio}`);
  if (user.company) lines.push(`Company: ${user.company}`);
  if (user.blog) lines.push(`Blog: ${user.blog}`);
  if (user.html_url) lines.push(`URL: ${user.html_url}`);
  if (user.public_repos !== undefined) lines.push(`Public repos: ${user.public_repos}`);
  return { url: route.url, title: `GitHub ${route.login}`, content: lines.join("\n"), error: null };
}

function fetchUnsupported(route: Extract<GitHubResourceRoute, { kind: "unsupported" }>): FetchResult {
  const lines = ["# GitHub URL not yet specialized", ""];
  if (route.owner && route.repo) lines.push(`Repository: ${route.owner}/${route.repo}`);
  lines.push(`Path: ${route.path || "/"}`);
  lines.push(`URL: ${route.url}`);
  lines.push("", "This GitHub path was recognized, so pi-internet did not fall back to brittle GitHub HTML extraction. Fetch a more specific issue, PR, release, commit, Actions run, gist, file, tree, or repository URL.");
  return { url: route.url, title: route.owner && route.repo ? `${route.owner}/${route.repo}` : "GitHub URL", content: lines.join("\n"), error: null };
}

function githubError(url: string, title: string, error: string, stderr?: string): FetchResult {
  const hints = [error];
  if (/not installed|ENOENT|not available/i.test(error)) {
    hints.push("Install GitHub CLI (`gh`) and run `gh auth status` for private repos; public repos also use unauthenticated REST fallback when possible.");
  }
  if (/HTTP 404|not found/i.test(stderr ?? error)) {
    hints.push("Check owner/repo, number/ref/path, and repository permissions.");
  }
  if (/rate limit/i.test(stderr ?? error)) {
    hints.push("GitHub rate limit hit. Authenticate with `gh auth login` or set GITHUB_TOKEN/GH_TOKEN.");
  }
  if (stderr?.trim()) hints.push(`stderr:\n${stderr.trim().slice(0, 4000)}`);
  return { url, title, content: "", error: hints.join("\n\n") };
}

export async function fetchGitHubResource(
  route: GitHubResourceRoute,
  config: PiInternetConfig,
  options: GitHubResourceOptions = {},
): Promise<FetchResult> {
  switch (route.kind) {
    case "user": return fetchUser(route, config, options);
    case "issue": return fetchIssue(route, config, options);
    case "pull": return fetchPull(route, config, options);
    case "release": return fetchRelease(route, config, options);
    case "actions-run": return fetchActionsRun(route, config, options);
    case "commit": return fetchCommit(route, config, options);
    case "compare": return fetchCompare(route, config, options);
    case "gist": return fetchGist(route, config, options);
    case "unsupported": return fetchUnsupported(route);
  }
}

export function resetGitHubApiState(): void {
  ghAvailable = null;
}

export const __test__ = {
  parseGitHubResourceUrl,
  renderComments,
  setCommandRunner(runner: CommandRunner) {
    commandRunner = runner;
    ghAvailable = null;
  },
  resetCommandRunner() {
    commandRunner = runCommand;
    ghAvailable = null;
  },
};

// Ensure the default temp root exists on platforms where tmpdir is lazy-created.
try { mkdirSync(tmpdir(), { recursive: true }); } catch {}
