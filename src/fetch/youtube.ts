/**
 * YouTube fetching via yt-dlp.
 *
 * Single-video URLs return transcripts.
 * Playlist and channel URLs return compact collection summaries.
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { FetchResult } from "./http.js";

const DEFAULT_COLLECTION_LIMIT = 25;
const YT_DLP_MAX_BUFFER = 5 * 1024 * 1024;
const YOUTUBE_TABS = new Set(["videos", "shorts", "streams", "playlists"]);
const YOUTUBE_LIST_CACHE_DIR = join(homedir(), ".cache", "pi-internet", "youtube-lists");

let ytDlpAvailable: boolean | null = null;

type YouTubeCollectionKind = "playlist" | "channel";
type YouTubeTab = "videos" | "shorts" | "streams" | "playlists";

type YouTubeTarget =
  | {
      kind: "video";
      videoId: string;
      videoUrl: string;
    }
  | {
      kind: "collection";
      collectionKind: YouTubeCollectionKind;
      fetchUrl: string;
      tab: YouTubeTab | null;
    };

interface RunYtDlpOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

interface YtDlpCollectionEntry {
  id?: string;
  title?: string;
  url?: string;
  duration?: number | null;
  availability?: string | null;
}

interface YtDlpCollectionInfo {
  id?: string;
  title?: string;
  channel?: string;
  channel_id?: string;
  uploader?: string;
  uploader_id?: string;
  webpage_url?: string;
  entries?: YtDlpCollectionEntry[];
}

interface CollectionRenderOptions {
  shownCount: number;
  totalCount: number;
  fullListPath: string | null;
  truncated: boolean;
  includeFullListPath: boolean;
}

async function checkYtDlp(): Promise<boolean> {
  if (ytDlpAvailable !== null) return ytDlpAvailable;
  return new Promise((resolve) => {
    execFile("yt-dlp", ["--version"], { timeout: 5000 }, (err) => {
      ytDlpAvailable = !err;
      resolve(ytDlpAvailable);
    });
  });
}

function extractVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (host === "youtu.be") return parsed.pathname.slice(1).split("/")[0] || null;
    if (parsed.searchParams.has("v")) return parsed.searchParams.get("v");

    const pathMatch = parsed.pathname.match(/^\/(shorts|live|embed|v)\/([^/?]+)/);
    if (pathMatch) return pathMatch[2];

    return null;
  } catch {
    return null;
  }
}

function normalizeYouTubeCollectionUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "youtu.be") return null;

    if (parsed.searchParams.has("list")) return parsed.toString();

    const segments = parsed.pathname.split("/").filter(Boolean);
    const first = segments[0];
    if (!first) return null;

    if (first.startsWith("@")) {
      if (segments.length === 1) parsed.pathname = `/${first}/videos`;
      return parsed.toString();
    }

    if ((first === "channel" || first === "user" || first === "c") && segments[1]) {
      if (segments.length === 2) parsed.pathname = `/${first}/${segments[1]}/videos`;
      return parsed.toString();
    }

    return null;
  } catch {
    return null;
  }
}

function getYouTubeTab(url: string): YouTubeTab | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const first = segments[0];
    if (!first) return null;

    const candidate = first.startsWith("@") ? segments[1] : segments[2];
    if (!candidate || !YOUTUBE_TABS.has(candidate)) return null;
    return candidate as YouTubeTab;
  } catch {
    return null;
  }
}

function classifyYouTubeUrl(url: string): YouTubeTarget | null {
  const videoId = extractVideoId(url);
  if (videoId) {
    return {
      kind: "video",
      videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  const fetchUrl = normalizeYouTubeCollectionUrl(url);
  if (!fetchUrl) return null;

  return {
    kind: "collection",
    collectionKind: hasPlaylistId(fetchUrl) ? "playlist" : "channel",
    fetchUrl,
    tab: getYouTubeTab(fetchUrl),
  };
}

function hasPlaylistId(url: string): boolean {
  try {
    return new URL(url).searchParams.has("list");
  } catch {
    return false;
  }
}

async function runYtDlp(args: string[], options: RunYtDlpOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "yt-dlp",
      args,
      { timeout: options.timeoutMs, maxBuffer: YT_DLP_MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(extractYtDlpError(err, stdout, stderr)));
          return;
        }
        resolve({ stdout, stderr });
      },
    );

    if (options.signal) {
      const onAbort = () => child.kill();
      options.signal.addEventListener("abort", onAbort, { once: true });
      child.on("exit", () => options.signal?.removeEventListener("abort", onAbort));
    }
  });
}

function extractYtDlpError(err: Error, stdout: string, stderr: string): string {
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== "null");

  const message = lines.reverse().find(Boolean) ?? err.message;
  return message.replace(/^ERROR:\s*/i, "");
}

