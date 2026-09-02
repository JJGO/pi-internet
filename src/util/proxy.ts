import { socksConnector, socksDispatcher } from "fetch-socks";
import { Agent, buildConnector } from "undici";
import { loadConfig } from "../config.js";

type SupportedSocksProtocol = "socks:" | "socks4:" | "socks4a:" | "socks5:" | "socks5h:";

type ProxyAwareRequestInit = RequestInit & { dispatcher?: unknown };

interface ParsedSocksProxy {
  url: string;
  protocol: SupportedSocksProtocol;
  host: string;
  port: number;
  type: 4 | 5;
  userId?: string;
  password?: string;
}

const SUPPORTED_PROTOCOLS = new Set<SupportedSocksProtocol>([
  "socks:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:",
]);

const dispatcherCache = new Map<string, unknown>();

export interface PinnedConnection {
  hostname: string;
  address: string;
  family: 4 | 6;
}

export interface ProxyOptions {
  socksProxy?: string | null;
  connection?: PinnedConnection;
}

export function resolveSocksProxy(options?: ProxyOptions): string | null {
  if (options && "socksProxy" in options) {
    if (typeof options.socksProxy !== "string") return null;
    const trimmed = options.socksProxy.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return loadConfig().fetch.socksProxy;
}

export function parseSocksProxyUrl(url: string): ParsedSocksProxy {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid SOCKS proxy URL: ${url}`);
  }

  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol as SupportedSocksProtocol)) {
    throw new Error(`Unsupported SOCKS proxy protocol: ${parsed.protocol}`);
  }

  if (!parsed.hostname) {
    throw new Error("SOCKS proxy URL must include a hostname");
  }

  if (!parsed.port) {
    throw new Error("SOCKS proxy URL must include a port");
  }

  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid SOCKS proxy port: ${parsed.port}`);
  }

  const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;

  return {
    url,
    protocol: parsed.protocol as SupportedSocksProtocol,
    host: parsed.hostname,
    port,
    type: parsed.protocol.startsWith("socks4") ? 4 : 5,
    ...(username ? { userId: username } : {}),
    ...(password ? { password } : {}),
  };
}

export function getSocksDispatcher(options?: ProxyOptions): unknown {
  const socksProxy = resolveSocksProxy(options);
  const connection = options?.connection;
  if (connection) return getPinnedDispatcher(connection, socksProxy);
  if (!socksProxy) return undefined;

  const cached = dispatcherCache.get(socksProxy);
  if (cached) return cached;

  const dispatcher = socksDispatcher(parseSocksProxyUrl(socksProxy));
  dispatcherCache.set(socksProxy, dispatcher);
  return dispatcher;
}

function getPinnedDispatcher(connection: PinnedConnection, socksProxy: string | null): Agent {
  const key = [socksProxy ?? "direct", connection.hostname, connection.address, connection.family].join("\0");
  const cached = dispatcherCache.get(key);
  if (cached) return cached as Agent;

  let dispatcher: Agent;
  if (socksProxy) {
    const connector = socksConnector(parseSocksProxyUrl(socksProxy), { servername: connection.hostname });
    dispatcher = new Agent({
      connect(options, callback) {
        connector({
          ...options,
          hostname: connection.address,
          servername: connection.hostname,
        }, callback);
      },
    });
  } else {
    const connector = buildConnector({
      lookup(_hostname, options, callback) {
        if (options.all) {
          callback(null, [{ address: connection.address, family: connection.family }]);
        } else {
          callback(null, connection.address, connection.family);
        }
      },
    });
    dispatcher = new Agent({ connect: connector });
  }

  dispatcherCache.set(key, dispatcher);
  return dispatcher;
}

export async function fetchWithProxy(
  input: string | URL | Request,
  init: RequestInit = {},
  options?: ProxyOptions,
): Promise<Response> {
  const dispatcher = getSocksDispatcher(options);
  if (!dispatcher) {
    return fetch(input, init);
  }

  return fetch(input, { ...(init as ProxyAwareRequestInit), dispatcher });
}

export function applySocksProxyEnv(env: NodeJS.ProcessEnv, options?: ProxyOptions): NodeJS.ProcessEnv {
  const socksProxy = resolveSocksProxy(options);
  if (!socksProxy) return env;

  return {
    ...env,
    ALL_PROXY: socksProxy,
    all_proxy: socksProxy,
  };
}

export async function resetSocksProxyDispatchers(): Promise<void> {
  const dispatchers = [...dispatcherCache.values()];
  dispatcherCache.clear();

  await Promise.allSettled(dispatchers.map(async (dispatcher) => {
    const close = (dispatcher as { close?: () => Promise<void> }).close;
    if (typeof close === "function") {
      await close.call(dispatcher);
    }
  }));
}

export const __test__ = {
  applySocksProxyEnv,
  parseSocksProxyUrl,
  resolveSocksProxy,
};
