import type { DefuddleResponse } from "defuddle/node";
import { parse as parseDom } from "../util/dom.js";
import { htmlToMarkdown, type MarkdownOptions } from "../util/markdown.js";

function isDefuddleConsoleError(args: Parameters<typeof console.error>): boolean {
  const prefix = args[0];
  return prefix === "Defuddle" || (typeof prefix === "string" && /^Defuddle(?:\s|:)/.test(prefix));
}

const disabledFetch: typeof globalThis.fetch = async () => {
  throw new Error("Defuddle network access is disabled");
};

export async function extractWithDefuddle(
  html: string,
  url: string,
  selector: string | undefined,
  mdOptions: MarkdownOptions,
  signal?: AbortSignal,
): Promise<{ title: string; content: string } | null> {
  try {
    const { Defuddle } = await import("defuddle/node");
    if (signal?.aborted) return null;

    const document = parseDom(html);
    // linkedom documents have no location; Defuddle's MetadataExtractor ignores the
    // url argument and reads doc.location.href, falling back to <link rel="canonical">
    // which may be relative and make `new URL()` throw (leaking a console.warn).
    (document as any).location = { href: url };
    if (selector) {
      const selected = document.querySelector(selector);
      if (selected) {
        (document as any).body.innerHTML = selected.outerHTML;
      }
    }

    let processingError: unknown;
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    console.error = (...args) => {
      if (isDefuddleConsoleError(args)) {
        if (args[0] === "Defuddle" && args[1] === "Error processing document:") {
          processingError = args[2];
        }
        return;
      }
      originalConsoleError(...args);
    };
    // Defuddle's warns are unprefixed (e.g. "Failed to parse URL:"), so suppress all
    // warns for the duration of the synchronous parse.
    console.warn = () => {};

    let resultPromise: Promise<DefuddleResponse>;
    try {
      // Defuddle parses synchronously before returning when async extractors are disabled.
      resultPromise = Defuddle(document as unknown as Document, url, {
        useAsync: false,
        fetch: disabledFetch,
        ...(selector ? { contentSelector: selector } : {}),
      });
    } finally {
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
    }

    const result = await resultPromise;
    if (signal?.aborted || processingError !== undefined || typeof result.content !== "string") {
      return null;
    }

    const content = htmlToMarkdown(result.content, mdOptions);
    return content ? { title: result.title || "", content } : null;
  } catch {
    return null;
  }
}
