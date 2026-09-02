# Pi Web Extensions Comparison and Task Roadmap

Date: 2026-06-04

> Historical comparison snapshot. The current implementation and README supersede the baseline, gap analysis, and roadmap status below.

This document compares the Pi web/search/fetch extensions reviewed for `pi-internet`, identifies implementation patterns worth borrowing or avoiding, and ranks follow-up tasks by expected usefulness and impact.

## Scope and evaluation criteria

Reviewed packages were selected from live Pi/npm search results for web search, web fetch, web research, provider-specific web APIs, browser-backed fetch, and self-hosted-provider support. The review used package manifests, READMEs, and selected source files where available.

Extensions were ranked by:

1. Practical usefulness in day-to-day Pi coding-agent workflows.
2. Breadth of search/fetch/research coverage.
3. Correctness and extraction quality.
4. Security and runtime hardening.
5. UX clarity, diagnostics, and bounded output behavior.
6. Maintainability and dependency design.
7. Trustworthiness of provider/API handling.

Download counts were not treated as primary evidence.

## Current `pi-internet` baseline

`pi-internet` already has a strong foundation:

- `web_search` with parallel primary providers and fallback filling: Brave + Kagi primary, Tavily fallback.
- Provider result normalization and URL deduplication.
- Session disablement for Brave rate/usage-limit failures.
- `fetch_url` router with specialized handlers for Reddit, Twitter/X, GitHub, YouTube, PDFs, and general HTTP.
- GitHub repo/file/tree cloning/cache behavior, plus native GitHub API handling for user profiles, issues, PRs, releases, Actions runs/logs, commits, compares, and gists.
- YouTube metadata/transcript/playlist/channel support through `yt-dlp`.
- HTML extraction chain: Readability -> RSC parser -> Jina Reader fallback.
- Config overlay handling and useful commands such as `/search-providers`, `/kagi-login`, `/toggle-research`.
- Hidden `web_research` scout subprocess that keeps noisy search/fetch context out of the parent session.
- Solid tests for current search/config behavior and focused GitHub routing/API behavior.

### Recent GitHub support status

The latest `Improve GitHub fetch support` commit substantially completes the earlier GitHub expansion task. Current behavior now includes:

- Repo roots, trees, and blobs through the existing local clone/cache path.
- Branch names containing slashes and commit-ref URLs resolved before reading files.
- README-first rendering for repo roots and README previews for tree URLs with README anchors/tabs.
- Native GitHub collaboration routing before generic HTML extraction.
- PRs: metadata, body, timeline comments, reviews, review comments, commits, changed files, and status checks where available.
- Issues: metadata, body, labels, and comments.
- Releases: release lists, latest release, tagged release notes, and assets.
- Actions runs: run/job metadata; `verbose: true` attempts to save logs to a temp file via `gh run view --log-failed` / `--log`.
- Commits and compares: metadata, commit/file summaries, stats.
- Gists: metadata and inline file contents up to bounded limits.
- User/org profiles through the GitHub users API.
- REST API fallback with `GITHUB_TOKEN`/`GH_TOKEN` when `gh` is unavailable for most non-log metadata paths.

Remaining GitHub gaps to track:

- Discussions and discussion comments are recognized as GitHub paths but not yet rendered.
- List/index pages such as `/issues`, `/pulls`, `/actions`, `/commits`, `/tags`, `/branches`, `/labels`, `/milestones`, and `/releases` beyond the simple release list are either unsupported or shallow.
- Wiki, Projects, Packages, Security advisories, Insights/Graphs, network/forks/stargazers/watchers are intentionally not specialized yet.
- REST fallback fetches first pages only for comments/files/commits/reviews in several paths; very large PRs/issues need pagination or explicit truncation notices.
- Actions log export requires `gh`; REST fallback only returns run metadata. The output should say that more clearly when `verbose: true` cannot save logs.
- PR/commit/compare output summarizes changed files but does not yet save full diffs/patches as artifacts.
- `includeLinks` is accepted by the GitHub API route but not materially used yet.

Main gaps compared with the strongest competing designs:

- Centralized URL safety/SSRF/redirect/streaming-size hardening is not yet as explicit as the best safety-focused extensions.
- Search provider set is narrower than provider-router packages.
- Fetch output UX lacks universal pagination/full-output replay patterns.
- GitHub support now covers the highest-value collaboration surfaces, but still lacks Discussions/wiki/list-page support, paginated retrieval beyond first-page API caps, and optional diff/patch/log artifact exports beyond Actions logs.
- Research mode lacks persistent evidence cache and source-level extraction/collation workflow.
- Browser/JS-heavy support is intentionally limited and should remain behind explicit external backends.

