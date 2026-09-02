# Plan — Network Safety Hardening

Date: 2026-06-04

> Historical planning snapshot. This document records the pre-implementation state and proposed work. The current implementation and README supersede its risk inventory and status statements.

## Goal

Add one shared, tested network-safety boundary for `pi-internet` so every current and future URL dereference is bounded, redirect-safe, and resistant to SSRF-style access to local/private networks.

This is a prerequisite for later integrations such as SearXNG, browser rendering, Crawl4AI/Firecrawl, document converters, and provider-native extract/crawl APIs.

## Current risk inventory

Current code already has timeouts and some size checks, but they are fragmented by handler.

### Existing behavior

- `src/fetch/http.ts`
  - Uses `fetchWithProxy(..., redirect: "follow")`.
  - Checks `content-length` against 5 MB before reading.
  - Still calls `response.text()` / `arrayBuffer()` unbounded when `content-length` is missing or wrong.
  - Follows redirects automatically, so redirect targets are not validated.
- `src/fetch/pdf.ts`
  - Fetches PDFs and calls `response.arrayBuffer()` before checking the 20 MB PDF cap.
  - Does not manually validate redirects.
- `src/fetch/jina.ts`
  - Sends the target URL to Jina and reads `res.text()` unbounded.
  - Should validate the original target URL before delegating to Jina.
- `src/fetch/reddit.ts` and `src/fetch/twitter.ts`
  - Rewrite user URLs to configured proxy hosts and read `res.text()` unbounded.
  - Proxy hosts come from config/env and should be normalized/validated, but still need byte caps and redirect checks.
- `src/fetch/github-api.ts`
  - GitHub REST fallback reads JSON without response-size caps.
  - `gh` CLI calls are time-limited and fixed to GitHub APIs, but output buffers are large and should stay bounded.
- Search providers
  - Provider URLs are fixed API endpoints, not arbitrary user URLs.
  - They still read error bodies / JSON without a shared byte cap.

### Main risks to address

1. Fetching localhost/private/link-local/internal URLs directly.
2. Following redirects from public URLs to unsafe destinations.
3. Reading arbitrarily large responses when `content-length` is absent or inaccurate.
4. Inconsistent timeout/error messages across handlers.
5. Future external services becoming URL-safety bypasses.

## Non-goals

- Do not implement browser rendering in this pass.
- Do not add new search providers in this pass.
- Do not solve universal network anonymity/privacy.
- Do not create a full sandbox for document conversion yet.
- Do not block fixed first-party provider API calls solely because their DNS resolves to private infrastructure; the SSRF guard primarily targets user-controlled destination URLs and redirects.

## Design principles

1. **One gate:** every user-controlled URL dereference goes through the same validation and bounded-read helpers.
2. **Manual redirects:** no `redirect: "follow"` for user-controlled fetches.
3. **Bound while reading:** response size limits must be enforced during stream consumption, not only via `content-length`.
4. **Fail closed for user URLs:** unsafe or ambiguous user-controlled destinations should return actionable errors.
5. **Provider-aware policy:** fixed provider APIs can use a less restrictive policy, but any URL sent to an external provider for fetching/rendering must first pass the user-URL policy.
6. **Proxy is not a bypass:** SOCKS and future external browser/crawler backends must still use preflight URL validation.

## Proposed modules

### `src/util/url-safety.ts`

Responsibilities:

- Parse and normalize URL inputs.
- Reject unsupported schemes.
- Reject URL userinfo.
- Classify hostnames and IP literals.
- Resolve DNS for user-controlled hosts where practical.
- Reject unsafe IP ranges.
- Resolve and validate redirect `Location` headers.
- Provide reusable policy objects.

Sketch:

```ts
export interface UrlSafetyPolicy {
  allowPrivateNetworks: boolean;
  allowLocalhost: boolean;
  allowHttp: boolean;
  allowUserinfo: boolean;
  resolveDns: boolean;
}

export interface UrlSafetyResult {
  url: URL;
  warnings: string[];
}

export function validateUserUrl(rawUrl: string, policy?: Partial<UrlSafetyPolicy>): Promise<UrlSafetyResult>;
export function validateRedirectLocation(baseUrl: URL, location: string, policy?: Partial<UrlSafetyPolicy>): Promise<UrlSafetyResult>;
export function isUnsafeIpAddress(hostOrIp: string): boolean;
```

