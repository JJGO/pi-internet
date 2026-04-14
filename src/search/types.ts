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

/** Format search results as markdown for the agent */
export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";

  return results
    .map((r, i) => {
      const meta: string[] = [];
      if (r.publishedDate) meta.push(r.publishedDate);
      if (r.provider) meta.push(`via ${r.provider}`);
      const suffix = meta.length > 0 ? ` (${meta.join(", ")})` : "";
      return `## ${i + 1}. ${r.title}${suffix}\n${r.url}\n\n${r.snippet}`;
    })
    .join("\n\n---\n\n");
}
