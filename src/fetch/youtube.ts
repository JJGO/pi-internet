/**
 * YouTube fetching via yt-dlp.
 *
 * Single-video URLs return metadata, a cleaned description, chapters, and
 * timestamped transcripts. Playlist and channel URLs return compact collection
 * summaries. Vision-capable sessions can request a video frame by adding the
 * pi-internet-screenshot query parameter to a video URL.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execCommand, isCommandAvailable } from "../util/exec.js";
import type { FetchResult } from "./http.js";

const DEFAULT_COLLECTION_LIMIT = 25;
const YT_DLP_MAX_BUFFER = 5 * 1024 * 1024;
const YOUTUBE_TABS = new Set(["videos", "shorts", "streams", "playlists"]);
const YOUTUBE_LIST_CACHE_DIR = join(homedir(), ".cache", "pi-internet", "youtube-lists");
const SCREENSHOT_PARAM = "pi-internet-screenshot";
const DESCRIPTION_INPUT_LIMIT = 12_000;
const DESCRIPTION_OUTPUT_LIMIT = 2_000;
const SCREENSHOT_FORMAT = "image/jpeg";
const FRAME_WIDTH = 1280;

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

interface RunCommandOptions {
  timeoutMs: number;
  maxBuffer?: number;
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

interface YtDlpChapter {
  title?: string;
  start_time?: number;
  end_time?: number;
}

interface YtDlpVideoInfo {
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number | null;
  upload_date?: string;
  webpage_url?: string;
  description?: string;
  chapters?: YtDlpChapter[];
}

interface CollectionRenderOptions {
  shownCount: number;
  totalCount: number;
  fullListPath: string | null;
  truncated: boolean;
  includeFullListPath: boolean;
}

interface ScreenshotDirective {
  cleanUrl: string;
  timestamp: string;
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

function extractScreenshotDirective(url: string): ScreenshotDirective | null {
  try {
    const parsed = new URL(url);
    const timestamp = parsed.searchParams.get(SCREENSHOT_PARAM);
    if (!timestamp) return null;
    parsed.searchParams.delete(SCREENSHOT_PARAM);
    return { cleanUrl: parsed.toString(), timestamp };
  } catch {
    return null;
  }
}

function parseVideoTimestamp(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  const parts = trimmed.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((part) => /^\d+(?:\.\d+)?$/.test(part))) return null;

  const nums = parts.map(Number);
  if (!nums.every((num) => Number.isFinite(num) && num >= 0)) return null;

  const secondsPart = nums.at(-1)!;
  const minutesPart = nums.at(-2)!;
  if (secondsPart >= 60 || minutesPart >= 60) return null;

  if (nums.length === 2) return minutesPart * 60 + secondsPart;
  return nums[0] * 3600 + minutesPart * 60 + secondsPart;
}

function formatTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${two(hours)}:${two(minutes)}:${two(secs)}`
    : `${two(minutes)}:${two(secs)}`;
}

function capText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).replace(/\s+\S*$/, "").trimEnd() + "…";
}

function normalizeMarkdownBlock(text: string): string {
  return text
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

async function runCommand(command: string, args: string[], options: RunCommandOptions): Promise<{ stdout: string; stderr: string }> {
  const result = await execCommand(command, args, {
    timeoutMs: options.timeoutMs,
    maxBuffer: options.maxBuffer ?? YT_DLP_MAX_BUFFER,
    signal: options.signal,
  });
  if (!result.ok) {
    throw new Error(extractCommandError(new Error(result.error ?? "command failed"), result.stdout, result.stderr));
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function extractCommandError(err: Error, stdout: string | Buffer, stderr: string | Buffer): string {
  const lines = `${stderr.toString()}\n${stdout.toString()}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== "null");

  const message = lines.reverse().find(Boolean) ?? err.message;
  return message.replace(/^ERROR:\s*/i, "");
}

async function getVideoInfo(videoUrl: string, signal?: AbortSignal): Promise<YtDlpVideoInfo | null> {
  try {
    const { stdout } = await runCommand("yt-dlp", [
      "--dump-single-json",
      "--skip-download",
      "--no-warnings",
      videoUrl,
    ], {
      timeoutMs: 30_000,
      signal,
    });
    return JSON.parse(stdout) as YtDlpVideoInfo;
  } catch {
    return null;
  }
}

