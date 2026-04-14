# pi-internet

Web search, content fetching, and research for [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Multi-provider search, specialized fetchers for GitHub/Reddit/Twitter/YouTube/PDF, and a scout subagent that keeps noise out of your context.

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
- **Fallback providers** tried if all primaries fail (default: Tavily)
- Override per-call with `provider: "brave"` / `"kagi"` / `"tavily"`
- Default: 10 results (max 20) — each provider returns 10, merged and deduplicated
- Freshness filter: `day`, `week`, `month`, `year`

### `fetch_url`

Fetch any URL and get clean, token-efficient markdown. Auto-detects content type:

| URL Type | Handler |
|----------|---------|
| **GitHub** | Clones repo locally, returns tree + README. Use `read`/`bash` on the local path. |
| **Reddit** | Uses a configurable Redlib-compatible proxy when configured. Structured posts + nested comments (depth 4). |
| **Twitter/X** | Uses a configurable Nitter-compatible proxy when configured. Profiles, threads, tweets with RT/quote detection. |
| **YouTube** | Extracts transcript via yt-dlp. Timestamped, grouped into paragraphs. |
| **PDF** | Extracts text via unpdf. Large extractions are also saved to `~/Downloads/`. |
| **HTML** | Readability → RSC parser → Jina Reader fallback chain. |

- Links stripped by default (saves ~50 tokens/link). Set `includeLinks: true` to keep.
- CSS selector support: `selector: ".docs-content"` narrows extraction.
- `verbose: true` for Reddit: full comment depth. For Twitter: untruncated tweets.

### `web_research` (hidden by default)

Spawns a lightweight scout subagent that searches + fetches pages, then returns only relevant findings. All noise stays in the scout's disposable context.

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
      "clonePath": "/absolute/path/to/github-repos"
    },
    "youtube": {
      "enabled": true
    },
    "fetch": {
      "includeLinks": false,
      "timeoutMs": 30000
    }
  }
}
```

`github.clonePath` defaults to `~/.cache/pi-internet/github-repos` when omitted.

`piWebSurf` is still accepted as a legacy config key for backward compatibility, but `piInternet` is preferred.

### Environment variables

#### Search providers

| Provider | Env Var |
|----------|---------|
| Brave Search | `BRAVE_API_KEY` |
| Kagi | `KAGI_SESSION_TOKEN` |
| Tavily | `TAVILY_API_KEY` |

Kagi also checks `~/.pi/kagi-search.json` and `~/.kagi_session_token` as fallbacks.

#### Optional social proxies

| Feature | Env Var | Value |
|---------|---------|-------|
| Reddit via Redlib-compatible proxy | `PI_INTERNET_REDLIB_PROXY` | Hostname only, e.g. `redlib.example.com` |
| Twitter/X via Nitter-compatible proxy | `PI_INTERNET_NITTER_PROXY` | Hostname only, e.g. `nitter.example.com` |

If these env vars are unset, Reddit/X URLs fall through to regular HTTP fetching.

### External dependencies

| Binary | Required For |
|--------|-------------|
| `yt-dlp` | YouTube transcripts |
| `git` or `gh` | GitHub cloning |

## Commands

| Command | Description |
|---------|-------------|
| `/search-providers` | List configured providers and availability |
| `/kagi-login` | Set Kagi session token interactively |
| `/toggle-research` | Show/hide the `web_research` tool for the current session |

## How It Works

```
web_search(query)
  → Run primary providers in parallel (Brave + Kagi)
  → Merge: deduplicate by URL, keep richer snippet
  → If all fail → try fallback providers (Tavily)

fetch_url(url)
  → Reddit?    Configured Redlib-compatible proxy → parse posts/comments → render markdown
  → Twitter?   Configured Nitter-compatible proxy → parse tweets/profile → render markdown
  → GitHub?    Clone repo → tree + README + file content
  → YouTube?   yt-dlp subtitles → parse VTT → timestamped transcript
  → PDF?       unpdf extraction → inline markdown (+ save large outputs)
  → HTTP?      Readability → RSC parser → Jina Reader fallback

web_research(task)
  → Spawn scout: pi --mode json --no-session -e <this-ext>
  → Scout searches + fetches + analyzes
  → Returns only relevant findings
```

## Token Efficiency

- Links stripped from extracted content by default
- Images always stripped
- Reddit comments capped at depth 4 with truncation notices
- Tweet content truncated to 500 chars in non-verbose mode
- Output truncated to Pi's standard limits (50KB / 2000 lines)
- Social proxy auto-disables on failure (falls through to HTTP for session)

## License

MIT

## Provenance

This project is a pragmatic blend of original code plus ideas and implementation patterns adapted from a few prior Pi- and web-fetch-related projects.

- **Search** builds on patterns from `pi-websearch`, `pi-web-access`, and `pi-kagi-search` for provider routing, result normalization, and Kagi session-based scraping.
- **Fetchers** reuse or adapt ideas from `pi-web-access`, `pi-fetch`,  for GitHub extraction, Readability/RSC/Jina fallback behavior, PDF extraction.
- **Research/scout mode** borrows the disposable subagent pattern from `pi-surf`.
- **Utilities and glue code** were simplified, consolidated, or rewritten to fit this package, especially around config loading, markdown rendering, routing, and packaging.

Where code was adapted, comments in the relevant source files point back to the upstream project or module.