## Ranked extension comparison

| Rank | Extension | Overall assessment | Distinctive features | Patterns to borrow | Patterns to avoid |
|---:|---|---|---|---|---|
| 1 | `pi-web-access` | Broadest practical all-in-one reference. Strong inspiration for general web access. | Search, URL fetch, GitHub cloning, PDF extraction, YouTube understanding, local video analysis, skills. | Broad URL-type router; useful specialized handlers; multimodal/video affordances where Pi supports them. | Avoid growing into a large monolith without strong adapter boundaries. |
| 2 | `pi-internet` | Cleanest foundation among reviewed packages: focused, typed, tested, provider fallback, specialized fetchers. Recent GitHub work closes much of the gap with fetch-specialist packages. | Parallel search router, fallback fill, social proxies, GitHub clone cache + GitHub API surfaces, YouTube transcript/list support, scout research. | Continue strengthening the router/normalizer design instead of replacing it. | Do not dilute the clean core with every provider/browser feature by default. |
| 3 | `pi-webaio` | Feature-rich all-in-one package with broad extraction dependencies. | Google/Brave/DDG search, fetch, headless/browser-ish summarization, Defuddle, PDF/math tooling, YouTube transcript package. | Defuddle extraction; richer document/PDF/math handling ideas; search provider variety. | Heavy dependency stack; hard-to-reason install/runtime footprint. |
| 4 | `@juicesharp/rpiv-web-tools` | Best provider-architecture reference. | Pluggable providers for Brave, Tavily, Serper, Exa, You.com, Jina, Firecrawl, Perplexity, SearXNG, Ollama. | Provider registry, per-provider metadata, normalized config/status, self-hosted SearXNG support. | Kitchen-sink provider exposure without clear defaults or privacy/cost warnings. |
| 5 | `@curio-data/pi-intelli-search` | Best research-pipeline reference. | Search -> fetch -> focused extract -> collate -> cache. Persistent `.search/` cache; query-relevant compression. | Evidence cache, focused extraction prompts, cross-source dedupe, prior-search suggestions. | Do not make answer synthesis the default behavior of `web_search`. Keep discovery, fetch, and synthesis separate. |
| 6 | `@bitcraft-apps/pi-web-tools` | Best safety/runtime-hardening reference. | Shell-only DuckDuckGo/webfetch; SSRF guard; response caps; charset sniffing; Retry-After handling; offset pagination; Markdown-first Accept header. | Central URL guard; manual redirect notice/validation; bounded streaming; charset sniff; `offset` pagination; Retry-After retry. | Strict “no per-host routing” does not fit `pi-internet`; specialized handlers are one of our strengths. |
| 7 | `@feniix/pi-exa` | Best provider-specific design for Exa. | Search, fetch, advanced search, answer, find-similar, deep research, local stateful research planner, strong schema validation. | Advanced tools disabled by default; provider-native validation; local key custody; research-planner state. | Avoid exposing provider-specific complexity in generic `web_search` unless explicitly selected. |
| 8 | `@demigodmode/pi-web-agent` | Strong architecture around explicit search/fetch/headless boundaries. | Compact/preview/verbose presentation, self-hosted backends, browser resolution, Firecrawl/headless fetch, research orchestration. | Presentation modes; explicit headless boundary; backend doctor/config command; evidence ranking concepts. | Browser automation should not be silently used by normal fetch. |
| 9 | `pi-web-providers` | Very broad provider menu. | Search, contents, quick answers, research across many hosted providers: Firecrawl, Exa, Parallel, Perplexity, Cloudflare, Valyu, Linkup, etc. | Explicit provider option schemas; normalize many external APIs behind common tools. | Too many default dependencies/providers can make installation, privacy, and cost posture unclear. |
| 10 | `@pi-unipi/web-api` | Modular web API package, but less directly usable as a Pi extension in its package metadata. | Defuddle/linkedom/wreq-based read/summarize provider design. | Defuddle and provider abstraction ideas. | Avoid unclear extension packaging/discoverability. |
| 11 | `@johnnywu/pi-webfetch` | Strong fetch-only UX reference. | Uses `gh` for GitHub repos/issues/PRs/releases/Actions/gists; `yt-dlp` for YouTube; Defuddle for general pages. | Expand GitHub URL classes via `gh`; clean output modes; explicit executable requirements. | Single-tool fetch-only scope is too narrow for `pi-internet`, but its URL-specific approach is useful. |
| 12 | `@weihan28/pi-tavily` | Focused Tavily API wrapper. | Search, extract, crawl, map. | Optional Tavily extract/crawl/map adapters. | Do not make Tavily-specific workflows generic defaults. |
| 13 | `@parallel-web/pi-extension` | Useful provider-specific wrapper. | Parallel search/fetch through provider SDK. | Optional Parallel adapter for advanced hosted retrieval. | Low differentiation if treated as just another basic search provider. |
| 14 | `pi-web-search` | Lightweight provider-native model search. | Google Gemini, OpenAI, Anthropic native web search and Gemini URL Context. | Provider-native model web-search fallback could be useful in advanced mode. | Model-provider search semantics differ from neutral search; do not mix silently. |
| 15 | `@narumitw/pi-firecrawl` | Focused Firecrawl wrapper. | Firecrawl scraping/crawling tools. | Optional Firecrawl scrape/crawl/map backend. | Hosted crawling can burn quota and leak URLs; keep explicit. |
| 16 | `@leing2021/pi-search` | Ambitious security/evidence-gateway framing. | Intent routing, quota fallback, dual-LLM research, abuse prevention. | Abuse-prevention framing and evidence-gateway language. | Complexity/routing opacity if not carefully bounded. |
| 17 | `pi-exa` | Older/general Exa wrapper. | Exa search, fetch, deep research. | Exa remains a useful optional provider. | Prefer the more polished design lessons from `@feniix/pi-exa`. |
| 18 | `@xl0/pi-lovely-web` | Less evidence of distinctive functionality from available package metadata. | Pi web extension packaging with image. | Minimal inspiration. | Do not copy unclear/underdocumented patterns. |
| 19 | `@0xkobold/pi-web` | Interesting README design but weaker trust due to package/source mismatch and dependency metadata. | Cascade fetch, DuckDuckGo/SearXNG, optional Playwright pool, deep research. | Optional browser pool with concurrency limits; SearXNG fallback idea. | Be cautious of packages whose manifest/dependency story does not match claimed features. |
| 20 | `@ollama/pi-web-search` | Narrow provider wrapper. | Ollama web search/fetch APIs. | Optional Ollama provider only if users ask for it. | Too provider-specific to influence core design. |

