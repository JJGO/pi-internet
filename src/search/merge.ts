/**
 * Deduplicate search results by URL, keeping the richer snippet.
 *
 * Provenance: Original implementation.
 * Design rationale: When running Brave + Kagi in parallel, the same URL
 * may appear in both result sets. We keep whichever has a longer snippet
 * and cap to the requested count.
 */

import type { SearchResult } from "./types.js";

export function mergeResults(resultSets: SearchResult[][], maxResults: number): SearchResult[] {
  const byUrl = new Map<string, SearchResult>();

  for (const results of resultSets) {
    for (const result of results) {
      const normalizedUrl = normalizeUrl(result.url);
      const existing = byUrl.get(normalizedUrl);
      if (!existing || result.snippet.length > existing.snippet.length) {
        byUrl.set(normalizedUrl, result);
      }
    }
  }

  // Interleave from each provider set to maintain diversity,
  // then fill remaining slots with any leftovers
  const merged: SearchResult[] = [];
  const used = new Set<string>();

  // Round-robin across provider sets
  const maxLen = Math.max(...resultSets.map((s) => s.length));
  for (let i = 0; i < maxLen && merged.length < maxResults; i++) {
    for (const results of resultSets) {
      if (i >= results.length || merged.length >= maxResults) continue;
      const url = normalizeUrl(results[i].url);
      if (used.has(url)) continue;
      used.add(url);
      merged.push(byUrl.get(url) ?? results[i]);
    }
  }

  return merged;
}

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Strip trailing slash, www prefix, fragment
    let normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, "");
    normalized = normalized.replace("://www.", "://");
    if (parsed.search) normalized += parsed.search;
    return normalized;
  } catch {
    return url;
  }
}
