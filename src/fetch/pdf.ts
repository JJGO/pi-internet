/**
 * PDF text extraction — fetch, extract, save as markdown.
 *
 * Provenance: pi-web-access/pdf-extract.ts
 * Borrowed: unpdf extraction, page-by-page text with markers, metadata extraction,
 * save-to-file pattern, arxiv URL title handling.
 */

import { getDocumentProxy } from "unpdf";
import { writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { FetchResult } from "./http.js";
import { combinedSignal } from "../util/signal.js";
import { fetchWithProxy } from "../util/proxy.js";

const DEFAULT_OUTPUT_DIR = join(homedir(), "Downloads");
const DEFAULT_MAX_PAGES = 100;
const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20MB

/**
 * Fetch a PDF from a URL, extract text, return markdown.
 */
export async function fetchPdf(
  url: string,
  signal?: AbortSignal,
  socksProxy?: string | null,
): Promise<FetchResult> {
  let response: Response;
  try {
    response = await fetchWithProxy(url, {
      signal: combinedSignal(signal, 60_000),
      headers: { "User-Agent": "pi-internet/0.1" },
    }, {
      socksProxy,
    });
  } catch (err) {
    return { url, title: "", content: "", error: `Failed to fetch PDF: ${err instanceof Error ? err.message : err}` };
  }

  if (!response.ok) {
    return { url, title: "", content: "", error: `HTTP ${response.status}: ${response.statusText}` };
  }

  const ct = response.headers.get("content-type") || "";
  if (!ct.includes("pdf") && !url.toLowerCase().endsWith(".pdf")) {
    return { url, title: "", content: "", error: "URL does not point to a PDF" };
  }

  const buffer = await response.arrayBuffer();
  return extractPdfFromBuffer(buffer, url);
}

/**
 * Extract text from a PDF buffer. Called by fetchPdf() after downloading,
 * and by httpFetch() when content-type is application/pdf (REVIEW §2.2).
 */
export async function extractPdfFromBuffer(buffer: ArrayBuffer, url: string): Promise<FetchResult> {
  if (buffer.byteLength > MAX_PDF_BYTES) {
    return { url, title: "", content: "", error: `PDF too large (${Math.round(buffer.byteLength / 1024 / 1024)}MB)` };
  }

  // Extract text
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const metadata = await pdf.getMetadata();
  const metaInfo = metadata.info && typeof metadata.info === "object"
    ? metadata.info as Record<string, unknown>
    : null;

  const metaTitle = typeof metaInfo?.Title === "string" ? metaInfo.Title.trim() : "";
  const metaAuthor = typeof metaInfo?.Author === "string" ? metaInfo.Author.trim() : "";
  const title = metaTitle || extractTitleFromUrl(url);

  const pagesToExtract = Math.min(pdf.numPages, DEFAULT_MAX_PAGES);
  const truncated = pdf.numPages > DEFAULT_MAX_PAGES;

  const pages: string[] = [];
  for (let i = 1; i <= pagesToExtract; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item: unknown) => (item as { str?: string }).str || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) pages.push(text);
  }

  // Build markdown
  const lines: string[] = [
    `# ${title}`,
    "",
    `> Source: ${url}`,
    `> Pages: ${pdf.numPages}${truncated ? ` (extracted first ${pagesToExtract})` : ""}`,
  ];
  if (metaAuthor) lines.push(`> Author: ${metaAuthor}`);
  lines.push("", "---", "");

  for (let i = 0; i < pages.length; i++) {
    if (i > 0) lines.push("", `<!-- Page ${i + 2} -->`, "");
    lines.push(pages[i]);
  }

  if (truncated) {
    lines.push("", "---", "", `*[Truncated: Only first ${pagesToExtract} of ${pdf.numPages} pages extracted]*`);
  }

  const mdContent = lines.join("\n");

  // Only save to ~/Downloads when content is large (>50KB).
  // Small PDFs are returned inline without side-effects.
  const SAVE_THRESHOLD = 50 * 1024;
  let content: string;

  if (mdContent.length > SAVE_THRESHOLD) {
    const outputFilename = sanitizeFilename(title) + ".md";
    const outputPath = join(DEFAULT_OUTPUT_DIR, outputFilename);
    await mkdir(DEFAULT_OUTPUT_DIR, { recursive: true });
    await writeFile(outputPath, mdContent, "utf-8");
    content = `PDF extracted and saved to: ${outputPath}\n\nPages: ${pdf.numPages}\nCharacters: ${mdContent.length}\n\n---\n\n${mdContent}`;
  } else {
    content = mdContent;
  }

  return { url, title, content, error: null };
}

function extractTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let filename = basename(parsed.pathname, ".pdf");

    // Arxiv: /pdf/1706.03762 → "arxiv-1706.03762"
    if (parsed.hostname.includes("arxiv.org")) {
      const match = parsed.pathname.match(/\/(?:pdf|abs)\/(\d+\.\d+)/);
      if (match) filename = `arxiv-${match[1]}`;
    }

    return filename.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "document";
  } catch {
    return "document";
  }
}

function sanitizeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 100).replace(/^-|-$/g, "") || "document";
}
