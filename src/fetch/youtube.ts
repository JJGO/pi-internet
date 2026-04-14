/**
 * YouTube transcript extraction via yt-dlp.
 *
 * Provenance: Original implementation (yt-dlp approach).
 * YouTube URL detection patterns borrowed from pi-web-access/youtube-extract.ts.
 *
 * Uses `yt-dlp --write-auto-sub --skip-download` to extract subtitles.
 * Parses VTT/SRT format into timestamped text.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FetchResult } from "./http.js";

let ytDlpAvailable: boolean | null = null;

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

    // youtu.be/VIDEO_ID
    if (host === "youtu.be") return parsed.pathname.slice(1).split("/")[0] || null;

    // youtube.com/watch?v=VIDEO_ID
    if (parsed.searchParams.has("v")) return parsed.searchParams.get("v");

    // youtube.com/shorts/VIDEO_ID, /live/VIDEO_ID, /embed/VIDEO_ID, /v/VIDEO_ID
    const pathMatch = parsed.pathname.match(/^\/(shorts|live|embed|v)\/([^/?]+)/);
    if (pathMatch) return pathMatch[2];

    return null;
  } catch {
    return null;
  }
}

/** Get video title via yt-dlp --get-title */
async function getVideoTitle(videoUrl: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      "yt-dlp",
      ["--get-title", "--no-warnings", videoUrl],
      { timeout: 15_000 },
      (err, stdout) => {
        resolve(err ? "" : stdout.trim());
      },
    );

    if (signal) {
      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("exit", () => signal.removeEventListener("abort", onAbort));
    }
  });
}

/** Extract subtitles via yt-dlp to a temp directory, return the subtitle file content */
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

      const child = execFile("yt-dlp", args, { timeout: 30_000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });

      if (signal) {
        const onAbort = () => child.kill();
        signal.addEventListener("abort", onAbort, { once: true });
        child.on("exit", () => signal.removeEventListener("abort", onAbort));
      }
    });

    // Find the subtitle file
    const files = readdirSync(tmpDir).filter(
      (f) => f.endsWith(".vtt") || f.endsWith(".srt"),
    );
    if (files.length === 0) return null;

    // Prefer non-auto-generated
    const preferred = files.find((f) => !f.includes(".auto.")) ?? files[0];
    return readFileSync(join(tmpDir, preferred), "utf-8");
  } catch {
    return null;
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/** Parse VTT/SRT subtitle content into clean timestamped text */
export function parseSubtitles(raw: string): string {
  const lines = raw.split("\n");
  const segments: { time: string; text: string }[] = [];
  let currentTime = "";
  let currentText: string[] = [];
  const seen = new Set<string>(); // Dedup repeated auto-sub lines

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip VTT header and metadata
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

    // Timestamp line: "00:00:01.000 --> 00:00:04.000" or "1\n00:00:01,000 --> 00:00:04,000"
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

    // Skip numeric sequence identifiers (SRT format)
    if (/^\d+$/.test(trimmed)) continue;

    // Content line — strip HTML tags and VTT position tags
    const clean = trimmed
      .replace(/<[^>]+>/g, "")
      .replace(/\{[^}]+\}/g, "")
      .trim();
    if (clean) currentText.push(clean);
  }

  // Flush last segment
  if (currentTime && currentText.length > 0) {
    const text = currentText.join(" ").trim();
    if (text && !seen.has(text)) {
      segments.push({ time: currentTime, text });
    }
  }

  if (segments.length === 0) return "";

  // Group into paragraphs (every ~30 seconds)
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

// ── Public API ─────────────────────────────────────────────────

export async function fetchYouTube(url: string, signal?: AbortSignal): Promise<FetchResult> {
  const videoId = extractVideoId(url);
  if (!videoId) {
    return { url, title: "", content: "", error: "Could not extract YouTube video ID from URL" };
  }

  const available = await checkYtDlp();
  if (!available) {
    return {
      url, title: "", content: "",
      error: "yt-dlp is required for YouTube transcripts. Install with: brew install yt-dlp",
    };
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Get title and subtitles in parallel
  const [title, subtitleRaw] = await Promise.all([
    getVideoTitle(videoUrl, signal),
    extractSubtitles(videoUrl, signal),
  ]);

  if (!subtitleRaw) {
    return {
      url,
      title: title || videoId,
      content: "",
      error: "No subtitles available for this video. It may not have captions enabled.",
    };
  }

  const transcript = parseSubtitles(subtitleRaw);
  if (!transcript) {
    return {
      url,
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

  return { url, title: title || videoId, content, error: null };
}
