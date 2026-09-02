import type { PiInternetConfig } from "../config.js";
import { getAttr, getText, normalizeText, parse } from "../util/dom.js";
import { readResponseText } from "../util/download.js";
import { fetchWithTransientRetry } from "../util/retry-fetch.js";
import { combinedSignal } from "../util/signal.js";
import type { FetchUrlOptions } from "./router.js";
import type { FetchArtifacts, FetchResult } from "./http.js";
import { arxivHtmlToMarkdown } from "./arxiv-html.js";
import { downloadAndExtractPdf, finalizePdfResult, type PdfExtraction } from "./pdf.js";
import { fetchAndExtractArxivSource } from "./arxiv-source.js";

const ARXIV_HOSTS = new Set(["arxiv.org", "www.arxiv.org", "export.arxiv.org"]);
const MAX_ARXIV_HTML_BYTES = 5 * 1024 * 1024;
const USER_AGENT = "pi-internet/0.1 (arXiv representation fetcher)";

export type ArxivRepresentation = "abs" | "html" | "pdf" | "src";

export interface ParsedArxivUrl {
  representation: ArxivRepresentation;
  id: string;
  baseId: string;
  requestedVersion: number | null;
}

export interface ArxivVersion {
  version: number;
  detail: string;
  url: string;
}

export interface ArxivManifest {
  id: string;
  baseId: string;
  currentVersion: number;
  latestVersion: number;
  title: string;
  authors: string[];
  abstract: string;
  dateline: string;
  comments: string;
  subjects: string;
  journalReference: string;
  doi: string;
  arxivDoi: string;
  license: { label: string; url: string } | null;
  versions: ArxivVersion[];
  urls: {
    abs: string;
    html: string | null;
    pdf: string | null;
    src: string | null;
  };
  ancillary: Array<{ label: string; url: string }>;
}

const manifestCache = new Map<string, ArxivManifest>();

export function resetArxivCache(): void {
  manifestCache.clear();
}

export function parseArxivUrl(value: string): ParsedArxivUrl | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!ARXIV_HOSTS.has(url.hostname.toLowerCase())) return null;

  const match = url.pathname.match(/^\/(abs|html|pdf|src)\/(.+?)\/?$/i);
  if (!match) return null;
  const representation = match[1].toLowerCase() as ArxivRepresentation;
  let id = decodeURIComponent(match[2]);
  if (representation === "pdf") id = id.replace(/\.pdf$/i, "");
  const idMatch = id.match(/^(\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v(\d+))?$/i);
  if (!idMatch) return null;

  const baseId = idMatch[1];
  const requestedVersion = idMatch[2] ? Number(idMatch[2]) : null;
  return {
    representation,
    id: requestedVersion ? `${baseId}v${requestedVersion}` : baseId,
    baseId,
    requestedVersion,
  };
}

