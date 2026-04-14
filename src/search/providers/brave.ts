/**
 * Brave Search provider.
 *
 * Provenance: pi-websearch/packages/core/src/providers/brave.ts
 * Borrowed: API call structure, extra_snippets concatenation for richer content.
 */

import type { SearchOptions, SearchProvider, SearchResult } from "../types.js";

export const brave: SearchProvider = {
  name: "brave",

  isAvailable() {
    return Boolean(process.env.BRAVE_API_KEY);
  },

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const apiKey = process.env.BRAVE_API_KEY;
    if (!apiKey) throw new Error("BRAVE_API_KEY not set");

    const params = new URLSearchParams({
      q: options.query,
      count: String(options.numResults ?? 5),
    });
    if (options.freshness) params.set("freshness", freshnessMap[options.freshness] ?? options.freshness);

    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        "X-Subscription-Token": apiKey,
        Accept: "application/json",
      },
      signal: options.signal,
    });

    if (!res.ok) throw new Error(`Brave API error (${res.status}): ${await res.text()}`);

    const data = await res.json();
    return (data.web?.results ?? []).map(
      (r: { title: string; url: string; description: string; extra_snippets?: string[] }) => ({
        title: r.title,
        url: r.url,
        snippet: [r.description, ...(r.extra_snippets ?? [])].filter(Boolean).join("\n\n"),
        provider: "brave",
      }),
    );
  },
};

/** Map our freshness values to Brave's format */
const freshnessMap: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};