## Feature matrix

| Extension | Search | Fetch | Specialized URLs | Browser/JS | Research/synthesis | Cache | Safety emphasis | Self-hosted/provider flexibility |
|---|---|---|---|---|---|---|---|---|
| `pi-web-access` | Yes | Yes | GitHub, PDF, YouTube, video | Some/video-oriented | Some | Some | Medium | Medium |
| `pi-internet` | Brave/Kagi/Tavily | Yes | Reddit, X, GitHub repos/files/PRs/issues/releases/Actions/gists/commits/compares/users, YouTube, PDF | No browser; Jina fallback | Hidden scout | GitHub/YT caches; Actions logs temp artifact when verbose | Medium | Social proxies, SOCKS; GitHub REST token/`gh` auth |
| `pi-webaio` | Google/Brave/DDG | Yes | PDF/math/YouTube | Headless/summarization style | Yes | Unclear | Medium | Medium |
| `@juicesharp/rpiv-web-tools` | Many providers | Provider-dependent | Provider-dependent | Provider-dependent | Provider-dependent | Unclear | Medium | High |
| `@curio-data/pi-intelli-search` | Perplexity/OpenRouter | Yes | General web | No primary browser focus | Strong | Strong `.search/` | Medium | Model-configurable |
| `@bitcraft-apps/pi-web-tools` | DuckDuckGo/ddgr | Yes | Intentionally generic | No | No | No persistent cache | Strong | Shell tools |
| `@feniix/pi-exa` | Exa | Exa contents | Exa categories/domains | No | Strong Exa modes | Session research planner | Medium | Exa-specific |
| `@demigodmode/pi-web-agent` | DDG/SearXNG | Yes | General | Explicit headless | Strong orchestration | TTL cache | Medium | Self-hosted backends |
| `pi-web-providers` | Many hosted providers | Many hosted providers | Provider-dependent | Cloudflare/Firecrawl options | Yes | Provider-dependent | Medium | Very high |
| `@johnnywu/pi-webfetch` | No | Strong | GitHub, Gist, YouTube | No primary browser focus | No | Unclear | Medium | External CLIs |

