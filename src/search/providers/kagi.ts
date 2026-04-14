/**
 * Kagi Search provider — uses session token + HTML scraping.
 *
 * Provenance: pi-kagi-search/index.ts
 * Borrowed: Session token auth via cookie, HTML scraping of kagi.com/html/search,
 * result selectors (.search-result, .__sri_title_link, .__sri-desc),
 * grouped result fallback (.sr-group .__srgi), related searches extraction.
 * Token resolution chain: env var → JSON config → plain text file.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseHTML } from "linkedom";
import type { SearchOptions, SearchProvider, SearchResult } from "../types.js";

const CONFIG_FILE = join(homedir(), ".pi", "kagi-search.json");
const TOKEN_FILE = join(homedir(), ".kagi_session_token");
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15";

export function getKagiToken(): string | undefined {
  // 1. Environment variable
  const envToken = process.env.KAGI_SESSION_TOKEN;
  if (envToken) return envToken;

  // 2. JSON config file
  try {
    if (existsSync(CONFIG_FILE)) {
      const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      if (config.sessionToken) return config.sessionToken;
    }
  } catch {
    // ignore
  }

  // 3. Plain text file fallback
  try {
    if (existsSync(TOKEN_FILE)) {
      return readFileSync(TOKEN_FILE, "utf-8").trim();
    }
  } catch {
    // ignore
  }

  return undefined;
}

export function setKagiToken(token: string): void {
  const dir = join(homedir(), ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ sessionToken: token }, null, 2), { mode: 0o600 });
}

export const kagi: SearchProvider = {
  name: "kagi",

  isAvailable() {
    return Boolean(getKagiToken());
  },

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const token = getKagiToken();
    if (!token) throw new Error("Kagi session token not configured");

    const limit = options.numResults ?? 10;
    const res = await fetch(
      `https://kagi.com/html/search?q=${encodeURIComponent(options.query)}`,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Cookie: `kagi_session=${token}`,
        },
        signal: options.signal,
      },
    );

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error("Invalid or expired Kagi session token");
      }
      throw new Error(`Kagi HTTP ${res.status}: ${res.statusText}`);
    }

    const html = await res.text();
    return parseKagiResults(html, limit);
  },
};

function parseKagiResults(html: string, limit: number): SearchResult[] {
  const { document: root } = parseHTML(html);
  const results: SearchResult[] = [];

  // Primary: standard search results
  for (const el of root.querySelectorAll(".search-result")) {
    if (results.length >= limit) break;
    const titleLink = el.querySelector(".__sri_title_link");
    if (!titleLink) continue;
    const title = titleLink.textContent.trim();
    const url = titleLink.getAttribute("href");
    if (!title || !url) continue;
    const snippetEl = el.querySelector(".__sri-desc");
    results.push({
      title,
      url,
      snippet: snippetEl ? snippetEl.textContent.trim() : "",
      provider: "kagi",
    });
  }

  // Fallback: grouped results
  if (results.length < limit) {
    for (const el of root.querySelectorAll(".sr-group .__srgi")) {
      if (results.length >= limit) break;
      const titleLink = el.querySelector(".__srgi-title a");
      if (!titleLink) continue;
      const title = titleLink.textContent.trim();
      const url = titleLink.getAttribute("href");
      if (!title || !url) continue;
      const snippetEl = el.querySelector(".__sri-desc");
      results.push({
        title,
        url,
        snippet: snippetEl ? snippetEl.textContent.trim() : "",
        provider: "kagi",
      });
    }
  }

  return results;
}
