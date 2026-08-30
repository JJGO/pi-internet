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
    if (selector) {
      const selected = document.querySelector(selector);
      if (selected) {
        (document as any).body.innerHTML = selected.outerHTML;
      }
    }

    let processingError: unknown;
    const originalConsoleError = console.error;
    console.error = (...args) => {
      if (isDefuddleConsoleError(args)) {
        if (args[0] === "Defuddle" && args[1] === "Error processing document:") {
          processingError = args[2];
        }
        return;
      }
      originalConsoleError(...args);
    };

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