## Patterns worth borrowing

### 1. Central safety gate before every network/backend call

Best reference: `@bitcraft-apps/pi-web-tools`.

Borrow:

- Reject non-HTTP(S) schemes.
- Reject userinfo in URLs.
- Reject localhost, loopback, link-local, private network, multicast, and special-use addresses unless explicitly allowed.
- Validate every redirect hop, not only the initial URL.
- Stream with hard byte caps instead of downloading unbounded responses.
- Surface cross-host redirects in-band.
- Keep all external backends behind the same URL guard so Jina, Firecrawl, Crawl4AI, browser backends, and proxies cannot bypass safety.

Why it matters: every future integration becomes riskier without this foundation.

### 2. Offset pagination and full-output replay

Best reference: `@bitcraft-apps/pi-web-tools`.

Borrow:

- `offset`/`limit`-style pagination for large extracted text.
- Truncation footer that tells the model exactly how to continue.
- Save full extraction to cache/Downloads where appropriate.

This improves long docs, PDFs, GitHub trees, YouTube playlists, and research artifacts.

### 3. Markdown-first HTTP negotiation

Best reference: `@bitcraft-apps/pi-web-tools`.

Borrow:

- Send an `Accept` header preferring `text/markdown` before HTML.
- If a server provides Markdown-for-agents output, use it before Readability.
- Pair with `llms.txt` / `llms-full.txt` discovery.

This is low-cost and often produces dramatically cleaner docs output.

### 4. Provider registry with metadata and status

Best reference: `@juicesharp/rpiv-web-tools` and `pi-web-providers`.

Borrow:

- Provider registry object rather than scattered provider conditionals.
- Provider metadata: env vars, config keys, hosted vs self-hosted, privacy note, cost note.
- A richer `/search-providers` or `/internet-doctor` command showing configured, available, disabled, and failing providers.

Avoid copying a huge provider menu into the default UX.

### 5. Advanced/provider-specific tools disabled by default

Best reference: `@feniix/pi-exa`.

Borrow:

- Keep generic `web_search` simple.
- Add provider-native advanced tools only when explicitly enabled.
- Validate provider-specific filters before calling the API.
- Prefer local key custody and explicit config.

### 6. Evidence cache and focused extraction pipeline

Best reference: `@curio-data/pi-intelli-search`.

Borrow:

- Cache prior research artifacts by query/task.
- Extract query-relevant passages per source before synthesis.
- Collate with source deduplication and inconsistency notes.
- Suggest related cached searches.

Keep this in `web_research`, not `web_search`.

### 7. GitHub through `gh`/API instead of HTML scraping

Best reference: `@johnnywu/pi-webfetch`.

Status: mostly borrowed in the latest GitHub support commit. `pi-internet` now handles the high-value GitHub collaboration surfaces agents often need:

- issues
- pull requests
- releases
- Actions runs/logs
- gists
- commits
- compares
- user/org profiles

Remaining patterns still worth borrowing or extending:

- paginated issue/PR/review/comment/file retrieval for very large threads
- Discussions/wiki/list-page rendering
- optional full diff/patch/log artifacts
- clearer `gh` versus REST fallback diagnostics
- raw URL normalization when a GitHub HTML/raw URL could be represented more directly

### 8. Explicit browser/headless boundary

Best references: `@demigodmode/pi-web-agent`, `@0xkobold/pi-web`.

Borrow:

- Separate browser-backed fetch/render tools from normal `fetch_url`.
- Browser backend selection: local CDP, Browserless, Cloudflare Browser Rendering, Browserbase, Crawl4AI.
- Concurrency, timeout, and output-size limits.

Avoid silently invoking Playwright from generic fetch.

### 9. Presentation modes

Best reference: `@demigodmode/pi-web-agent`.

Borrow:

- `compact`: short default summary/preview.
- `preview`: more metadata and headings.
- `verbose`: fuller bounded content.

This is especially useful for GitHub repos, YouTube playlists, PDFs, and research output.

### 10. External CLI adapters instead of reimplementation

Best references: `@johnnywu/pi-webfetch`, current `pi-internet` YouTube design.