async function getVideoTitle(videoUrl: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await runYtDlp(["--get-title", "--no-warnings", videoUrl], {
      timeoutMs: 15_000,
      signal,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function extractSubtitles(videoUrl: string, signal?: AbortSignal): Promise<string | null> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-yt-"));

  try {
    await new Promise<void>((resolve, reject) => {
      const args = [
        "--write-auto-sub",
        "--write-sub",
        "--sub-lang", "en",
        "--sub-format", "vtt/srt/best",
        "--skip-download",
        "--no-warnings",
        "-o", join(tmpDir, "%(id)s.%(ext)s"),
        videoUrl,
      ];

      const child = execFile(
        "yt-dlp",
        args,
        { timeout: 30_000, maxBuffer: YT_DLP_MAX_BUFFER },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );

      if (signal) {
        const onAbort = () => child.kill();
        signal.addEventListener("abort", onAbort, { once: true });
        child.on("exit", () => signal.removeEventListener("abort", onAbort));
      }
    });

    const files = readdirSync(tmpDir).filter((file) => file.endsWith(".vtt") || file.endsWith(".srt"));
    if (files.length === 0) return null;

    const preferred = files.find((file) => !file.includes(".auto.")) ?? files[0];
    return readFileSync(join(tmpDir, preferred), "utf-8");
  } catch {
    return null;
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

export function parseSubtitles(raw: string): string {
  const lines = raw.split("\n");
  const segments: { time: string; text: string }[] = [];
  let currentTime = "";
  let currentText: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "WEBVTT" || trimmed.startsWith("Kind:") || trimmed.startsWith("Language:") || trimmed === "") {
      if (currentTime && currentText.length > 0) {
        const text = currentText.join(" ").trim();
        if (text && !seen.has(text)) {
          seen.add(text);
          segments.push({ time: currentTime, text });
        }
        currentText = [];
      }
      continue;
    }

    const timeMatch = trimmed.match(/^(\d{1,2}:?\d{2}:\d{2})[.,]\d{3}\s*-->/);
    if (timeMatch) {
      if (currentTime && currentText.length > 0) {
        const text = currentText.join(" ").trim();
        if (text && !seen.has(text)) {
          seen.add(text);
          segments.push({ time: currentTime, text });
        }
        currentText = [];
      }
      currentTime = timeMatch[1];
      continue;
    }

    if (/^\d+$/.test(trimmed)) continue;

    const clean = trimmed
      .replace(/<[^>]+>/g, "")
      .replace(/\{[^}]+\}/g, "")
      .trim();
    if (clean) currentText.push(clean);
  }

  if (currentTime && currentText.length > 0) {
    const text = currentText.join(" ").trim();
    if (text && !seen.has(text)) {
      segments.push({ time: currentTime, text });
    }
  }

  if (segments.length === 0) return "";

  const paragraphs: string[] = [];
  let currentParagraph: string[] = [];
  let lastTimeSec = 0;

  for (const seg of segments) {
    const sec = parseTimestamp(seg.time);
    if (sec - lastTimeSec > 30 && currentParagraph.length > 0) {
      paragraphs.push(currentParagraph.join(" "));
      currentParagraph = [];
    }
    currentParagraph.push(`[${seg.time}] ${seg.text}`);
    lastTimeSec = sec;
  }
  if (currentParagraph.length > 0) paragraphs.push(currentParagraph.join(" "));

  return paragraphs.join("\n\n");
}

function parseTimestamp(ts: string): number {
  const parts = ts.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function formatDuration(durationSeconds: number | null | undefined): string | null {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }

  const totalSeconds = Math.round(durationSeconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function humanizeTab(tab: YouTubeTab | null): string | null {
  if (!tab) return null;
  return tab.charAt(0).toUpperCase() + tab.slice(1);
}

function resolveEntryUrl(entry: YtDlpCollectionEntry): string | null {
  if (entry.url?.startsWith("http://") || entry.url?.startsWith("https://")) return entry.url;
  if (!entry.id) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(entry.id)) return `https://www.youtube.com/watch?v=${entry.id}`;
  if (entry.id.startsWith("PL")) return `https://www.youtube.com/playlist?list=${entry.id}`;
  return null;
}

function sanitizeFileSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "collection";
}

function buildCollectionFilePath(
  target: Extract<YouTubeTarget, { kind: "collection" }>,
  info: YtDlpCollectionInfo,
): string {
  mkdirSync(YOUTUBE_LIST_CACHE_DIR, { recursive: true });
  const identity = sanitizeFileSegment(
    info.id
      || info.channel_id
      || info.uploader_id
      || createHash("sha1").update(target.fetchUrl).digest("hex").slice(0, 12),
  );
  const scope = target.tab ? `${target.collectionKind}-${target.tab}` : target.collectionKind;
  return join(YOUTUBE_LIST_CACHE_DIR, `${scope}--${identity}.md`);
}

function renderCollectionContent(
  target: Extract<YouTubeTarget, { kind: "collection" }>,
  info: YtDlpCollectionInfo,
  options: CollectionRenderOptions,
): string {
  const entries = info.entries ?? [];
  const owner = info.channel || info.uploader || null;
  const displayUrl = info.webpage_url || target.fetchUrl;
  const title = info.title || info.id || "YouTube";
  const tabLabel = humanizeTab(target.tab);
  const summary: string[] = [];

  if (target.collectionKind === "playlist") {
    summary.push(`**YouTube Playlist:** ${title}`);
    if (owner) summary.push(`**Owner:** ${owner}`);
  } else {
    summary.push(`**YouTube Channel:** ${owner || title}`);
    if (tabLabel) summary.push(`**Tab:** ${tabLabel}`);
  }

  summary.push(`**URL:** ${displayUrl}`);
  if (options.includeFullListPath && options.fullListPath) {
    summary.push(`**Full list file:** ${options.fullListPath}`);
  }
  summary.push(
    `**Items shown:** ${options.shownCount}${options.shownCount === options.totalCount ? "" : ` of ${options.totalCount}`}`,
  );
  if (options.truncated && options.fullListPath) {
    summary.push(`**Truncated list:** first ${options.shownCount} of ${options.totalCount}, rest at ${options.fullListPath}`);
  }

  const heading = target.collectionKind === "playlist"
    ? "Videos"
    : tabLabel ?? "Entries";

  const body = entries.map((entry, index) => {
    const lines = [`${index + 1}. ${entry.title || entry.id || "Untitled"}`];
    const url = resolveEntryUrl(entry);
    if (url) lines.push(`   ${url}`);

    const details: string[] = [];
    const duration = formatDuration(entry.duration);
    if (duration) details.push(`Duration: ${duration}`);
    if (entry.availability && entry.availability !== "public") {
      details.push(`Availability: ${entry.availability}`);
    }
    if (details.length > 0) lines.push(`   ${details.join(" • ")}`);

    return lines.join("\n");
  });

  return [
    ...summary,
    "",
    `## ${heading}`,
    "",
    ...body,
  ].join("\n");
}

async function getCollectionInfo(
  target: Extract<YouTubeTarget, { kind: "collection" }>,
  signal?: AbortSignal,
): Promise<YtDlpCollectionInfo> {
  const { stdout } = await runYtDlp([
    "--flat-playlist",
    "--dump-single-json",
    "--no-warnings",
    "--playlist-end", "1",
    target.fetchUrl,
  ], {
    timeoutMs: 30_000,
    signal,
  });

  return JSON.parse(stdout) as YtDlpCollectionInfo;
}

function pickEntryFields(raw: unknown): YtDlpCollectionEntry {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    id: typeof data.id === "string" ? data.id : undefined,
    title: typeof data.title === "string" ? data.title : undefined,
    url: typeof data.url === "string" ? data.url : undefined,
    duration: typeof data.duration === "number" && Number.isFinite(data.duration) ? data.duration : null,
    availability: typeof data.availability === "string" ? data.availability : null,
  };
}

