/**
 * Search router — parallel primary providers + sequential fallback.
 *
 * Provenance: pi-web-access/gemini-search.ts (fallback chain pattern),
 * pi-websearch/packages/core/src/index.ts (resolveProvider env-key detection).
 */

import type { SearchOptions, SearchProvider, SearchResult } from "./types.js";
import { DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS } from "./types.js";
import { mergeResults } from "./merge.js";
import { normalizeSearchProviderError } from "./errors.js";
import {
  disableSearchProvider,
  getSearchProviderDisableReason,
  isSearchProviderDisabled,
} from "./state.js";
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

export interface SearchRouterResult {
  results: SearchResult[];
  provider: string;
  errors: string[];
  warnings: string[];
}

export interface SearchProviderStatus {
  name: string;
  available: boolean;
  role: "primary" | "fallback" | "unused";
  disabledForSession: boolean;
  disabledReason?: string;
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
    async search(options: SearchOptions & { provider?: string }): Promise<SearchRouterResult> {
      const numResults = Math.min(Math.max(options.numResults ?? DEFAULT_NUM_RESULTS, 1), MAX_NUM_RESULTS);
      const errors: string[] = [];
      const warnings: string[] = [];

      if (options.provider) {
        const provider = providers[options.provider];
        if (!provider) throw new Error(`Unknown provider: ${options.provider}`);
        if (!provider.isAvailable()) throw new Error(`Provider "${options.provider}" is not configured`);
        const disabledReason = getSearchProviderDisableReason(options.provider);
        if (disabledReason) {
          throw new Error(`Provider "${options.provider}" is disabled for this session (${disabledReason})`);
        }

        try {
          const results = await provider.search({ ...options, numResults, signal: options.signal });
          return { results: results.slice(0, numResults), provider: provider.name, errors, warnings };
        } catch (error) {
          const providerError = recordProviderFailure(provider.name, error, errors, warnings);
          throw new Error(providerError.userMessage ?? providerError.message);
        }
      }

      const primaryNames = unique(resolved.searchProviders);
      const fallbackNames = unique(
        resolved.fallbackProviders.filter((name) => !primaryNames.includes(name)),
      );

      const primaries = primaryNames
        .map((name) => providers[name])
        .filter((provider): provider is SearchProvider => !!provider && provider.isAvailable() && !isSearchProviderDisabled(provider.name));

      const mergedResultSets: SearchResult[][] = [];
      const successfulProviders: string[] = [];

      if (primaries.length > 0) {
        const settled = await Promise.allSettled(
          primaries.map((provider) => provider.search({ ...options, numResults, signal: options.signal })),
        );

        for (let i = 0; i < settled.length; i++) {
          const result = settled[i];
          const provider = primaries[i];
          if (result.status === "fulfilled") {
            mergedResultSets.push(result.value);
            successfulProviders.push(provider.name);
          } else {
            recordProviderFailure(provider.name, result.reason, errors, warnings);
          }
        }
      }

      let merged = mergeResults(mergedResultSets, numResults);
      const fallbackProvidersUsed: string[] = [];

      if (merged.length < numResults) {
        const fallbackCandidates = fallbackNames
          .map((name) => providers[name])
          .filter((provider): provider is SearchProvider => !!provider && provider.isAvailable() && !isSearchProviderDisabled(provider.name));

        for (const provider of fallbackCandidates) {
          try {
            const results = await provider.search({ ...options, numResults, signal: options.signal });
            mergedResultSets.push(results);
            merged = mergeResults(mergedResultSets, numResults);
            fallbackProvidersUsed.push(provider.name);
            if (merged.length >= numResults) break;
          } catch (error) {
            recordProviderFailure(provider.name, error, errors, warnings);
          }
        }
      }

      const providerNames = [...successfulProviders, ...fallbackProvidersUsed];
      if (providerNames.length > 0) {
        if (successfulProviders.length > 0 && fallbackProvidersUsed.length > 0) {
          warnings.push(`Used ${fallbackProvidersUsed.join("+")} fallback because primary providers returned too few results.`);
        }
        const providerLabel = fallbackProvidersUsed.length > 0
          ? `${providerNames.join("+")} (fallback)`
          : providerNames.join("+");
        return { results: merged, provider: providerLabel, errors, warnings };
      }

      const configuredNames = unique([...resolved.searchProviders, ...resolved.fallbackProviders]);
      if (configuredNames.length === 0) {
        throw new Error("No search providers are configured.");
      }

      const availableNames = configuredNames.filter((name) => {
        const provider = providers[name];
        return provider?.isAvailable() && !isSearchProviderDisabled(name);
      });
      if (availableNames.length === 0) {
        const disabled = configuredNames
          .filter((name) => isSearchProviderDisabled(name))
          .map((name) => `${name} (${getSearchProviderDisableReason(name) ?? "disabled"})`);
        const suffix = disabled.length > 0 ? ` Disabled for this session: ${disabled.join(", ")}.` : "";
        throw new Error(`No configured search providers are currently available.${suffix}`);
      }

      throw new Error(
        `All search providers failed. Tried: ${availableNames.join(", ")}.
${errors.join("\n")}`,
      );
    },

    listProviders(): SearchProviderStatus[] {
      return Object.entries(providers).map(([name, provider]) => ({
        name,
        available: provider.isAvailable(),
        role: resolved.searchProviders.includes(name)
          ? "primary" as const
          : resolved.fallbackProviders.includes(name)
            ? "fallback" as const
            : "unused" as const,
        disabledForSession: isSearchProviderDisabled(name),
        disabledReason: getSearchProviderDisableReason(name),
      }));
    },
  };
}

function recordProviderFailure(
  providerName: string,
  error: unknown,
  errors: string[],
  warnings: string[],
) {
  const providerError = normalizeSearchProviderError(providerName, error);
  errors.push(`${providerName}: ${providerError.message}`);

  if (providerError.disableForSession && !isSearchProviderDisabled(providerName)) {
    disableSearchProvider(providerName, providerError.disableReason ?? providerError.message);
    if (providerError.userMessage) warnings.push(providerError.userMessage);
  }

  return providerError;
}

function unique(names: string[]): string[] {
  return Array.from(new Set(names));
}