Borrow/continue:

- `yt-dlp` remains the canonical YouTube extractor.
- `gh` should be the canonical GitHub issue/PR/API helper.
- Optional document converters should be adapters: `markitdown`, `pdftotext`, `pymupdf4llm`, `docling`, `tika`.
- Optional crawlers/renderers should be sidecars: Crawl4AI, Firecrawl, Browserless.

## Patterns to avoid

1. **No public proxy instance rotation.** Support user-configured Redlib/Nitter/Invidious/SearXNG/etc. instances only.
2. **No bundled browser dependency by default.** Browser automation should be explicit, optional, and externally configurable.
3. **No paywall-bypass features.** Do not add archive chains, search-engine impersonation, or cookie tricks aimed at access circumvention.
4. **No raw vendor JSON as main output.** Normalize into Pi-friendly Markdown and keep raw payloads in details/cache only.
5. **No answer synthesis inside generic search.** `web_search` should discover sources; `fetch_url` should read sources; `web_research` can synthesize.
6. **No kitchen-sink provider defaults.** Add providers behind clear config, status, privacy, and cost notes.
7. **No safety bypasses for external services.** Hosted extractors, sidecars, proxies, and browsers must use the same URL validation policy as direct HTTP fetch.
8. **No hidden credential use.** Cookies, browser profiles, and API keys require explicit opt-in and diagnostics.

## Ranked task roadmap

The tasks below are sorted by expected usefulness/impact for `pi-internet`, with security prerequisites ranked ahead of more visible features.

### P0 — Safety hardening release

#### 1. Central URL safety, redirect validation, and streaming caps

Impact: Very high
Effort: Medium
Borrow from: `@bitcraft-apps/pi-web-tools`

Implement a shared URL/network guard used by every fetch/search backend that dereferences user-controlled URLs.

Scope:

- Validate URL scheme and hostname.
- Block private, loopback, link-local, localhost, multicast, special-use addresses.
- Resolve DNS safely where needed.
- Validate every redirect hop manually.
- Enforce timeout and byte caps during streaming.
- Strip/surface userinfo safely.
- Apply the same guard before calling hosted/sidecar backends with a URL.

Acceptance criteria:

- Unit tests for blocked hosts, allowed public hosts, redirect-to-private, redirect-to-cross-host notice, oversized response, timeout.
- GitHub clone path and symlink/path containment checks are included or tracked as part of the same safety release.

Why first: browser/crawl/provider integrations are much safer after this exists.

#### 2. Universal truncation, cache save, and pagination UX

Impact: Very high
Effort: Medium
Borrow from: `@bitcraft-apps/pi-web-tools`

Add consistent truncation and continuation across fetch outputs.

Scope:

- `offset` parameter for large text output where feasible.
- Clear truncation footer with exact continuation instruction.
- Save full large outputs to cache/Downloads with path surfaced.
- Apply to PDF, GitHub tree/file, YouTube list/transcript, HTML extraction, and research artifacts.

Acceptance criteria:

- Fetching a large synthetic document returns first chunk plus continuation footer.
- Re-calling with `offset` resumes without overlap/gap.
- Full output path exists for large extractions.

### P1 — High-leverage low-risk feature additions

#### 3. Add SearXNG search provider

Impact: High
Effort: Low/Medium
Borrow from: `@juicesharp/rpiv-web-tools`, `@demigodmode/pi-web-agent`, `@0xkobold/pi-web`

SearXNG is the best self-hosted search provider to add next.

Scope:

- Config/env for `PI_INTERNET_SEARXNG_URL` and optional API key/header.
- Provider implementation for `/search?q=...&format=json`.
- Normalize results into current `SearchResult` shape.
- Diagnostics for JSON disabled, auth failure, bad base URL, empty result.
- Include in `/search-providers` status.

Default recommendation: available but not enabled by default unless configured.

#### 4. Add Markdown-first fetch and `llms.txt` discovery

Impact: High
Effort: Low/Medium
Borrow from: `@bitcraft-apps/pi-web-tools` plus current external docs ecosystem

Scope:

- Prefer `Accept: text/markdown,text/html;q=...` for general HTTP fetch.
- Detect same-origin `/llms.txt` and `/llms-full.txt` for docs-like sites.
- Surface available LLM docs links in fetch output.
- Optionally use `llms-full.txt` when explicitly requested or when target is docs root and bounded by size caps.

