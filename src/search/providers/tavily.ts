/**
 * Tavily Search provider.
 *
 * Provenance: pi-websearch/packages/core/src/providers/tavily.ts
 * Borrowed: API call structure, result normalization.
 */

import type { SearchOptions, SearchProvider, SearchResult } from "../types.js";

export const tavily: SearchProvider = {
  name: "tavily",

  isAvailable() {
    return Boolean(process.env.TAVILY_API_KEY);
  },

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) throw new Error("TAVILY_API_KEY not set");

    const body: Record<string, unknown> = {
      query: options.query,
      max_results: options.numResults ?? 5,
      search_depth: "basic",
      include_answer: false,
    };

    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!res.ok) throw new Error(`Tavily API error (${res.status}): ${await res.text()}`);

    const data = await res.json();
    return (data.results ?? []).map(
      (r: { title: string; url: string; content: string; published_date?: string }) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        publishedDate: r.published_date,
        provider: "tavily",
      }),
    );
  },
};