Default user-URL policy:

- allow `https:` and `http:`.
- reject `file:`, `data:`, `ftp:`, `gopher:`, `ws:`, `wss:`, etc.
- reject `username:password@host`.
- reject localhost names:
  - `localhost`
  - `localhost.`
  - `*.localhost`
- reject obvious local/special names by default:
  - `.local`
  - `.internal`
  - `.lan`
  - `.home.arpa`
- reject unsafe IP literals and DNS answers:
  - IPv4 private: `10/8`, `172.16/12`, `192.168/16`
  - IPv4 loopback: `127/8`
  - IPv4 link-local: `169.254/16`
  - IPv4 unspecified/current-network: `0/8`, `0.0.0.0`
  - IPv4 multicast/reserved/broadcast: `224/4`, `240/4`, `255.255.255.255`
  - IPv6 loopback: `::1`
  - IPv6 unspecified: `::`
  - IPv6 unique local: `fc00::/7`
  - IPv6 link-local: `fe80::/10`
  - IPv6 multicast: `ff00::/8`
  - IPv4-mapped IPv6 equivalents.

### `src/util/safe-fetch.ts`

Responsibilities:

- Wrap `fetchWithProxy` with URL validation, manual redirect handling, timeout composition, and bounded body reads.
- Preserve SOCKS proxy support.
- Return redirect provenance for output warnings.

Sketch:

```ts
export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  socksProxy?: string | null;
  signal?: AbortSignal;
  headers?: HeadersInit;
  method?: string;
  body?: BodyInit;
  policy?: Partial<UrlSafetyPolicy>;
  validateUserUrl?: boolean;
}

export interface SafeFetchResponse {
  response: Response;
  finalUrl: string;
  redirects: Array<{ from: string; to: string }>;
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResponse>;
export async function readResponseText(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean; bytesRead: number }>;
export async function readResponseBuffer(response: Response, maxBytes: number): Promise<{ buffer: ArrayBuffer; truncated: boolean; bytesRead: number }>;
export async function readResponseJson<T>(response: Response, maxBytes: number): Promise<T>;
```

Redirect behavior:

- Use `redirect: "manual"`.
- Handle `301`, `302`, `303`, `307`, `308`.
- Resolve relative `Location` against current URL.
- Validate each redirect target with the same user URL policy.
- Cap at e.g. 10 redirects.
- For `303`, convert method to `GET` and drop body. For other statuses, preserve standard fetch semantics as much as is practical.
- Track cross-host redirects for optional output warnings.

Bounded read behavior:

- Check `content-length` as a fast preflight.
- Then read `response.body` stream chunk-by-chunk.
- Abort/return truncation once `maxBytes + 1` is exceeded.
- For safety hardening, binary/PDF reads should hard-fail if over cap; text reads can either hard-fail or return truncated depending on call site.

## Policy categories

### User URL policy

Use for:

- `fetch_url` general HTTP.
- PDF fetches.
- Reddit/Twitter original URL validation.
- GitHub raw/blob URLs if direct HTTP fallback is used.
- Any future browser/crawler/document converter target URL.
- Any target URL sent to Jina, Firecrawl, Tavily Extract, Crawl4AI, Browserless, Cloudflare Browser Rendering, etc.

### Configured proxy/frontend host policy

Use for:

- Redlib proxy host.
- Nitter proxy host.
- Future Invidious/Piped/SearXNG/Scribe/BreezeWiki hosts.

Default should still reject localhost/private hosts unless the user explicitly enables local backends. Some users may self-host local proxies, so this needs a configuration decision.

### Fixed provider API policy

Use for:

- Brave API.
- Tavily API.
- Kagi endpoint.
- GitHub REST API.
- Jina Reader host itself.

