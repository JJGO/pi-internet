import { Readable, addAbortSignal, pipeline, type Transform } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { request, type Dispatcher } from "undici/index.js";
import { singleHopRedirect } from "./single-hop.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DECODERS = new Map<string, () => Transform>([
  ["gzip", createGunzip], ["x-gzip", createGunzip], ["deflate", createInflate], ["br", createBrotliDecompress],
]);

/** Bun ignores fetch dispatchers; Undici fetch stalls on larger Bun web-stream
 * bodies. This is a single-hop adapter, not a Fetch redirect implementation:
 * safeFetch owns validated redirects on every runtime. */
export async function fetchWithBunDispatcher(
  input: string | URL | Request,
  init: RequestInit,
  dispatcher: Dispatcher,
): Promise<Response> {
  const req = new Request(input, { ...init, redirect: singleHopRedirect(input, init) });
  const headers = Object.fromEntries(req.headers);
  if (!req.headers.has("accept-encoding")) headers["accept-encoding"] = "gzip, deflate, br";
  const result = await request(req.url, {
    dispatcher,
    method: req.method as Dispatcher.HttpMethod,
    headers,
    body: req.body ? Readable.fromWeb(req.body as Parameters<typeof Readable.fromWeb>[0]) : undefined,
    signal: req.signal,
  });
  // A response discarded before a web reader exists must not emit an unhandled
  // error. Pipeline/toWeb still forward errors to readers of retained bodies.
  result.body.on("error", () => {});
  if (req.redirect === "error" && REDIRECT_STATUSES.has(result.statusCode)) {
    result.body.destroy();
    throw new Error("Unexpected redirect; use safeFetch for validated redirects");
  }
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(result.headers)) {
    if (Array.isArray(value)) value.forEach((part) => responseHeaders.append(name, part));
    else if (value !== undefined) responseHeaders.set(name, value);
  }
  const noBody = req.method === "HEAD" || [204, 205, 304].includes(result.statusCode);
  let body: ReadableStream<Uint8Array> | null = null;
  if (noBody) {
    result.body.destroy();
  } else {
    try {
      const decoded = decodeBody(result.body, responseHeaders);
      // Undici stops watching the signal when the network ends. Decoding can
      // still be pending, so retain cancellation until this stream is consumed.
      addAbortSignal(req.signal, decoded);
      body = Readable.toWeb(decoded, {
        strategy: { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
      }) as ReadableStream<Uint8Array>;
    } catch (error) {
      result.body.destroy();
      throw error;
    }
  }
  const response = new Response(body, { status: result.statusCode, headers: responseHeaders });
  Object.defineProperty(response, "url", { value: req.url });
  return response;
}

function decodeBody(source: Readable, headers: Headers): Readable {
  const encodings = (headers.get("content-encoding") ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (encodings.length > 5) throw new Error("Too many response content encodings (maximum 5)");
  const factories = encodings.filter((encoding) => encoding !== "identity").reverse().map((encoding) => {
    const factory = DECODERS.get(encoding);
    if (!factory) throw new Error(`Unsupported response encoding: ${encoding}`);
    return factory;
  });
  if (!factories.length) return source;
  const decoders = factories.map((factory) => factory());
  // Native pipeline propagates backpressure and destroys the complete chain
  // when the web reader cancels, aborts, or hits a caller's decoded-byte limit.
  pipeline([source, ...decoders], () => {});
  headers.delete("content-encoding");
  headers.delete("content-length");
  return decoders.at(-1)!;
}
