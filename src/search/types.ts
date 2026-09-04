/**
 * Search provider interface and result types.
 *
 * Provenance: pi-websearch/packages/core/src/types.ts
 * Borrowed: SearchProvider interface shape, SearchResult type, formatResults() pattern.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  /** Which provider produced this result */
  provider?: string;
}

export interface SearchOptions {
  query: string;
  numResults?: number;
  freshness?: "day" | "week" | "month" | "year";
  signal?: AbortSignal;
  socksProxy?: string | null;
}

export interface SearchProvider {
  /** Provider identifier (e.g. "brave", "kagi") */
  name: string;
  /** Check if this provider is configured and available */
  isAvailable(): boolean;
  /** Execute a search */
  search(options: SearchOptions): Promise<SearchResult[]>;
}

/** Default number of results to return. 10 matches Kagi's default and gives
 * a rich enough pool after cross-provider deduplication. Claude/Codex
 * typically surface 8-15 results per search. */
export const DEFAULT_NUM_RESULTS = 10;
export const MAX_NUM_RESULTS = 20;

/** Maximum characters of a snippet shown to the model. Providers return
 * 200-3,000 chars per result (Brave/Tavily average ~1.2-1.3K, Kagi ~200);
 * beyond ~500 chars the text is secondary prose that inflates context
 * without improving source selection. */
export const MAX_SNIPPET_CHARS = 500;

/** Collapse whitespace runs and cap length so every provider contributes
 * comparably sized, single-paragraph snippets. */
export function compactSnippet(snippet: string): string {
  const compact = snippet.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_SNIPPET_CHARS) return compact;
  let sliced = compact.slice(0, MAX_SNIPPET_CHARS - 1);
  // Do not split a surrogate pair at the cap boundary; a lone high
  // surrogate makes the tool result malformed UTF-8 for provider APIs.
  const last = sliced.charCodeAt(sliced.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) sliced = sliced.slice(0, -1);
  return `${sliced.trimEnd()}\u2026`;
}

/** Format search results as markdown for the agent */
export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";

  return results
    .map((r, i) => {
      const meta: string[] = [];
      if (r.publishedDate) meta.push(r.publishedDate);
      if (r.provider) meta.push(`via ${r.provider}`);
      const suffix = meta.length > 0 ? ` (${meta.join(", ")})` : "";
      return `## ${i + 1}. ${r.title}${suffix}\n${r.url}\n\n${compactSnippet(r.snippet)}`;
    })
    .join("\n\n---\n\n");
}