These are not arbitrary user URLs, so SSRF risk is lower. Still use bounded reads and timeouts. Redirects should generally be disabled or manually validated to same-host/known-host.

## Configuration proposal

Add a small, conservative config block:

```json
{
  "piInternet": {
    "network": {
      "allowPrivateNetworks": false,
      "allowLocalhost": false,
      "allowHttp": true,
      "resolveDns": true,
      "maxRedirects": 10,
      "maxHtmlBytes": 5242880,
      "maxPdfBytes": 20971520,
      "maxProviderBodyBytes": 5242880
    }
  }
}
```

Potential local-backend escape hatch for future browser/crawler/SearXNG work:

```json
{
  "piInternet": {
    "network": {
      "allowedPrivateHosts": ["127.0.0.1:11235", "localhost:3000"]
    }
  }
}
```

Recommendation for this pass:

- Add only the core booleans and caps if implementation needs them.
- Do not add `allowedPrivateHosts` until a concrete local-backend integration requires it, unless tests/config ergonomics become cleaner with it now.

## Implementation phases

### Phase 1 — URL parsing and address classification

Files:

- Add `src/util/url-safety.ts`.
- Add `test/url-safety.test.ts`.

Tasks:

- Implement URL parse/normalization.
- Reject unsupported schemes and userinfo.
- Implement hostname blocklist for local/special names.
- Implement IPv4/IPv6 parsing/classification, including IPv4-mapped IPv6.
- Implement optional DNS resolution using `node:dns/promises.lookup(host, { all: true, verbatim: true })`.
- Cache DNS validation results for the lifetime of a request, not globally at first.

Tests:

- Allows `https://example.com/path?q=1`.
- Rejects `file:///etc/passwd`, `data:text/plain,hi`, `ftp://example.com`.
- Rejects `https://user:pass@example.com`.
- Rejects `http://localhost`, `http://127.0.0.1`, `http://[::1]`.
- Rejects private IPv4 ranges.
- Rejects IPv6 ULA/link-local/multicast/unspecified.
- Rejects IPv4-mapped loopback/private IPv6.
- Rejects `.local`/`.internal` names.

### Phase 2 — Safe fetch and bounded reads

Files:

- Add `src/util/safe-fetch.ts`.
- Add `test/safe-fetch.test.ts`.

Tasks:

- Implement `safeFetch` over `fetchWithProxy`.
- Compose timeout with caller signal.
- Force `redirect: "manual"`.
- Follow and validate redirects manually.
- Add bounded `text`, `buffer`, and `json` readers.
- Keep `socksProxy` dispatcher behavior intact.

Tests:

- Valid response returns text.
- `content-length` over cap fails before body read.
- Missing `content-length` but oversized streamed body is capped.
- Redirect to public URL succeeds and records redirect.
- Redirect to localhost/private URL fails.
- Redirect loop/max redirects fails.
- Timeout still returns existing style of actionable timeout errors where call sites map it.

### Phase 3 — Integrate direct fetch handlers

Files:

- Update `src/fetch/http.ts`.
- Update `src/fetch/pdf.ts`.
- Update `src/fetch/jina.ts`.
- Update `src/fetch/reddit.ts`.
- Update `src/fetch/twitter.ts`.

Tasks:

- Replace direct `fetchWithProxy` user-URL fetches with `safeFetch`.
- Replace unbounded `response.text()` / `arrayBuffer()` calls with bounded readers.
- Validate original URL before sending it to Jina Reader.
- Validate Reddit/Twitter original URLs before rewriting to proxy.
- Validate configured proxy URL fetches; decide whether local/private proxy hosts are allowed now or blocked by default.
- Preserve existing output formats.
- Add cross-host redirect notices where useful.

Tests:

- Existing fetch tests still pass.
- HTTP oversized no-header response is rejected/truncated according to chosen call-site policy.
- PDF oversized no-header response is rejected before full extraction.
- Jina is not called for unsafe original target URLs.
- Reddit/Twitter proxy fetches enforce byte caps.

### Phase 4 — Integrate provider/API reads