async function extractSubtitles(videoUrl: string, signal?: AbortSignal): Promise<string | null> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-yt-"));

  try {
    await runCommand("yt-dlp", [
      "--write-auto-sub",
      "--write-sub",
      "--sub-lang", "en",
      "--sub-format", "vtt/srt/best",
      "--skip-download",
      "--no-warnings",
      "-o", join(tmpDir, "%(id)s.%(ext)s"),
      videoUrl,
    ], { timeoutMs: 30_000, signal });

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

  const flushSegment = () => {
    if (!currentTime || currentText.length === 0) return;
    const text = currentText.join(" ").trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      segments.push({ time: currentTime, text });
    }
    currentText = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "WEBVTT" || trimmed.startsWith("Kind:") || trimmed.startsWith("Language:") || trimmed === "") {
      flushSegment();
      continue;
    }

    const timeMatch = trimmed.match(/^(\d{1,2}:?\d{2}:\d{2})[.,]\d{3}\s*-->/);
    if (timeMatch) {
      flushSegment();
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

  flushSegment();

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

function formatUploadDate(value: string | undefined): string | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
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

function renderChapters(chapters: YtDlpChapter[] | undefined): string[] {
  if (!chapters?.length) return [];
  const lines = ["## Chapters", ""];
  for (const chapter of chapters) {
    if (typeof chapter.start_time !== "number" || !Number.isFinite(chapter.start_time)) continue;
    const title = chapter.title?.trim() || "Untitled";
    lines.push(`- [${formatTimestamp(chapter.start_time)}] ${title}`);
  }
  return lines.length > 2 ? [...lines, ""] : [];
}

function renderVideoContent(
  videoId: string,
  videoUrl: string,
  info: YtDlpVideoInfo | null,
  transcript: string,
  description: string,
  allowScreenshots: boolean,
): string {
  const title = info?.title || videoId;
  const channel = info?.channel || info?.uploader || null;
  const duration = formatDuration(info?.duration);
  const uploadDate = formatUploadDate(info?.upload_date);
  const displayUrl = info?.webpage_url || videoUrl;
  const summary = [`**YouTube Video:** ${title}`];

  if (channel) summary.push(`**Channel:** ${channel}`);
  if (duration) summary.push(`**Duration:** ${duration}`);
  if (uploadDate) summary.push(`**Uploaded:** ${uploadDate}`);
  summary.push(`**URL:** ${displayUrl}`);

  if (allowScreenshots) {
    summary.push(
      "",
      `> Visual frame inspection: fetch this video URL with \`&${SCREENSHOT_PARAM}=HH:MM:SS\` to inspect a frame from a transcript timestamp, e.g. \`&${SCREENSHOT_PARAM}=00:02:10\`.`,
    );
  }

  const lines = [...summary, ""];
  if (description) {
    lines.push("## Description", "", description, "");
  }
  lines.push(...renderChapters(info?.chapters));
  lines.push("## Transcript", "", transcript);
  return lines.join("\n");
}

async function getCollectionInfo(
  target: Extract<YouTubeTarget, { kind: "collection" }>,
  signal?: AbortSignal,
): Promise<YtDlpCollectionInfo> {
  const { stdout } = await runCommand("yt-dlp", [
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
      fail(new Error(extractCommandError(
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

async function cleanDescription(
  rawDescription: string | undefined,
  cleanYouTubeDescription: ((description: string) => Promise<string>) | undefined,
): Promise<string> {
  const cappedRaw = capText(rawDescription ?? "", DESCRIPTION_OUTPUT_LIMIT);
  if (!rawDescription?.trim()) return "";
  if (!cleanYouTubeDescription) return cappedRaw;

  try {
    const cleaned = normalizeMarkdownBlock(
      await cleanYouTubeDescription(capText(rawDescription, DESCRIPTION_INPUT_LIMIT)),
    );
    return capText(cleaned, DESCRIPTION_OUTPUT_LIMIT) || cappedRaw;
  } catch {
    return cappedRaw;
  }
}

async function fetchVideo(
  originalUrl: string,
  videoId: string,
  videoUrl: string,
  options: FetchYouTubeOptions,
): Promise<FetchResult> {
  const [info, subtitleRaw] = await Promise.all([
    getVideoInfo(videoUrl, options.signal),
    extractSubtitles(videoUrl, options.signal),
  ]);

  const title = info?.title || videoId;

  if (!subtitleRaw) {
    return {
      url: originalUrl,
      title,
      content: "",
      error: "No subtitles available for this video. It may not have captions enabled.",
    };
  }

  const transcript = parseSubtitles(subtitleRaw);
  if (!transcript) {
    return {
      url: originalUrl,
      title,
      content: "",
      error: "Subtitle file was empty or could not be parsed",
    };
  }

  const description = await cleanDescription(info?.description, options.cleanYouTubeDescription);
  const content = renderVideoContent(
    videoId,
    videoUrl,
    info,
    transcript,
    description,
    options.allowImages ?? false,
  );

  return { url: originalUrl, title, content, error: null };
}

async function resolveVideoStreamUrl(videoUrl: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await runCommand("yt-dlp", [
    "-f", "bestvideo[height<=1080]/best[height<=1080]/best",
    "--get-url",
    "--no-warnings",
    videoUrl,
  ], {
    timeoutMs: 30_000,
    signal,
  });

  const streamUrl = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("http"));
  if (!streamUrl) throw new Error("yt-dlp did not return a playable video stream URL");
  return streamUrl;
}

async function captureFrame(videoUrl: string, timestampSeconds: number, signal?: AbortSignal): Promise<{ path: string; data: string; mimeType: string }> {
  const hasFfmpeg = await isCommandAvailable("ffmpeg");
  if (!hasFfmpeg) {
    throw new Error("ffmpeg is required for YouTube screenshots. Install with: brew install ffmpeg");
  }

  const streamUrl = await resolveVideoStreamUrl(videoUrl, signal);
  const tempDir = mkdtempSync(join(tmpdir(), "pi-yt-frame-"));
  const outputPath = join(tempDir, `frame-${Math.round(timestampSeconds * 1000)}.jpg`);

  await runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-ss", String(timestampSeconds),
    "-i", streamUrl,
    "-frames:v", "1",
    "-vf", `scale=min(${FRAME_WIDTH}\\,iw):-2`,
    "-q:v", "3",
    outputPath,
  ], {
    timeoutMs: 45_000,
    maxBuffer: 1024 * 1024,
    signal,
  });

  if (!existsSync(outputPath)) throw new Error("ffmpeg did not produce a screenshot frame");

  return {
    path: outputPath,
    data: readFileSync(outputPath).toString("base64"),
    mimeType: SCREENSHOT_FORMAT,
  };
}

async function fetchVideoScreenshot(
  originalUrl: string,
  target: Extract<YouTubeTarget, { kind: "video" }>,
  timestampText: string,
  options: FetchYouTubeOptions,
): Promise<FetchResult> {
  if (!options.allowImages) {
    return {
      url: originalUrl,
      title: target.videoId,
      content: "",
      error: "The current model does not support image input. Switch to a vision-capable model to fetch YouTube screenshots.",
    };
  }

  const timestampSeconds = parseVideoTimestamp(timestampText);
  if (timestampSeconds === null) {
    return {
      url: originalUrl,
      title: target.videoId,
      content: "",
      error: `Invalid ${SCREENSHOT_PARAM} timestamp. Use seconds, MM:SS, or HH:MM:SS.`,
    };
  }

  try {
    const frame = await captureFrame(target.videoUrl, timestampSeconds, options.signal);
    const displayTimestamp = formatTimestamp(timestampSeconds);
    return {
      url: originalUrl,
      title: `YouTube screenshot ${displayTimestamp}`,
      content: [
        `YouTube screenshot at ${displayTimestamp} from ${target.videoUrl}.`,
        `Temporary file: ${frame.path}`,
      ].join("\n"),
      error: null,
      images: [{ data: frame.data, mimeType: frame.mimeType }],
    };
  } catch (err) {
    return {
      url: originalUrl,
      title: target.videoId,
      content: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface FetchYouTubeOptions {
  verbose?: boolean;
  allowImages?: boolean;
  cleanYouTubeDescription?: (description: string) => Promise<string>;
  signal?: AbortSignal;
}

export async function fetchYouTube(url: string, options: FetchYouTubeOptions = {}): Promise<FetchResult> {
  const screenshotDirective = extractScreenshotDirective(url);
  const cleanUrl = screenshotDirective?.cleanUrl ?? url;
  const target = classifyYouTubeUrl(cleanUrl);
  if (!target) {
    return {
      url,
      title: "",
      content: "",
      error: "Unsupported YouTube URL. Use a video, playlist, or channel URL.",
    };
  }

  const available = await isCommandAvailable("yt-dlp");
  if (!available) {
    return {
      url,
      title: "",
      content: "",
      error: "yt-dlp is required for YouTube content. Install with: brew install yt-dlp",
    };
  }

  if (screenshotDirective) {
    if (target.kind !== "video") {
      return {
        url,
        title: "",
        content: "",
        error: `${SCREENSHOT_PARAM} only works with single YouTube video URLs.`,
      };
    }
    return fetchVideoScreenshot(url, target, screenshotDirective.timestamp, options);
  }

  if (target.kind === "video") {
    return fetchVideo(url, target.videoId, target.videoUrl, options);
  }

  return fetchCollection(url, target, options.verbose ?? false, options.signal);
}

export const __test__ = {
  classifyYouTubeUrl,
  normalizeYouTubeCollectionUrl,
  getYouTubeTab,
  extractScreenshotDirective,
  parseVideoTimestamp,
  formatTimestamp,
  capText,
  renderVideoContent,
  formatDuration,
  renderCollectionContent,
  buildCollectionFilePath,
};
