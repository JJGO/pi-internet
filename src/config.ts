/**
 * Configuration loading from Pi settings files.
 *
 * Provenance: pi-kagi-search/index.ts (token resolution chain),
 * pi-web-access/github-extract.ts (config normalization with safe defaults).
 *
 * Config lives in Pi's settings files (~/.pi/agent/settings.json or .pi/settings.json)
 * under the `piInternet` key. The legacy `piWebSurf` key is also supported
 * for backward compatibility. API keys and optional social proxy hosts can
 * come from environment variables.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface PiInternetConfig {
  searchProviders: string[];
  fallbackProviders: string[];
  reddit: {
    commentDepth: number;
    proxyHost: string | null;
    rateLimitMs: number;
  };
  twitter: {
    proxyHost: string | null;
    rateLimitMs: number;
  };
  github: {
    enabled: boolean;
    maxRepoSizeMB: number;
    clonePath: string;
    refreshTtlMs: number;
  };
  youtube: {
    enabled: boolean;
  };
  fetch: {
    includeLinks: boolean;
    timeoutMs: number;
  };
}

export type PiWebSurfConfig = PiInternetConfig;

const CURRENT_CONFIG_KEY = "piInternet";
const LEGACY_CONFIG_KEY = "piWebSurf";
const REDLIB_PROXY_ENV = "PI_INTERNET_REDLIB_PROXY";
const NITTER_PROXY_ENV = "PI_INTERNET_NITTER_PROXY";
const warnedConfigPaths = new Set<string>();

const DEFAULTS: PiInternetConfig = {
  searchProviders: ["brave", "kagi"],
  fallbackProviders: ["tavily"],
  reddit: {
    commentDepth: 4,
    proxyHost: null,
    rateLimitMs: 1000,
  },
  twitter: {
    proxyHost: null,
    rateLimitMs: 1000,
  },
  github: {
    enabled: true,
    maxRepoSizeMB: 350,
    clonePath: join(homedir(), ".cache", "pi-internet", "github-repos"),
    refreshTtlMs: 300000,
  },
  youtube: {
    enabled: true,
  },
  fetch: {
    includeLinks: false,
    timeoutMs: 30000,
  },
};

/**
 * Load config fresh from disk every time.
 * This is just 2 readFileSync calls — negligible cost vs any fetch().
 * Avoids the stale-closure bug where a cached config survives session switches.
 */
export function loadConfig(): PiInternetConfig {
  const raw = loadRawConfig();
  return mergeWithDefaults(raw);
}

function loadRawConfig(): Record<string, unknown> {
  const paths = [
    join(homedir(), ".pi", "agent", "settings.json"),
    join(process.cwd(), ".pi", "settings.json"),
  ];

  let merged: Record<string, unknown> = {};

  for (const configPath of paths) {
    try {
      if (!existsSync(configPath)) continue;
      const text = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(text);
      const projectConfig = extractProjectConfig(parsed);
      if (projectConfig) {
        merged = mergeObjects(merged, projectConfig);
      }
    } catch (err) {
      warnConfigOnce(configPath, err);
    }
  }

  return merged;
}

function extractProjectConfig(parsed: unknown): Record<string, unknown> | null {
  if (!isPlainObject(parsed)) return null;

  const legacy = isPlainObject(parsed[LEGACY_CONFIG_KEY])
    ? parsed[LEGACY_CONFIG_KEY] as Record<string, unknown>
    : null;
  const current = isPlainObject(parsed[CURRENT_CONFIG_KEY])
    ? parsed[CURRENT_CONFIG_KEY] as Record<string, unknown>
    : null;

  if (legacy && current) return mergeObjects(legacy, current);
  return current ?? legacy;
}

function mergeWithDefaults(raw: Record<string, unknown>): PiInternetConfig {
  return {
    searchProviders: asStringArray(raw.searchProviders) ?? DEFAULTS.searchProviders,
    fallbackProviders: asStringArray(raw.fallbackProviders) ?? DEFAULTS.fallbackProviders,
    reddit: {
      commentDepth: asPositiveInt(get(raw, "reddit", "commentDepth")) ?? DEFAULTS.reddit.commentDepth,
      proxyHost: resolveProxyHost(REDLIB_PROXY_ENV, get(raw, "reddit", "proxyHost")),
      rateLimitMs: asPositiveInt(get(raw, "reddit", "rateLimitMs")) ?? DEFAULTS.reddit.rateLimitMs,
    },
    twitter: {
      proxyHost: resolveProxyHost(NITTER_PROXY_ENV, get(raw, "twitter", "proxyHost")),
      rateLimitMs: asPositiveInt(get(raw, "twitter", "rateLimitMs")) ?? DEFAULTS.twitter.rateLimitMs,
    },
    github: {
      enabled: asBool(get(raw, "github", "enabled")) ?? DEFAULTS.github.enabled,
      maxRepoSizeMB: asPositiveInt(get(raw, "github", "maxRepoSizeMB")) ?? DEFAULTS.github.maxRepoSizeMB,
      clonePath: asString(get(raw, "github", "clonePath")) ?? DEFAULTS.github.clonePath,
      refreshTtlMs: asPositiveInt(get(raw, "github", "refreshTtlMs")) ?? DEFAULTS.github.refreshTtlMs,
    },
    youtube: {
      enabled: asBool(get(raw, "youtube", "enabled")) ?? DEFAULTS.youtube.enabled,
    },
    fetch: {
      includeLinks: asBool(get(raw, "fetch", "includeLinks")) ?? DEFAULTS.fetch.includeLinks,
      timeoutMs: asPositiveInt(get(raw, "fetch", "timeoutMs")) ?? DEFAULTS.fetch.timeoutMs,
    },
  };
}

// --- helpers ---

function warnConfigOnce(configPath: string, err: unknown): void {
  if (warnedConfigPaths.has(configPath)) return;
  warnedConfigPaths.add(configPath);
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[pi-internet] Failed to read config ${configPath}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] = isPlainObject(existing) && isPlainObject(value)
      ? mergeObjects(existing, value)
      : value;
  }
  return merged;
}

function get(obj: Record<string, unknown>, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function asStringArray(val: unknown): string[] | undefined {
  if (!Array.isArray(val)) return undefined;
  const filtered = val.filter((v): v is string => typeof v === "string" && v.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

function asString(val: unknown): string | undefined {
  return typeof val === "string" && val.length > 0 ? val : undefined;
}

function resolveProxyHost(envName: string, rawValue: unknown): string | null {
  return asString(process.env[envName]) ?? asString(rawValue) ?? null;
}

function asBool(val: unknown): boolean | undefined {
  return typeof val === "boolean" ? val : undefined;
}

function asPositiveInt(val: unknown): number | undefined {
  if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) return undefined;
  return Math.floor(val);
}

export const __test__ = {
  mergeWithDefaults,
  mergeObjects,
};