export function parseArxivManifest(html: string, absUrl: string): ArxivManifest {
  const document = parse(html);
  const breadcrumb = getText(document.querySelector(".header-breadcrumbs-mobile strong"));
  const identity = breadcrumb.match(/arXiv:(\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v(\d+))?/i);
  const citationId = getAttr(document.querySelector('meta[name="citation_arxiv_id"]'), "content") ?? "";
  const fallbackIdentity = citationId.match(/^(\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v(\d+))?$/i);
  const parsedIdentity = identity ?? fallbackIdentity;
  if (!parsedIdentity) throw new Error("Could not parse arXiv identifier from abstract page");

  const baseId = parsedIdentity[1];
  const currentFromPage = parsedIdentity[2] ? Number(parsedIdentity[2]) : null;
  const versions = parseVersions(document.querySelector(".submission-history"), baseId);
  const currentVersion = currentFromPage ?? versions.at(-1)?.version ?? 1;
  if (!versions.some((version) => version.version === currentVersion)) {
    versions.push({ version: currentVersion, detail: "", url: arxivUrl("abs", `${baseId}v${currentVersion}`) });
    versions.sort((a, b) => a.version - b.version);
  }
  const latestVersion = Math.max(currentVersion, ...versions.map((version) => version.version));
  const id = `${baseId}v${currentVersion}`;
  const title = stripDescriptor(getText(document.querySelector("h1.title")), "Title:");
  if (!title) throw new Error("Could not parse title from arXiv abstract page");

  const metadata = new Map<string, string>();
  for (const row of document.querySelectorAll(".metatable tr")) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 2) continue;
    const label = getText(cells[0]).replace(/:$/, "").toLowerCase();
    if (label) metadata.set(label, getText(cells[1]));
  }

  const links = Array.from(document.querySelectorAll(".full-text a[href]"));
  const findLink = (kind: ArxivRepresentation): string | null => {
    const anchor = links.find((link) => {
      const href = getAttr(link, "href") ?? "";
      if (kind === "pdf") return link.classList.contains("download-pdf") || /\/pdf\//.test(href);
      if (kind === "html") return link.id === "latexml-download-link" || /\/html\//.test(href);
      if (kind === "src") return link.classList.contains("download-eprint") || /\/src\//.test(href);
      return false;
    });
    return anchor ? absoluteArxivUrl(getAttr(anchor, "href")!, absUrl) : null;
  };

  const licenseAnchor = document.querySelector(".abs-license a[href]");
  const arxivDoi = getAttr(document.querySelector("#arxiv-doi-link"), "href") ?? "";
  const authors = Array.from(document.querySelectorAll(".authors a")).map((author) => getText(author)).filter(Boolean);
  const ancillary = Array.from(document.querySelectorAll(".ancillary .anc-file-name[href]"))
    .map((anchor) => ({
      label: getText(anchor),
      url: absoluteArxivUrl(getAttr(anchor, "href")!, absUrl),
    }));

  return {
    id,
    baseId,
    currentVersion,
    latestVersion,
    title,
    authors,
    abstract: stripDescriptor(getText(document.querySelector("blockquote.abstract")), "Abstract:"),
    dateline: getText(document.querySelector(".dateline")).replace(/^\[|\]$/g, ""),
    comments: metadata.get("comments") ?? "",
    subjects: metadata.get("subjects") ?? "",
    journalReference: metadata.get("journal reference") ?? "",
    doi: metadata.get("doi") ?? "",
    arxivDoi,
    license: licenseAnchor ? {
      label: getAttr(licenseAnchor, "title") || getText(licenseAnchor) || "License",
      url: absoluteArxivUrl(getAttr(licenseAnchor, "href")!, absUrl),
    } : null,
    versions,
    urls: {
      abs: arxivUrl("abs", id),
      html: findLink("html"),
      pdf: findLink("pdf"),
      src: findLink("src"),
    },
    ancillary,
  };
}

export async function fetchArxiv(
  url: string,
  config: PiInternetConfig,
  options: FetchUrlOptions = {},
): Promise<FetchResult | null> {
  const parsedUrl = parseArxivUrl(url);
  if (!parsedUrl) return null;

  const signal = combinedSignal(options.signal, config.fetch.timeoutMs);
  const includeLinks = options.includeLinks ?? config.fetch.includeLinks;
  const requestedManifest = await getManifest(parsedUrl.id, config, signal);
  const latestManifest = requestedManifest.currentVersion < requestedManifest.latestVersion
    ? await getManifest(parsedUrl.baseId, config, signal)
    : requestedManifest;
  const selectedUrl = requestedManifest.urls[parsedUrl.representation];

  if (parsedUrl.representation === "abs") {
    const disclosure = renderDisclosure(parsedUrl.representation, requestedManifest, latestManifest);
    return {
      url,
      title: requestedManifest.title,
      content: `${disclosure}\n\n${renderMetadata(requestedManifest, includeLinks)}`,
      error: null,
    };
  }

  if (!selectedUrl) {
    const disclosure = renderDisclosure(parsedUrl.representation, requestedManifest, latestManifest);
    return {
      url,
      title: requestedManifest.title,
      content: `${disclosure}\n\n${renderMetadata(requestedManifest, includeLinks)}`,
      error: `${representationName(parsedUrl.representation)} is unavailable for arXiv:${requestedManifest.id}`,
    };
  }

  try {
    if (parsedUrl.representation === "html") {
      const response = await requestArxiv(selectedUrl, config, signal);
      if (!response.ok) return representationHttpError(url, parsedUrl.representation, response, requestedManifest, latestManifest, includeLinks);
      const html = await readResponseText(response, MAX_ARXIV_HTML_BYTES, signal);
      const converted = arxivHtmlToMarkdown(html, response.url || selectedUrl, options.selector, includeLinks);
      const disclosure = renderDisclosure("html", requestedManifest, latestManifest);
      const warnings = converted.warnings.length > 0
        ? `\n\n> ⚠️ arXiv reported HTML conversion warnings: ${converted.warnings.join("; ")}`
        : "";
      return {
        url,
        title: requestedManifest.title,
        content: `${disclosure}${warnings}\n\n---\n\n${converted.markdown}`,
        error: null,
      };
    }

    if (parsedUrl.representation === "pdf") {
      const response = await requestArxiv(selectedUrl, config, signal);
      if (!response.ok) return representationHttpError(url, parsedUrl.representation, response, requestedManifest, latestManifest, includeLinks);
      const extraction = await downloadAndExtractPdf(response, selectedUrl, signal, config.pdf.converter);
      const disclosure = renderDisclosure("pdf", requestedManifest, latestManifest, {
        pdf: extraction.pdfPath,
        markdown: extraction.markdownPath,
      }, extraction);
      return finalizePdfResult(extraction, disclosure, requestedManifest.title);
    }

    const response = await requestArxiv(selectedUrl, config, signal);
    if (!response.ok) return representationHttpError(url, parsedUrl.representation, response, requestedManifest, latestManifest, includeLinks);
    const sourceResult = await fetchAndExtractArxivSource(response, selectedUrl, requestedManifest.title, signal);
    const disclosure = renderDisclosure("src", requestedManifest, latestManifest, sourceResult.artifacts);
    return {
      ...sourceResult,
      url,
      content: `${disclosure}\n\n---\n\n${sourceResult.content}`,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      url,
      title: requestedManifest.title,
      content: `${renderDisclosure(parsedUrl.representation, requestedManifest, latestManifest)}\n\n${renderMetadata(requestedManifest, includeLinks)}`,
      error: `${representationName(parsedUrl.representation)} processing failed: ${message}`,
    };
  }
}

