/**
 * Brave Search provider.
 *
 * Provenance: pi-websearch/packages/core/src/providers/brave.ts
 * Borrowed: API call structure, extra_snippets concatenation for richer content.
 */

import type { SearchOptions, SearchProvider, SearchResult } from "../types.js";
import { SearchProviderError } from "../errors.js";
import { fetchWithProxy } from "../../util/proxy.js";
import { readResponseJson, readResponseText } from "../../util/download.js";

const MAX_PROVIDER_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

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

    const res = await fetchWithProxy(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        "X-Subscription-Token": apiKey,
        Accept: "application/json",
      },
      signal: options.signal,
      redirect: "error",
    }, { socksProxy: options.socksProxy });

    if (!res.ok) {
      const body = await readResponseText(res, MAX_ERROR_RESPONSE_BYTES, options.signal);
      const usageLimitExceeded = res.status === 402 && /USAGE_LIMIT_EXCEEDED|Usage limit exceeded/i.test(body);
      if (res.status === 429 || usageLimitExceeded) {
        throw new SearchProviderError({
          provider: "brave",
          message: usageLimitExceeded
            ? "Brave API usage limit reached (HTTP 402)"
            : "Brave API rate limit reached (HTTP 429)",
          statusCode: res.status,
          code: "rate_limited",
          disableForSession: true,
          disableReason: usageLimitExceeded ? "usage limit exceeded" : "rate limited",
          userMessage: usageLimitExceeded
            ? "Brave usage limit reached; disabled for this session."
            : "Brave rate-limited; disabled for this session.",
        });
      }
      throw new SearchProviderError({
        provider: "brave",
        message: `Brave API error (${res.status}): ${body}`,
        statusCode: res.status,
        code: "http",
      });
    }

    const data = await readResponseJson<any>(res, MAX_PROVIDER_RESPONSE_BYTES, options.signal);
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