Acceptance criteria:

- Markdown response path bypasses unnecessary HTML extraction.
- `llms.txt` discovery is bounded, cached, and never blocks normal fetch if it fails.

#### 5. Finish GitHub support follow-ups

Impact: Medium/High
Effort: Medium
Borrow from: `@johnnywu/pi-webfetch`

Status: the original high-impact GitHub expansion is mostly complete. The current implementation handles issues, PRs, releases, Actions runs/log export, gists, commits, compares, and user/org profiles through `gh`/REST instead of brittle HTML. Follow-up work should focus on completeness and UX rather than first support.

Remaining scope:

- Add Discussions and discussion comments.
- Add useful list/index renderers for `/issues`, `/pulls`, `/actions`, `/commits`, `/tags`, `/branches`, `/labels`, `/milestones`, and richer release lists.
- Add API pagination or explicit truncation notices for large issue/PR comments, review comments, files, commits, and release assets.
- Add optional verbose diff/patch artifacts for PRs, commits, and compares.
- Make Actions log diagnostics explicit when `verbose: true` is requested but `gh` is unavailable or unauthenticated.
- Decide whether to specialize wiki/projects/packages/security/advisory pages or keep returning the current “not yet specialized” message.
- Use `includeLinks` consistently, or remove it from the GitHub API route if not meaningful.

Acceptance criteria:

- Large GitHub threads indicate exactly what was omitted and how to fetch more.
- Actions log output distinguishes “not requested”, “requires `gh`”, “no logs”, and “saved to path”.
- Unsupported GitHub paths remain intentional and actionable rather than silently falling through to brittle HTML.

### P2 — Extraction quality and specialized fetch UX

#### 6. Add pluggable extraction stages and benchmark Defuddle

Impact: High
Effort: Medium
Borrow from: `pi-webaio`, `@johnnywu/pi-webfetch`, `@pi-unipi/web-api`, `@curio-data/pi-intelli-search`

Scope:

- Introduce extractor interface: Readability, Defuddle, RSC, Jina.
- Add Defuddle as optional/local extraction stage if benchmarks justify it.
- Compare extraction quality on docs, blogs, code-heavy pages, tables, and paywall-free news pages.
- Keep Jina as hosted fallback with privacy provenance.

Acceptance criteria:

- Extraction chain is configurable/testable.
- Defuddle improves at least one important fixture category without regressing others.

#### 7. Improve YouTube support through `yt-dlp` configuration

Impact: Medium/High
Effort: Low/Medium
Borrow from: current design and `@johnnywu/pi-webfetch`

Scope:

- Configurable transcript languages.
- Optional cookies file / `cookies-from-browser` with explicit privacy warning.
- Better diagnostics for sign-in, bot detection, no subtitles, private/deleted videos.
- Richer metadata display: duration, upload date, channel, chapters, views, tags when available.
- Incremental playlist/channel cache refresh.

Acceptance criteria:

- Existing YouTube behavior remains clean by default.
- Cookie usage is never implicit.

#### 8. Add Stack Exchange support via StackPrinter/API

Impact: Medium/High
Effort: Low/Medium

Scope:

- Detect Stack Overflow/Stack Exchange question URLs.
- Prefer StackPrinter or Stack Exchange API over generic HTML.
- Return question, accepted answer, high-score answers, comments summary, tags, dates, and links.

Why: high frequency in coding-agent tasks and much cleaner than scraped HTML.

#### 9. Optional document/PDF converter adapters

Impact: Medium/High
Effort: Medium

Targets:

- `pdftotext` for lightweight PDF fallback.
- `pymupdf4llm` for PDF-to-Markdown.
- `markitdown` for DOCX/PPTX/XLSX/HTML/CSV and other documents.
- Later: Docling/Tika/Unstructured as heavier adapters.

Scope:

- Download to bounded temp file.
- Convert through configured adapter.
- Enforce timeout, byte caps, and cleanup.
- Make processing untrusted documents explicit and bounded.

### P3 — Research, provider, and diagnostics improvements

#### 10. Add research evidence cache and source-collation workflow

Impact: Medium/High
Effort: Medium/High
Borrow from: `@curio-data/pi-intelli-search`

Scope:

- Persistent cache under `.search/` or `~/.cache/pi-internet/research`.
- Store query, sources, fetched excerpts, timestamps, and final findings.
- Surface related previous searches.
- Add extract/collate steps inside scout process.
- Preserve source URLs and conflicts/inconsistencies.

