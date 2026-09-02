/**
 * Tavily Search provider.
 *
 * Provenance: pi-websearch/packages/core/src/providers/tavily.ts
 * Borrowed: API call structure, result normalization.
 */

import type { SearchOptions, SearchProvider, SearchResult } from "../types.js";
import { SearchProviderError } from "../errors.js";
import { fetchWithProxy } from "../../util/proxy.js";
import { readResponseJson, readResponseText } from "../../util/download.js";

const MAX_PROVIDER_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

export const tavily: SearchProvider = {
  name: "tavily",

  isAvailable() {
    return Boolean(process.env.TAVILY_API_KEY);
  },

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new SearchProviderError({
        provider: "tavily",
        message: "TAVILY_API_KEY not set",
        code: "auth",
      });
    }

    const body: Record<string, unknown> = {
      query: options.query,
      max_results: options.numResults ?? 5,
      search_depth: "basic",
      include_answer: false,
    };

    const res = await fetchWithProxy("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: options.signal,
      redirect: "error",
    }, { socksProxy: options.socksProxy });

    if (!res.ok) {
      throw new SearchProviderError({
        provider: "tavily",
        message: `Tavily API error (${res.status}): ${await readResponseText(res, MAX_ERROR_RESPONSE_BYTES, options.signal)}`,
        statusCode: res.status,
        code: "http",
      });
    }

    const data = await readResponseJson<any>(res, MAX_PROVIDER_RESPONSE_BYTES, options.signal);
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
