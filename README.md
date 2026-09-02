# pi-internet

Web search, content fetching, and research for [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Multi-provider search, specialized fetchers for GitHub/Reddit/Twitter/YouTube/PDF, and a scout subagent that keeps noise out of your context.

## Install

```bash
pi install git:github.com/JJGO/pi-internet
```

Or try without installing:

```bash
pi -e git:github.com/JJGO/pi-internet
```

## What You Get

### `web_search`

Search the web using multiple providers in parallel. Results are deduplicated by URL and the richer snippet is kept.

```
Search for "typescript monorepo best practices 2025"
```

- **Primary providers** run in parallel (default: Brave + Kagi)
- **Fallback providers** fill gaps when primaries fail or return too few unique results (default: Tavily)
- **Brave rate-limit / usage-limit responses** disable Brave for the rest of the current session
- Override per-call with `provider: "brave"` / `"kagi"` / `"tavily"` — explicit provider selection does not auto-fallback
- Default: 10 results (max 20) — each provider returns 10, merged and deduplicated
- Freshness filter: `day`, `week`, `month`, `year`
- Concise warnings are surfaced when a provider is disabled or a fallback had to fill results

### `fetch_url`

Fetch any URL and get clean, token-efficient markdown. Auto-detects content type:

| URL Type | Handler |
|----------|---------|
| **GitHub repos/files/trees** | Clones repo locally, returns tree + README or file content. Use `read`/`bash` on the local path. |
| **GitHub PRs/issues/releases/Actions/gists/commits** | Uses `gh`/GitHub REST API and returns structured Markdown instead of brittle GitHub HTML extraction. Actions logs use progressive disclosure: `verbose: true` saves logs to a temp file and reports the path. |
| **Reddit** | Uses a configurable Redlib-compatible proxy when configured. Structured posts + nested comments. Non-verbose output is capped; use `verbose: true` for all parsed comments and deeper replies. |
| **Twitter/X** | Uses a configurable Nitter-compatible proxy when configured. Profiles, threads, tweets with RT/quote detection. |
| **YouTube** | Videos return metadata, cleaned descriptions, chapters, and timestamped transcripts via yt-dlp. Vision-capable models can request a frame by adding `pi-internet-screenshot=HH:MM:SS` to a video URL. Playlists and channels preview 25 entries inline and write the full list to cache. |
| **PDF** | Extracts text via unpdf. Large extractions are also saved to `~/Downloads/`. |
| **HTML** | Readability → RSC parser → local Defuddle → Jina Reader fallback chain. |

- Links stripped by default (saves ~50 tokens/link). Set `includeLinks: true` to keep.
- CSS selector support: `selector: ".docs-content"` narrows extraction.
- `verbose: true` for Reddit: all parsed comments and full comment depth. For Twitter: untruncated tweets. For YouTube collections: no internal entry cap.
- YouTube playlists/channels write full lists to `~/.cache/pi-internet/youtube-lists/`. Default output previews the first 25 items inline.
- YouTube video fetches include screenshot instructions only when the active model advertises image input. To inspect a frame, fetch the same video URL with `&pi-internet-screenshot=HH:MM:SS`; frames are temporary JPEG files and are returned as image attachments.

### `web_research` (hidden by default)

Spawns a lightweight scout subagent that searches + fetches pages, then returns only relevant findings. All noise stays in the scout's disposable context. Reports over 50KB or 2000 lines are truncated in the main context and saved in full to a temporary file.

The `/toggle-research` switch is session-only by design.

```
/toggle-research    # Enable the tool
```

Auto-detected scout model based on your current provider:

| Your Provider | Scout Uses |
|--------------|------------|
| Anthropic | `claude-haiku-4-5` |
| OpenAI | `gpt-4.1-mini` |
| Google | `gemini-2.0-flash` |

Override per-call with `model: "..."`.

## Configuration

Settings live in Pi's settings files (`~/.pi/agent/settings.json` or `.pi/settings.json`):

```json
{
  "piInternet": {
    "searchProviders": ["brave", "kagi"],
    "fallbackProviders": ["tavily"],
    "reddit": {
      "commentDepth": 4
    },
    "twitter": {},
    "github": {
      "enabled": true,
      "maxRepoSizeMB": 350,
      "clonePath": "/absolute/path/to/github-repos",
      "refreshTtlMs": 300000
    },
    "youtube": {
      "enabled": true
    },
    "fetch": {
      "includeLinks": false,
      "timeoutMs": 30000,
      "socksProxy": "socks5h://127.0.0.1:25344"
    }
  }
}
```

`fetch.socksProxy` is optional and disabled by default. When set, pi-internet routes its outbound HTTP requests through that SOCKS proxy.

`github.clonePath` defaults to `~/.cache/pi-internet/github-repos` when omitted.

`github.refreshTtlMs` defaults to 300000 (5 minutes). Cached repos are refreshed with `git fetch` + hard reset when they are older than the TTL. If the cached clone has local edits, pi-internet keeps it untouched and creates a fresh sibling clone instead.

`piWebSurf` is still accepted as a legacy config key for backward compatibility, but `piInternet` is preferred.

### Environment variables

When Pi starts with `--offline` or `PI_OFFLINE=1`, pi-internet registers no tools or commands and emits a warning.

#### Search providers

| Provider | Env Var |
|----------|---------|
| Brave Search | `BRAVE_API_KEY` |
| Kagi | `KAGI_SESSION_TOKEN` |
| Tavily | `TAVILY_API_KEY` |

Kagi also checks `~/.pi/kagi-search.json` and `~/.kagi_session_token` as fallbacks.

#### Optional proxies

| Feature | Env Var | Value |
|---------|---------|-------|
| Package-wide SOCKS proxy for outbound HTTP | `PI_INTERNET_SOCKS_PROXY` | Full proxy URL, e.g. `socks5h://127.0.0.1:25344` |
| Reddit via Redlib-compatible proxy | `PI_INTERNET_REDLIB_PROXY` | Hostname only, e.g. `redlib.example.com` |
| Twitter/X via Nitter-compatible proxy | `PI_INTERNET_NITTER_PROXY` | Hostname only, e.g. `nitter.example.com` |

`PI_INTERNET_SOCKS_PROXY` overrides `piInternet.fetch.socksProxy` when both are set.

When `PI_INTERNET_REDLIB_PROXY` or `piInternet.reddit.proxyHost` is set, both normal Reddit URLs and URLs on that configured Redlib host are parsed with the Reddit handler.

If these env vars are unset, SOCKS proxying stays disabled and Reddit/X URLs fall through to regular HTTP fetching. Direct Reddit fetches that fail include a hint to configure `PI_INTERNET_REDLIB_PROXY`.

### External dependencies

| Binary | Required For |
|--------|-------------|
| `yt-dlp` | YouTube transcripts, video metadata, screenshots, and playlist/channel metadata |
| `ffmpeg` | YouTube screenshots |
| `git` or `gh` | GitHub repo cloning |
| `gh` | Recommended for GitHub PRs/issues/releases/Actions/gists, private repos, authenticated rate limits, and Actions log export |

## Commands

| Command | Description |
|---------|-------------|
| `/search-providers` | List configured providers, availability, and session-disabled status |
| `/kagi-login` | Set Kagi session token interactively |
| `/toggle-research` | Show/hide the `web_research` tool for the current session |

## How It Works

```
web_search(query)
  → Run primary providers in parallel (Brave + Kagi)
  → Merge: deduplicate by URL, keep richer snippet
  → If merged results are short → try fallback providers (Tavily) to fill the gap
  → If Brave returns a rate-limit or usage-limit response → disable Brave for the rest of the session

fetch_url(url)
  → Reddit?    Configured Redlib-compatible proxy → parse posts/comments → render markdown
  → Twitter?   Configured Nitter-compatible proxy → parse tweets/profile → render markdown
  → GitHub repo/file/tree?  Clone repo → tree + README + file content
  → GitHub PR/issue/release/Actions/gist/commit?  gh/API → structured Markdown
  → YouTube?   Video + pi-internet-screenshot? → yt-dlp stream URL → ffmpeg frame → image attachment
               Video → yt-dlp metadata + cleaned description + chapters + timestamped transcript
               Playlist/channel → yt-dlp flat JSON → first 25 inline + full list file
  → PDF?       unpdf extraction → inline markdown (+ save large outputs)
  → HTTP?      Readability → RSC parser → local Defuddle → Jina Reader fallback

web_research(task)
  → Spawn scout: pi --mode json --no-session -e <this-ext>
  → Scout searches + fetches + analyzes
  → Returns only relevant findings
```

## Token Efficiency

- Links stripped from extracted content by default
- Images always stripped
- Reddit comments capped in non-verbose mode with truncation notices; use `verbose: true` for all parsed comments and deeper replies
- Tweet content truncated to 500 chars in non-verbose mode
- All tool text is truncated to Pi's standard limits (50KB / 2000 lines)
- Full truncated fetch and research output is saved to a temporary file; search output asks for a narrower query
- Twitter/X proxy auto-disables on failure (falls through to HTTP for session); configured Reddit proxy failures are surfaced directly

## License

MIT

## Provenance

This project is a pragmatic blend of original code plus ideas and implementation patterns adapted from a few prior Pi- and web-fetch-related projects.

- **Search** builds on patterns from `pi-websearch`, `pi-web-access`, and `pi-kagi-search` for provider routing, result normalization, and Kagi session-based scraping.
- **Fetchers** reuse or adapt ideas from `pi-web-access` and `pi-fetch` for GitHub extraction, Readability/RSC/Defuddle/Jina fallback behavior, and PDF extraction.
- **Research/scout mode** borrows the disposable subagent pattern from `pi-surf`.
- **Utilities and glue code** were simplified, consolidated, or rewritten to fit this package, especially around config loading, markdown rendering, routing, and packaging.

Where code was adapted, comments in the relevant source files point back to the upstream project or module.