async function getManifest(id: string, config: PiInternetConfig, signal: AbortSignal): Promise<ArxivManifest> {
  const url = arxivUrl("abs", id);
  const cached = manifestCache.get(url);
  if (cached) return cached;

  const response = await requestArxiv(url, config, signal);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`arXiv abstract request failed: HTTP ${response.status} ${response.statusText}`);
  }
  const html = await readResponseText(response, MAX_ARXIV_HTML_BYTES, signal);
  const manifest = parseArxivManifest(html, response.url || url);
  manifestCache.set(url, manifest);
  return manifest;
}

async function requestArxiv(url: string, config: PiInternetConfig, signal: AbortSignal): Promise<Response> {
  return fetchWithTransientRetry(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/pdf,application/gzip,*/*;q=0.8",
    },
  }, {
    timeoutMs: config.fetch.timeoutMs,
    signal,
    socksProxy: config.fetch.socksProxy,
    retries: 1,
    allowPrivateNetworks: config.fetch.allowPrivateNetworks,
  });
}

function renderDisclosure(
  fetched: ArxivRepresentation,
  requested: ArxivManifest,
  latest: ArxivManifest,
  artifacts?: FetchArtifacts,
  pdf?: PdfExtraction,
): string {
  const stale = requested.currentVersion < latest.currentVersion;
  const lines = [
    "## arXiv representations",
    "",
    `- Fetched: ${representationName(fetched)} for [arXiv:${requested.id}](${requested.urls.abs})`,
    `- Revision: v${requested.currentVersion}${stale ? ` (older; latest is v${latest.currentVersion})` : " (latest)"}`,
    `- Abstract and history: [metadata, abstract, and revisions](${requested.urls.abs})`,
    representationLine("HTML", requested.urls.html, "structured full text; best for reading when available"),
    representationLine("PDF", requested.urls.pdf, "rendered paper and visual ground truth"),
    representationLine("Source", requested.urls.src, "original submission source and assets"),
  ];
  if (stale) {
    lines.push(
      "",
      `> ⚠️ You requested v${requested.currentVersion}. For current conclusions, prefer latest v${latest.currentVersion}.`,
      representationLine("Latest HTML", latest.urls.html, "structured latest full text"),
      representationLine("Latest PDF", latest.urls.pdf, "rendered latest revision"),
      representationLine("Latest source", latest.urls.src, "latest submission source"),
    );
  }
  if (requested.ancillary.length > 0) {
    lines.push("", "- Ancillary files:");
    for (const file of requested.ancillary) lines.push(`  - [${file.label}](${file.url})`);
  }
  if (artifacts?.pdf) lines.push(`- Local PDF: ${artifacts.pdf}`);
  if (artifacts?.markdown) lines.push(`- Extracted Markdown: ${artifacts.markdown}`);
  if (pdf) {
    const pageSummary = pdf.pageCount > pdf.extractedPages ? `${pdf.extractedPages} of ${pdf.pageCount}` : String(pdf.pageCount);
    lines.push(`- PDF pages extracted: ${pageSummary}`);
  }
  if (artifacts?.sourceDownload) lines.push(`- Original source payload: ${artifacts.sourceDownload}`);
  if (artifacts?.sourceDirectory) lines.push(`- Unpacked source: ${artifacts.sourceDirectory}`);
  if (artifacts?.sourceManifest) lines.push(`- Source manifest: ${artifacts.sourceManifest}`);
  return lines.join("\n");
}

function renderMetadata(manifest: ArxivManifest, includeLinks: boolean): string {
  const lines = ["## Metadata", "", `- Authors: ${manifest.authors.join(", ") || "Unknown"}`];
  if (manifest.dateline) lines.push(`- Revision dates: ${manifest.dateline}`);
  if (manifest.subjects) lines.push(`- Subjects: ${manifest.subjects}`);
  if (manifest.comments) lines.push(`- Comments: ${manifest.comments}`);
  if (manifest.journalReference) lines.push(`- Journal reference: ${manifest.journalReference}`);
  if (manifest.doi) lines.push(`- DOI: ${linkify(manifest.doi, includeLinks)}`);
  if (manifest.arxivDoi) lines.push(`- arXiv DOI: ${includeLinks ? `[${manifest.arxivDoi}](${manifest.arxivDoi})` : manifest.arxivDoi}`);
  if (manifest.license) lines.push(`- License: ${includeLinks ? `[${manifest.license.label}](${manifest.license.url})` : manifest.license.label}`);
  if (manifest.versions.length > 0) {
    lines.push("- Version history:");
    for (const version of manifest.versions) {
      const label = includeLinks ? `[v${version.version}](${version.url})` : `v${version.version}`;
      lines.push(`  - ${label}${version.detail ? ` — ${version.detail}` : ""}`);
    }
  }
  lines.push("", "## Abstract", "", manifest.abstract || "No abstract was provided.");
  return lines.join("\n");
}

function representationLine(label: string, url: string | null, description: string): string {
  return url ? `- ${label}: [${description}](${url})` : `- ${label}: unavailable`;
}

function representationHttpError(
  originalUrl: string,
  representation: ArxivRepresentation,
  response: Response,
  requested: ArxivManifest,
  latest: ArxivManifest,
  includeLinks: boolean,
): FetchResult {
  void response.body?.cancel();
  return {
    url: originalUrl,
    title: requested.title,
    content: `${renderDisclosure(representation, requested, latest)}\n\n${renderMetadata(requested, includeLinks)}`,
    error: `${representationName(representation)} request failed: HTTP ${response.status} ${response.statusText}`,
  };
}

function parseVersions(history: Element | null, baseId: string): ArxivVersion[] {
  if (!history) return [];
  const versions: ArxivVersion[] = [];
  for (const strong of history.querySelectorAll("strong")) {
    const match = getText(strong).match(/\[v(\d+)\]/i);
    if (!match) continue;
    let detail = "";
    let sibling = strong.nextSibling;
    while (sibling && !(sibling.nodeType === 1 && (sibling as Element).tagName.toLowerCase() === "br")) {
      detail += sibling.textContent ?? "";
      sibling = sibling.nextSibling;
    }
    const version = Number(match[1]);
    versions.push({
      version,
      detail: normalizeText(detail),
      url: arxivUrl("abs", `${baseId}v${version}`),
    });
  }
  return versions.sort((a, b) => a.version - b.version);
}

function arxivUrl(representation: ArxivRepresentation, id: string): string {
  return `https://arxiv.org/${representation}/${id}`;
}

function absoluteArxivUrl(value: string, base: string): string {
  const url = new URL(value, base);
  if (ARXIV_HOSTS.has(url.hostname.toLowerCase())) {
    url.protocol = "https:";
    url.hostname = "arxiv.org";
  }
  return url.href;
}

function stripDescriptor(value: string, descriptor: string): string {
  return value.startsWith(descriptor) ? value.slice(descriptor.length).trim() : value;
}

function representationName(value: ArxivRepresentation): string {
  return ({ abs: "Abstract", html: "HTML", pdf: "PDF", src: "source" } as const)[value];
}

function linkify(value: string, includeLinks: boolean): string {
  const url = value.match(/https?:\/\/\S+/)?.[0];
  return includeLinks && url ? `[${url}](${url})` : value;
}
