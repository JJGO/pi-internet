import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { fetchWithProxy, type PinnedConnection } from "./proxy.js";

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

interface ValidatedUserUrl {
  url: URL;
  connection?: PinnedConnection;
}

export async function validateUserUrl(rawUrl: string | URL, policy: UserUrlPolicy = {}): Promise<URL> {
  return (await validateUserUrlForFetch(rawUrl, policy)).url;
}

async function validateUserUrlForFetch(rawUrl: string | URL, policy: UserUrlPolicy): Promise<ValidatedUserUrl> {
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
  if (policy.allowPrivateNetworks) return { url };

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (hostname === "localhost" || LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new Error(`Blocked local hostname: ${hostname}`);
  }

  const family = isIP(hostname);
  if (family !== 0) {
    assertPublicAddress(hostname, hostname);
    return { url, connection: { hostname, address: hostname, family } };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await (policy.lookup ?? defaultLookup)(hostname);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve ${hostname}: ${message}`);
  }
  if (addresses.length === 0) throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
  for (const result of addresses) assertPublicAddress(result.address, hostname);

  const selected = addresses[0];
  const selectedFamily = isIP(selected.address);
  return {
    url,
    connection: {
      hostname,
      address: selected.address,
      family: selectedFamily as 4 | 6,
    },
  };
}

export async function safeFetch(
  rawUrl: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = await validateUserUrlForFetch(rawUrl, options);
  let requestInit = { ...init };

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const response = await fetchWithProxy(current.url, { ...requestInit, redirect: "manual" }, {
      socksProxy: options.socksProxy,
      connection: current.connection,
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === maxRedirects) {
      await response.body?.cancel();
      throw new Error(`Too many redirects fetching ${current.url.toString()}`);
    }

    let next: ValidatedUserUrl;
    try {
      next = await validateUserUrlForFetch(new URL(location, current.url), options);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    requestInit = redirectRequestInit(current.url, next.url, response.status, requestInit);
    await response.body?.cancel();
    current = next;
  }

  throw new Error(`Too many redirects fetching ${current.url.toString()}`);
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

function assertPublicAddress(address: string, hostname: string): void {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  if (family === 0) throw new Error(`Resolved non-IP address for ${hostname}: ${address}`);

  const mappedIpv4 = family === 6 ? decodeMappedIpv4(normalized) : null;
  if (mappedIpv4) {
    if (blockedAddresses.check(mappedIpv4, "ipv4")) {
      throw new Error(`Blocked private or reserved address for ${hostname}: ${normalized}`);
    }
    return;
  }

  if (blockedAddresses.check(normalized, family === 6 ? "ipv6" : "ipv4")) {
    throw new Error(`Blocked private or reserved address for ${hostname}: ${normalized}`);
  }
}

function decodeMappedIpv4(address: string): string | null {
  if (!address.startsWith("::ffff:")) return null;
  const suffix = address.slice("::ffff:".length);
  if (isIP(suffix) === 4) return suffix;
  const groups = suffix.split(":");
  if (groups.length !== 2 || groups.some((group) => !/^[\da-f]{1,4}$/i.test(group))) return null;
  const high = Number.parseInt(groups[0], 16);
  const low = Number.parseInt(groups[1], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}
