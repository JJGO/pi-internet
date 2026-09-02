import { readFile, rm, writeFile, mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getDocumentProxy, resolvePDFJSImport } from "unpdf";
import * as bundledPdfJs from "unpdf/pdfjs";
import type { FetchResult } from "./http.js";
import { downloadResponseToFile } from "../util/download.js";
import { execCommand } from "../util/exec.js";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_PAGES = 100;

/**
 * External converters produce markedly better structure than unpdf's
 * flattened text layer (headings, tables, reading order), so "auto" tries
 * pymupdf4llm, then pdftotext -layout, then falls back to bundled unpdf.
 * External converters are local CLIs only; the PDF never leaves the machine.
 */
export type PdfConverter = "auto" | "pymupdf4llm" | "pdftotext" | "unpdf";

const CONVERTER_TIMEOUT_MS = 60_000;
const CONVERTER_MAX_BUFFER = 64 * 1024 * 1024;

// Emits the same `<!-- Page N -->` markers as the unpdf path so downstream
// consumers (and page-number citations) behave identically across engines.
const PYMUPDF4LLM_SCRIPT = `
import contextlib
import sys

# pymupdf prints advisory notices to stdout on import; keep stdout clean.
with contextlib.redirect_stdout(sys.stderr):
    import pymupdf4llm
    chunks = pymupdf4llm.to_markdown(sys.argv[1], pages=list(range(int(sys.argv[2]))), page_chunks=True, show_progress=False)
for index, chunk in enumerate(chunks):
    text = chunk["text"].strip()
    if not text:
        continue
    page = chunk.get("metadata", {}).get("page") or (index + 1)  # metadata page is 1-based
    print(f"<!-- Page {page} -->")
    print()
    print(text)
    print()
`;

interface ConverterCommand {
  command: string;
  args: (pdfPath: string, maxPages: number) => string[];
  parse: (stdout: string) => string;
}

const CONVERTER_COMMANDS: Record<Exclude<PdfConverter, "auto" | "unpdf">, ConverterCommand> = {
  pymupdf4llm: {
    command: "python3",
    args: (pdfPath, maxPages) => ["-c", PYMUPDF4LLM_SCRIPT, pdfPath, String(maxPages)],
    parse: (stdout) => stdout.trim(),
  },
  pdftotext: {
    command: "pdftotext",
    args: (pdfPath, maxPages) => ["-layout", "-enc", "UTF-8", "-eol", "unix", "-l", String(maxPages), pdfPath, "-"],
    parse: parsePdftotextOutput,
  },
};

/** Convert pdftotext's form-feed page separators into `<!-- Page N -->` markers. */
function parsePdftotextOutput(stdout: string): string {
  const pages = stdout.split("\f");
  const sections: string[] = [];
  for (const [index, page] of pages.entries()) {
    const text = page.trim();
    if (!text) continue;
    sections.push(`<!-- Page ${index + 1} -->\n\n${text}`);
  }
  return sections.join("\n\n");
}

async function runConverter(
  converter: Exclude<PdfConverter, "auto" | "unpdf">,
  pdfPath: string,
  maxPages: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const spec = CONVERTER_COMMANDS[converter];
  const result = await execCommand(spec.command, spec.args(pdfPath, maxPages), {
    timeoutMs: CONVERTER_TIMEOUT_MS,
    maxBuffer: CONVERTER_MAX_BUFFER,
    signal,
  });
  if (!result.ok) return null;
  const content = spec.parse(result.stdout);
  return content.length > 0 ? content : null;
}

async function convertWithExternalTools(
  converter: PdfConverter,
  pdfPath: string,
  maxPages: number,
  signal?: AbortSignal,
): Promise<{ engine: string; content: string } | null> {
  const order: Array<Exclude<PdfConverter, "auto" | "unpdf">> = converter === "auto"
    ? ["pymupdf4llm", "pdftotext"]
    : converter === "unpdf" ? [] : [converter];
  for (const engine of order) {
    signal?.throwIfAborted();
    const content = await runConverter(engine, pdfPath, maxPages, signal);
    if (content) return { engine, content };
  }
  return null;
}

export interface PdfExtraction {
  url: string;
  title: string;
  author: string;
  content: string;
  error: string | null;
  pageCount: number;
  extractedPages: number;
  engine: string;
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
  converter: PdfConverter = "unpdf",
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
    return await extractPdfFromFile(pdfPath, markdownPath, url, signal, converter);
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
  converter: PdfConverter = "unpdf",
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

    const external = await convertWithExternalTools(converter, pdfPath, extractedPages, signal);
    if (external) {
      const lines = [external.content];
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
        error: null,
        pageCount: pdf.numPages,
        extractedPages,
        engine: external.engine,
        pdfPath,
        markdownPath,
      };
    }

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
      engine: "unpdf",
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
    `- Extraction engine: ${extraction.engine}`,
  ];
  if (extraction.author) lines.push(`- Author: ${extraction.author}`);
  if (extraction.engine === "unpdf") {
    lines.push(
      "",
      "> Extraction reads the PDF text layer. Layout, tables, equations, figures, and scans may not be represented faithfully.",
      "> Install pymupdf4llm (pip) or pdftotext (poppler) for better structure preservation.",
    );
  }
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
