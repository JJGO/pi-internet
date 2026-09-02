import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { fetchWithProxy } from "./proxy.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 10;
const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
// IPv4-mapped IPv6 literals are rejected explicitly below.
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export type UrlLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface UserUrlPolicy {
  allowPrivateNetworks?: boolean;
  lookup?: UrlLookup;
}

export interface SafeFetchOptions extends UserUrlPolicy {
  socksProxy?: string | null;
  maxRedirects?: number;
}

export async function validateUserUrl(rawUrl: string | URL, policy: UserUrlPolicy = {}): Promise<URL> {
  let url: URL;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${String(rawUrl)}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol || "missing"}`);
  }
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed");
  if (policy.allowPrivateNetworks) return url;

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (hostname === "localhost" || LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error(`Blocked local hostname: ${hostname}`);
  }

  const family = isIP(hostname);
  if (family !== 0) {
    assertPublicAddress(hostname, family, hostname);
    return url;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await (policy.lookup ?? defaultLookup)(hostname);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve ${hostname}: ${message}`);
  }
  if (addresses.length === 0) throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
  for (const result of addresses) assertPublicAddress(result.address, result.family, hostname);
  return url;
}

export async function safeFetch(
  rawUrl: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = await validateUserUrl(rawUrl, options);
  let requestInit = { ...init };

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const response = await fetchWithProxy(current, { ...requestInit, redirect: "manual" }, {
      socksProxy: options.socksProxy,
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === maxRedirects) {
      await response.body?.cancel();
      throw new Error(`Too many redirects fetching ${current.toString()}`);
    }

    let next: URL;
    try {
      next = await validateUserUrl(new URL(location, current), options);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    requestInit = redirectRequestInit(current, next, response.status, requestInit);
    await response.body?.cancel();
    current = next;
  }

  throw new Error(`Too many redirects fetching ${current.toString()}`);
}

function redirectRequestInit(from: URL, to: URL, status: number, init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  let method = init.method?.toUpperCase() ?? "GET";
  let body = init.body;

  if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
    method = "GET";
    body = undefined;
    headers.delete("content-length");
    headers.delete("content-type");
  }

  if (from.origin !== to.origin) {
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("proxy-authorization");
  }

  return { ...init, method, body, headers };
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function assertPublicAddress(address: string, _family: number, hostname: string): void {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const detectedFamily = isIP(normalized);
  if (detectedFamily === 0) throw new Error(`Resolved non-IP address for ${hostname}: ${address}`);
  const type = detectedFamily === 6 ? "ipv6" : "ipv4";
  const mappedIpv4 = type === "ipv6" && normalized.startsWith("::ffff:");
  if (mappedIpv4 || blockedAddresses.check(normalized, type)) {
    throw new Error(`Blocked private or reserved address for ${hostname}: ${normalized}`);
  }
}