Keep `web_research` hidden/explicit; do not alter `web_search` semantics.

#### 11. Provider registry and `/internet-doctor`

Impact: Medium/High
Effort: Medium
Borrow from: `@juicesharp/rpiv-web-tools`, `@demigodmode/pi-web-agent`, `@feniix/pi-exa`

Scope:

- Search/fetch/browser/document provider registry metadata.
- Doctor command showing provider availability, missing env vars/binaries, configured proxies, session-disabled state, and privacy/cost notes.
- Preflight validation for provider-specific options.

This becomes more valuable as optional integrations grow.

#### 12. Add presentation modes

Impact: Medium
Effort: Low/Medium
Borrow from: `@demigodmode/pi-web-agent`

Scope:

- `compact`, `preview`, `verbose` output modes.
- Apply first to GitHub, YouTube playlists/channels, PDFs, and research output.
- Keep current defaults token-efficient.

### P4 — Optional external integrations

#### 13. Browser rendering adapter behind explicit tool/config

Impact: Medium/High for JS-heavy pages
Effort: High
Borrow from: `@demigodmode/pi-web-agent`, `@0xkobold/pi-web`

Scope:

- Add separate `render_url` or hidden `fetch_rendered`; do not silently browser-render from `fetch_url`.
- Backends: local CDP/Playwright helper first; later Browserless, Cloudflare Browser Rendering, Browserbase.
- Outputs: rendered Markdown/text, screenshot path/attachment, PDF, links.
- Hard concurrency/time/page caps.

Prerequisite: P0 safety hardening.

#### 14. Crawl/map sidecar adapters

Impact: Medium
Effort: Medium/High

Targets:

- Crawl4AI local/self-hosted sidecar.
- Firecrawl scrape/crawl/map.
- Tavily extract/crawl/map.

Scope:

- Keep as explicit `web_map`/`web_crawl` or hidden research-only backends.
- Quota/cost warnings.
- Max pages/depth/time.
- Reuse URL safety gate.

#### 15. Optional advanced provider adapters

Impact: Medium
Effort: Medium

Targets:

- Exa: search, contents, answer, find-similar, deep search.
- Parallel: search/fetch with objective-oriented retrieval.
- Perplexity/Sonar: answer-style research.
- Jina Search: `s.jina.ai` fallback.

Design:

- Disabled unless configured.
- Provider-specific advanced tools should be explicit.
- Generic `web_search` can use them only as configured providers with normalized results.

#### 16. Curated privacy frontend support

Impact: Medium
Effort: Medium

Targets:

- YouTube: Invidious/Piped.
- Medium: Scribe/LibMedium, without paywall-bypass positioning.
- Fandom: BreezeWiki.
- Search: SearXNG first; maybe 4get/Whoogle later.

Rules:

- User-configured instances only.
- No bundled public instance lists or random rotation.
- Fallback to regular fetch when proxy fails, with clear warning.

## Recommended implementation sequence

1. **Safety hardening release**: URL guard, redirects, streaming caps, GitHub path containment.
2. **Fetch UX release**: truncation/pagination/full-output save, Markdown-first Accept, `llms.txt` discovery.
3. **Coding-source release**: Stack Exchange support plus GitHub follow-ups for Discussions/list pages/pagination/diff artifacts.
4. **Provider release**: SearXNG, provider registry metadata, `/internet-doctor`.
5. **Extraction quality release**: Defuddle benchmark/integration, document/PDF converter adapters.
6. **Research release**: evidence cache, focused extraction/collation, related cached searches.
7. **External-backend release**: browser rendering, Crawl4AI/Firecrawl/Tavily crawl/map, advanced providers.
8. **Curated frontend release**: Invidious/Piped, Scribe/LibMedium, BreezeWiki.

## Final recommendation

`pi-internet` should not try to become the largest web extension. Its strongest position is to be the most reliable Pi-native web layer:

- Safe network boundary.
- Clean provider router.
- Strong specialized URL handlers.
- Optional external adapters for heavyweight/browser/crawl/document work.
- Clear provenance, privacy, and cost disclosures.
- Token-efficient normalized output.

The highest-impact next work is therefore not adding more providers immediately; it is hardening the shared fetch boundary and output UX so every later provider, proxy, browser, and crawler integration inherits the same safe, predictable behavior.
