/**
 * Search router — parallel primary providers + sequential fallback.
 *
 * Provenance: pi-web-access/gemini-search.ts (fallback chain pattern),
 * pi-websearch/packages/core/src/index.ts (resolveProvider env-key detection).
 *
 * Behavior:
 * 1. If `provider` override specified → use that one only
 * 2. Else → run all configured primary providers in parallel, merge/dedupe results
 * 3. If all primaries fail → try fallback providers sequentially
 */

import type { SearchOptions, SearchProvider, SearchResult } from "./types.js";
import { DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS } from "./types.js";
import { mergeResults } from "./merge.js";
import { brave } from "./providers/brave.js";
import { kagi } from "./providers/kagi.js";
import { tavily } from "./providers/tavily.js";

const ALL_PROVIDERS: Record<string, SearchProvider> = {
  brave,
  kagi,
  tavily,
};

export interface SearchRouterConfig {
  searchProviders: string[];
  fallbackProviders: string[];
}

const DEFAULT_CONFIG: SearchRouterConfig = {
  searchProviders: ["brave", "kagi"],
  fallbackProviders: ["tavily"],
};

export function createSearchRouter(
  config: Partial<SearchRouterConfig> = {},
  providers: Record<string, SearchProvider> = ALL_PROVIDERS,
) {
  const resolved: SearchRouterConfig = {
    searchProviders: config.searchProviders ?? DEFAULT_CONFIG.searchProviders,
    fallbackProviders: config.fallbackProviders ?? DEFAULT_CONFIG.fallbackProviders,
  };

  return {
    async search(options: SearchOptions & { provider?: string }): Promise<{
      results: SearchResult[];
      provider: string;
      errors: string[];
    }> {
      const numResults = Math.min(Math.max(options.numResults ?? DEFAULT_NUM_RESULTS, 1), MAX_NUM_RESULTS);
      const errors: string[] = [];

      // Override: use a specific provider
      if (options.provider) {
        const provider = providers[options.provider];
        if (!provider) throw new Error(`Unknown provider: ${options.provider}`);
        if (!provider.isAvailable()) throw new Error(`Provider "${options.provider}" is not configured`);
        const results = await provider.search({ ...options, signal: options.signal });
        return { results: results.slice(0, numResults), provider: provider.name, errors };
      }

      // Primary: run available primaries in parallel
      const primaries = resolved.searchProviders
        .map((name) => providers[name])
        .filter((p): p is SearchProvider => !!p && p.isAvailable());

      if (primaries.length > 0) {
        const settled = await Promise.allSettled(
          // Ask each provider for the full count — merge + dedup handles the cap.
          // This avoids throwing away results we already paid API cost for.
          primaries.map((p) => p.search({ ...options, numResults, signal: options.signal })),
        );

        const successResults: SearchResult[][] = [];
        for (let i = 0; i < settled.length; i++) {
          const result = settled[i];
          if (result.status === "fulfilled") {
            successResults.push(result.value);
          } else {
            errors.push(`${primaries[i].name}: ${result.reason?.message ?? result.reason}`);
          }
        }

        if (successResults.length > 0) {
          const merged = mergeResults(successResults, numResults);
          const providerNames = primaries
            .filter((_, i) => settled[i].status === "fulfilled")
            .map((p) => p.name)
            .join("+");
          return { results: merged, provider: providerNames, errors };
        }
      }

      // Fallback: try each fallback sequentially
      const fallbacks = resolved.fallbackProviders
        .map((name) => providers[name])
        .filter((p): p is SearchProvider => !!p && p.isAvailable());

      for (const provider of fallbacks) {
        try {
          const results = await provider.search({ ...options, signal: options.signal });
          return {
            results: results.slice(0, numResults),
            provider: `${provider.name} (fallback)`,
            errors,
          };
        } catch (err) {
          errors.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Nothing worked
      const allNames = [
        ...resolved.searchProviders,
        ...resolved.fallbackProviders,
      ];
      throw new Error(
        `All search providers failed. Tried: ${allNames.join(", ")}.\n${errors.join("\n")}`,
      );
    },

    /** List all providers with their availability status */
    listProviders(): { name: string; available: boolean; role: "primary" | "fallback" | "unused" }[] {
      return Object.entries(providers).map(([name, provider]) => ({
        name,
        available: provider.isAvailable(),
        role: resolved.searchProviders.includes(name)
          ? "primary" as const
          : resolved.fallbackProviders.includes(name)
            ? "fallback" as const
            : "unused" as const,
      }));
    },
  };
}
