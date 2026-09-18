/**
 * Kagi image search — session token + HTML scraping of kagi.com/html/images.
 *
 * Endpoint notes (verified live 2026-02):
 * - `kagi.com/html/images?q=…` returns a full server-rendered image grid
 *   (~200 `.item._0_image_item` entries with structured `data-*` attributes).
 * - `kagi.com/html/search?q=…&batch=images` does NOT — it returns the web
 *   results page with only a small header-image widget.
 * - Missing/expired session tokens and suspicious queries both produce a
 *   302 redirect to Kagi's Cloudflare Turnstile bot check, so redirects are
 *   classified as auth failures rather than followed.
 * - Thumbnail URLs are signed `p.kagi.com/proxy/...` links that do not
 *   require the session cookie.
 */

import { parseHTML } from "linkedom";
import { SearchProviderError } from "../errors.js";
import { fetchWithProxy } from "../../util/proxy.js";
import { readResponseText } from "../../util/download.js";
import { getKagiToken } from "./kagi.js";

const MAX_PROVIDER_RESPONSE_BYTES = 5 * 1024 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15";

/** Guidance appended to errors the model should relay to the user. */
export const KAGI_IMAGES_PARSE_GUIDANCE =
  "Kagi returned a page with no parseable image results. Either the query has no image results, " +
  "or Kagi changed its HTML and the pi-internet image scraper is broken — tell the user so they " +
  "can fix or update the pi-internet extension.";

export interface KagiImageResult {
  title: string;
  /** Source page hosting the image (data-host_url). */
  pageUrl: string;
  /** Original full-resolution image URL (data-content_url). */
  imageUrl: string;
  /** Signed Kagi-proxied thumbnail URL (no auth required). */
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  /** Human-readable date as rendered by Kagi (e.g. "Aug 21, 2025"). */
  published?: string;
}

export interface KagiImageSearchOptions {
  query: string;
  numResults: number;
  signal?: AbortSignal;
  socksProxy?: string | null;
}

export async function searchKagiImages(options: KagiImageSearchOptions): Promise<KagiImageResult[]> {
  const token = getKagiToken();
  if (!token) {
    throw new SearchProviderError({
      provider: "kagi-images",
      message: "Kagi session token not configured. Ask the user to run /kagi-login to set it.",
      code: "auth",
    });
  }

  let res: Response;
  try {
    res = await fetchWithProxy(
      `https://kagi.com/html/images?q=${encodeURIComponent(options.query)}`,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Cookie: `kagi_session=${token}`,
        },
        signal: options.signal,
        redirect: "error",
      },
      { socksProxy: options.socksProxy },
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Kagi redirects to its Turnstile bot check when the session token is
    // missing/expired or the request looks automated; redirect: "error"
    // surfaces that as a fetch failure.
    if (isRedirectError(error)) {
      throw new SearchProviderError({
        provider: "kagi-images",
        message:
          "Kagi redirected to its bot check — the session token is likely invalid or expired. " +
          "Ask the user to run /kagi-login with a fresh token from kagi.com/settings?p=token.",
        code: "auth",
        cause: error,
      });
    }
    throw error;
  }

  if (!res.ok) {
    await res.body?.cancel();
    if (res.status === 401 || res.status === 403) {
      throw new SearchProviderError({
        provider: "kagi-images",
        message: "Invalid or expired Kagi session token. Ask the user to run /kagi-login.",
        statusCode: res.status,
        code: "auth",
      });
    }
    throw new SearchProviderError({
      provider: "kagi-images",
      message: `Kagi HTTP ${res.status}: ${res.statusText}`,
      statusCode: res.status,
      code: "http",
    });
  }

  const html = await readResponseText(res, MAX_PROVIDER_RESPONSE_BYTES, options.signal);
  const results = parseKagiImageResults(html, options.numResults);

  if (results.length === 0) {
    throw new SearchProviderError({
      provider: "kagi-images",
      message: KAGI_IMAGES_PARSE_GUIDANCE,
      code: "http",
    });
  }

  return results;
}

export function parseKagiImageResults(html: string, limit: number): KagiImageResult[] {
  const { document: root } = parseHTML(html);
  const results: KagiImageResult[] = [];

  for (const el of root.querySelectorAll("._0_image_item")) {
    if (results.length >= limit) break;

    // Collapse whitespace (linkedom decodes entities, so attribute values can
    // contain newlines) to keep hostile pages from injecting fake result rows
    // into the markdown output.
    const title = compactText(el.getAttribute("data-title"));
    const pageUrl = el.getAttribute("data-host_url") ?? "";
    const imageUrl = el.getAttribute("data-content_url") ?? "";
    if (!pageUrl || !imageUrl) continue;

    const thumbnailUrl = el.querySelector("._0_img_src")?.getAttribute("src") ?? undefined;

    results.push({
      title: title || compactText(el.getAttribute("data-filename")) || imageUrl,
      pageUrl,
      imageUrl,
      thumbnailUrl,
      width: asPositiveInt(el.getAttribute("data-width")),
      height: asPositiveInt(el.getAttribute("data-height")),
      published: compactText(el.getAttribute("data-date_published")) || undefined,
    });
  }

  return results;
}

function compactText(value: string | null): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function asPositiveInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isRedirectError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 10; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    if (/redirect/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
