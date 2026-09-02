import { readFile, rm, writeFile, mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getDocumentProxy, resolvePDFJSImport } from "unpdf";
import * as bundledPdfJs from "unpdf/pdfjs";
import type { FetchResult } from "./http.js";
import { downloadResponseToFile } from "../util/download.js";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_PAGES = 100;

export interface PdfExtraction {
  url: string;
  title: string;
  author: string;
  content: string;
  error: string | null;
  pageCount: number;
  extractedPages: number;
  pdfPath: string;
  markdownPath: string;
}

let pdfJsConfigured = false;

async function configurePdfJs(): Promise<void> {
  if (pdfJsConfigured) return;
  await resolvePDFJSImport(async () => bundledPdfJs);
  pdfJsConfigured = true;
}

export function hasPdfSignature(header: Uint8Array): boolean {
  return Buffer.from(header).indexOf("%PDF-") >= 0;
}

export async function downloadAndExtractPdf(
  response: Response,
  url: string,
  signal?: AbortSignal,
): Promise<PdfExtraction> {
  const directory = await mkdtemp(join(tmpdir(), "pi-internet-pdf-"));
  await chmod(directory, 0o700);
  const pdfPath = join(directory, "document.pdf");
  const markdownPath = join(directory, "document.md");

  try {
    const download = await downloadResponseToFile(response, pdfPath, MAX_PDF_BYTES, signal);
    if (!hasPdfSignature(download.header)) {
      throw new Error("Response does not have a valid PDF signature");
    }
    return await extractPdfFromFile(pdfPath, markdownPath, url, signal);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function extractPdfFromFile(
  pdfPath: string,
  markdownPath: string,
  url: string,
  signal?: AbortSignal,
): Promise<PdfExtraction> {
  signal?.throwIfAborted();
  await configurePdfJs();
  const data = await readFile(pdfPath);
  if (data.byteLength > MAX_PDF_BYTES) throw new Error("PDF exceeds the 20 MiB limit");

  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    signal?.throwIfAborted();
    const metadata = await pdf.getMetadata();
    const info = metadata.info && typeof metadata.info === "object"
      ? metadata.info as Record<string, unknown>
      : null;
    const title = stringMetadata(info?.Title) || extractTitleFromUrl(url);
    const author = stringMetadata(info?.Author);
    const extractedPages = Math.min(pdf.numPages, DEFAULT_MAX_PAGES);
    const pages: Array<{ page: number; text: string }> = [];

    for (let pageNumber = 1; pageNumber <= extractedPages; pageNumber++) {
      signal?.throwIfAborted();
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      let text = "";
      for (const item of textContent.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (!item.str) continue;
        text += item.str;
        text += item.hasEOL ? "\n" : " ";
      }
      pages.push({
        page: pageNumber,
        text: text.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim(),
      });
    }

    const populatedPages = pages.filter((page) => page.text);
    const lines: string[] = [];
    if (populatedPages.length === 0) {
      lines.push(
        "> ⚠️ No extractable text layer was found. This PDF may be scanned or image-only and may require OCR.",
      );
    } else {
      for (const page of populatedPages) {
        if (lines.length > 0) lines.push("");
        lines.push(`<!-- Page ${page.page} -->`, "", page.text);
      }
    }

    if (pdf.numPages > extractedPages) {
      lines.push(
        "",
        `> ⚠️ Extracted pages 1–${extractedPages} of ${pdf.numPages}. The complete PDF is available at ${pdfPath}.`,
      );
    }

    return {
      url,
      title,
      author,
      content: lines.join("\n"),
      error: populatedPages.length === 0 ? "PDF has no extractable text layer; OCR may be required" : null,
      pageCount: pdf.numPages,
      extractedPages,
      pdfPath,
      markdownPath,
    };
  } finally {
    await pdf.destroy();
  }
}

export async function finalizePdfResult(
  extraction: PdfExtraction,
  preamble: string,
  title = extraction.title,
): Promise<FetchResult> {
  const content = [preamble.trim(), extraction.content.trim()].filter(Boolean).join("\n\n---\n\n");
  const warning = extraction.error ? `\n\n> ⚠️ ${extraction.error}` : "";
  await writeFile(extraction.markdownPath, `# ${title}\n\n${content}${warning}`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    url: extraction.url,
    title,
    content,
    error: extraction.error,
    fullOutputPath: extraction.markdownPath,
    artifacts: {
      pdf: extraction.pdfPath,
      markdown: extraction.markdownPath,
    },
  };
}

export function renderGenericPdfPreamble(extraction: PdfExtraction): string {
  const pages = extraction.pageCount > extraction.extractedPages
    ? `${extraction.extractedPages} of ${extraction.pageCount}`
    : String(extraction.pageCount);
  const lines = [
    "## PDF artifacts",
    "",
    `- Original PDF: ${extraction.pdfPath}`,
    `- Extracted Markdown: ${extraction.markdownPath}`,
    `- Pages extracted: ${pages}`,
  ];
  if (extraction.author) lines.push(`- Author: ${extraction.author}`);
  lines.push(
    "",
    "> Extraction reads the PDF text layer. Layout, tables, equations, figures, and scans may not be represented faithfully.",
  );
  return lines.join("\n");
}

function stringMetadata(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractTitleFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return basename(pathname, ".pdf")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "document";
  } catch {
    return "document";
  }
}