async function getCollectionEntries(
  target: Extract<YouTubeTarget, { kind: "collection" }>,
  signal?: AbortSignal,
): Promise<YtDlpCollectionEntry[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "yt-dlp",
      ["--flat-playlist", "--print-json", "--no-warnings", target.fetchUrl],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const entries: YtDlpCollectionEntry[] = [];
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let stderr = "";
    let settled = false;

    const cleanup = () => {
      rl.removeAllListeners();
      child.removeAllListeners();
      child.stderr.removeAllListeners();
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(entries);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        entries.push(pickEntryFields(JSON.parse(trimmed)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        fail(new Error(`Failed to parse yt-dlp playlist entry: ${message}`));
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      fail(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      fail(new Error(extractYtDlpError(
        new Error(`yt-dlp exited with code ${code ?? "unknown"}`),
        "",
        stderr,
      )));
    });

    const onAbort = () => {
      child.kill();
      fail(new Error("Cancelled"));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function writeCollectionDump(
  target: Extract<YouTubeTarget, { kind: "collection" }>,
  info: YtDlpCollectionInfo,
  entries: YtDlpCollectionEntry[],
): string {
  const fullListPath = buildCollectionFilePath(target, info);
  const content = renderCollectionContent(target, { ...info, entries }, {
    shownCount: entries.length,
    totalCount: entries.length,
    fullListPath: null,
    truncated: false,
    includeFullListPath: false,
  });
  writeFileSync(fullListPath, content, "utf-8");
  return fullListPath;
}

async function fetchCollection(
  originalUrl: string,
  target: Extract<YouTubeTarget, { kind: "collection" }>,
  verbose: boolean,
  signal?: AbortSignal,
): Promise<FetchResult> {
  let info: YtDlpCollectionInfo;
  let entries: YtDlpCollectionEntry[];

  try {
    [info, entries] = await Promise.all([
      getCollectionInfo(target, signal),
      getCollectionEntries(target, signal),
    ]);
  } catch (err) {
    return {
      url: originalUrl,
      title: "",
      content: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (entries.length === 0) {
    return {
      url: originalUrl,
      title: info.title || info.channel || info.uploader || "",
      content: "",
      error: "No entries were found for this YouTube collection.",
    };
  }

  let fullListPath: string;
  try {
    fullListPath = writeCollectionDump(target, info, entries);
  } catch (err) {
    return {
      url: originalUrl,
      title: info.title || info.channel || info.uploader || "",
      content: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const visibleEntries = verbose ? entries : entries.slice(0, DEFAULT_COLLECTION_LIMIT);
  const content = renderCollectionContent(target, { ...info, entries: visibleEntries }, {
    shownCount: visibleEntries.length,
    totalCount: entries.length,
    fullListPath,
    truncated: !verbose && entries.length > visibleEntries.length,
    includeFullListPath: true,
  });

  return {
    url: originalUrl,
    title: info.title || info.channel || info.uploader || target.fetchUrl,
    content,
    error: null,
  };
}

async function fetchVideo(
  originalUrl: string,
  videoId: string,
  videoUrl: string,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const [title, subtitleRaw] = await Promise.all([
    getVideoTitle(videoUrl, signal),
    extractSubtitles(videoUrl, signal),
  ]);

  if (!subtitleRaw) {
    return {
      url: originalUrl,
      title: title || videoId,
      content: "",
      error: "No subtitles available for this video. It may not have captions enabled.",
    };
  }

  const transcript = parseSubtitles(subtitleRaw);
  if (!transcript) {
    return {
      url: originalUrl,
      title: title || videoId,
      content: "",
      error: "Subtitle file was empty or could not be parsed",
    };
  }

  const content = [
    `**YouTube Video:** ${title || videoId}`,
    `**URL:** ${videoUrl}`,
    "",
    "## Transcript",
    "",
    transcript,
  ].join("\n");

  return { url: originalUrl, title: title || videoId, content, error: null };
}

export interface FetchYouTubeOptions {
  verbose?: boolean;
  signal?: AbortSignal;
}

export async function fetchYouTube(url: string, options: FetchYouTubeOptions = {}): Promise<FetchResult> {
  const target = classifyYouTubeUrl(url);
  if (!target) {
    return {
      url,
      title: "",
      content: "",
      error: "Unsupported YouTube URL. Use a video, playlist, or channel URL.",
    };
  }

  const available = await checkYtDlp();
  if (!available) {
    return {
      url,
      title: "",
      content: "",
      error: "yt-dlp is required for YouTube content. Install with: brew install yt-dlp",
    };
  }

  if (target.kind === "video") {
    return fetchVideo(url, target.videoId, target.videoUrl, options.signal);
  }

  return fetchCollection(url, target, options.verbose ?? false, options.signal);
}

export const __test__ = {
  classifyYouTubeUrl,
  normalizeYouTubeCollectionUrl,
  getYouTubeTab,
  formatDuration,
  renderCollectionContent,
  buildCollectionFilePath,
};
