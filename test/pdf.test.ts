import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { httpFetch } from "../src/fetch/http.ts";
import {
  downloadAndExtractPdf,
  finalizePdfResult,
  hasPdfSignature,
  renderGenericPdfPreamble,
} from "../src/fetch/pdf.ts";

function makePdf(text = "Hello from PDF"): Buffer {
  return makeMultiPagePdf([text]);
}

function makeMultiPagePdf(pageTexts: string[]): Buffer {
  const fontObject = 3 + pageTexts.length * 2;
  const pageObjects = pageTexts.map((_, index) => 3 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjects.map((object) => `${object} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`,
  ];
  for (let index = 0; index < pageTexts.length; index++) {
    const stream = pageTexts[index] ? `BT /F1 18 Tf 72 720 Td (${pageTexts[index]}) Tj ET` : "";
    const contentObject = pageObjects[index] + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

function makePdfBody(text = "Hello from PDF"): ArrayBuffer {
  const pdf = makePdf(text);
  return pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
}

test("hasPdfSignature accepts a PDF header within the initial bytes", () => {
  assert.equal(hasPdfSignature(Buffer.from("junk\n%PDF-1.7\n")), true);
  assert.equal(hasPdfSignature(Buffer.from("not a pdf")), false);
});

test("PDF extraction retains PDF and Markdown artifacts", async () => {
  const extraction = await downloadAndExtractPdf(
    new Response(makePdfBody(), { headers: { "content-type": "application/pdf" } }),
    "https://example.com/report.pdf",
  );
  try {
    const result = await finalizePdfResult(extraction, renderGenericPdfPreamble(extraction));
    assert.match(result.content, /Hello from PDF/);
    assert.match(result.content, /Local|Original PDF/);
    assert.equal(result.artifacts?.pdf, extraction.pdfPath);
    assert.equal(result.fullOutputPath, extraction.markdownPath);
    assert.ok((await readFile(extraction.pdfPath)).equals(makePdf()));
    assert.equal(await readFile(extraction.markdownPath, "utf8"), `# report\n\n${result.content}`);
  } finally {
    await rm(dirname(extraction.pdfPath), { recursive: true, force: true });
  }
});

test("PDF extraction reports an image-only page instead of empty success", async () => {
  const extraction = await downloadAndExtractPdf(
    new Response(makePdfBody(""), { headers: { "content-type": "application/pdf" } }),
    "https://example.com/scan.pdf",
  );
  try {
    assert.match(extraction.error ?? "", /no extractable text layer/i);
    assert.match(extraction.content, /may require OCR/i);
  } finally {
    await rm(dirname(extraction.pdfPath), { recursive: true, force: true });
  }
});

test("PDF extraction preserves source page numbers across empty pages", async () => {
  const pdf = makeMultiPagePdf(["first", "", "third"]);
  const body = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
  const extraction = await downloadAndExtractPdf(
    new Response(body, { headers: { "content-type": "application/pdf" } }),
    "https://example.com/pages.pdf",
  );
  try {
    assert.match(extraction.content, /<!-- Page 1 -->[\s\S]*first/);
    assert.doesNotMatch(extraction.content, /<!-- Page 2 -->/);
    assert.match(extraction.content, /<!-- Page 3 -->[\s\S]*third/);
  } finally {
    await rm(dirname(extraction.pdfPath), { recursive: true, force: true });
  }
});

test("PDF extraction caps work at 100 pages and discloses the complete page count", async () => {
  const pdf = makeMultiPagePdf(Array.from({ length: 101 }, (_, index) => `page ${index + 1}`));
  const body = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
  const extraction = await downloadAndExtractPdf(
    new Response(body, { headers: { "content-type": "application/pdf" } }),
    "https://example.com/long.pdf",
  );
  try {
    assert.equal(extraction.pageCount, 101);
    assert.equal(extraction.extractedPages, 100);
    assert.match(extraction.content, /Extracted pages 1–100 of 101/);
    assert.doesNotMatch(extraction.content, /page 101/);
  } finally {
    await rm(dirname(extraction.pdfPath), { recursive: true, force: true });
  }
});

test("httpFetch handles extensionless and generically labeled PDFs through one path", async () => {
  const originalFetch = globalThis.fetch;
  const created: string[] = [];
  try {
    globalThis.fetch = async () => new Response(makePdfBody(), {
      headers: { "content-type": "application/octet-stream" },
    });
    for (const url of ["https://example.com/download", "https://example.com/report.pdf"]) {
      const result = await httpFetch(url, { socksProxy: null });
      assert.equal(result.error, null);
      assert.match(result.content, /Hello from PDF/);
      assert.ok(result.artifacts?.pdf);
      created.push(dirname(result.artifacts!.pdf!));
    }
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
  }
});

test("httpFetch rejects mislabeled non-PDF bytes before parsing", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("not a pdf", {
      headers: { "content-type": "application/pdf" },
    });
    const result = await httpFetch("https://example.com/download", { socksProxy: null });
    assert.match(result.error ?? "", /valid PDF signature/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
