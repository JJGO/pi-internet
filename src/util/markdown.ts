/**
 * HTML → Markdown conversion with token-efficient defaults.
 *
 * Provenance:
 * - pi-surf/extensions/index.ts: link stripping by default (~50 tokens/link saved)
 * - pi-fetch/extensions/fetch.ts: aggressive tag skipping for noise removal
 * - pi-web-access/extract.ts: Readability + Turndown pipeline
 */

import TurndownService from "turndown";

/** Singleton Turndown with our defaults. Call configure() to adjust per-request. */
let td: TurndownService | null = null;

export interface MarkdownOptions {
  /** Keep hyperlinks in output (default: false — saves tokens) */
  includeLinks?: boolean;
}

function createTurndown(options: MarkdownOptions = {}): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  // Always strip images — not useful in LLM context
  service.addRule("removeImages", {
    filter: "img",
    replacement: () => "",
  });

  // Strip links by default to save tokens (~50 tokens per link)
  if (!options.includeLinks) {
    service.addRule("stripLinks", {
      filter: "a",
      replacement: (_content: string, node: any) => node.textContent || "",
    });
  }

  // Remove non-content elements
  service.addRule("removeNoise", {
    filter: ["nav", "footer", "aside", "button", "form", "input", "select",
      "textarea", "iframe", "svg", "canvas", "video", "audio", "picture",
      "figure", "figcaption", "noscript", "script", "style"],
    replacement: () => "",
  });

  return service;
}

/** Extract a title from the first H1/H2 heading in markdown text. */
export function extractHeadingTitle(text: string): string | null {
  const match = text.match(/^#{1,2}\s+(.+)/m);
  if (!match) return null;
  return match[1].replace(/\*+/g, "").trim() || null;
}

/** Cache Turndown instances by config shape (at most 2: links on/off). */
const turndownCache = new Map<boolean, TurndownService>();

function getTurndown(options: MarkdownOptions): TurndownService {
  const key = options.includeLinks ?? false;
  const cached = turndownCache.get(key);
  if (cached) return cached;
  const td = createTurndown(options);
  turndownCache.set(key, td);
  return td;
}

export function htmlToMarkdown(html: string, options: MarkdownOptions = {}): string {
  const service = getTurndown(options);
  let md = service.turndown(html);

  // Clean up excessive whitespace
  md = md
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^#+\s*$/gm, "")
    // Remove common boilerplate lines
    .replace(/^(Share|Tweet|Pin|Email|Print)(\s+(this|on|via))?.{0,20}$/gim, "")
    .replace(/^.*(cookie|consent|privacy policy|accept all).*$/gim, "")
    .trim();

  return md;
}