Files:

- Update `src/fetch/github-api.ts`.
- Update search providers as needed: `brave.ts`, `kagi.ts`, `tavily.ts`.

Tasks:

- Use bounded readers for GitHub REST JSON/error bodies.
- Use bounded readers for search provider JSON/error bodies.
- Consider same-host redirect policy for fixed provider APIs.
- Preserve existing provider error classification.

Tests:

- Brave 429/402 body parsing still works with bounded body reads.
- Provider oversized/error body does not blow memory.
- GitHub REST fallback still works in mocked tests.

### Phase 5 — Config/docs/diagnostics

Files:

- Update `src/config.ts` if adding config options.
- Update `README.md`.
- Update `WEB_EXTENSIONS_COMPARISON.md` status/roadmap after implementation.

Tasks:

- Document blocked URL classes.
- Document local/private backend behavior.
- Add clear error messages:
  - `Blocked unsafe URL: localhost is not allowed`
  - `Blocked redirect to private address: http://127.0.0.1/...`
  - `Response too large: exceeded 5 MB while reading`
- If config is added, include env vars only if needed. Avoid over-configuring.

## Open decisions before implementation

1. **Should local/self-hosted proxies be allowed now?**
   - Conservative default: block localhost/private proxy hosts.
   - Developer-friendly option: allow configured proxy/frontend hosts to be local/private while still blocking arbitrary user target URLs.
   - Recommendation: default block; add explicit allowlist only if needed.

2. **Should unsafe URLs be blocked for all tools or only `fetch_url`?**
   - Recommendation: block user-controlled URL dereferences everywhere. Search query strings are not URL dereferences and do not need this policy.

3. **Should HTTP be allowed?**
   - Recommendation: yes for public web compatibility, but keep private-network blocking and redirect validation.

4. **Should DNS resolution failures block?**
   - Recommendation: for user-controlled URLs, fail closed with a clear `Could not resolve host` error. For fixed provider APIs, preserve current behavior.

5. **How strict should configured SOCKS proxy behavior be?**
   - With `socks5h`, the proxy may resolve DNS differently from local validation.
   - Recommendation: still perform local DNS validation for user URLs as a best-effort SSRF guard, document that remote proxy DNS can differ, and never allow IP literals/private hostnames by default.

6. **Text over cap: hard error or truncate?**
   - Recommendation: hard error for network response cap in this safety pass. Separately implement user-facing pagination/full-output save in the next Fetch UX task.

## Acceptance criteria

- All current tests pass.
- New URL-safety and safe-fetch tests cover unsafe schemes, userinfo, private IPs, IPv6 edge cases, DNS resolution, redirects, oversized streaming bodies, and timeouts.
- `fetch_url` no longer follows redirects automatically for user-controlled URLs.
- No current handler reads unbounded `text()`/`arrayBuffer()` for user-controlled network responses.
- PDF fetch enforces its byte cap while downloading, before parsing.
- Jina fallback validates the original target URL before sending it to `r.jina.ai`.
- GitHub/search provider error-body reads are bounded.
- README documents the network safety behavior and any opt-out/allowlist choices.

## Suggested implementation order

1. Implement and test `url-safety.ts`.
2. Implement and test `safe-fetch.ts` with mocked `globalThis.fetch`.
3. Migrate `http.ts` and `pdf.ts` first.
4. Migrate `jina.ts`, `reddit.ts`, and `twitter.ts`.
5. Migrate GitHub REST and search provider body reads.
6. Update docs.
7. Run `npm test`.
8. Manually smoke-test:
   - regular public HTML URL
   - public PDF URL
   - redirecting public URL
   - blocked localhost URL
   - GitHub PR URL
   - YouTube URL

## Notes for later tasks

- The next Fetch UX task should build on bounded reads to add offset pagination, full-output save, and stable cache paths.
- Future browser/crawler integrations must call `validateUserUrl` before sending any target URL to external backends.
- Future local backends such as Crawl4AI or Browserless may need a separate config allowlist for backend endpoint hosts; this should not weaken target URL validation.
