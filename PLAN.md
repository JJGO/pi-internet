# Current Maintenance Plan — pi-internet

Updated: 2026-04-11

This plan replaces the older implementation notes that referenced issues already fixed.

## Completed in this pass

- Search provider config now refreshes on each use instead of being captured at extension load.
- `web_research` toggle behavior is explicit and session-only.
- Scout subprocess startup errors now surface actionable messages.
- YouTube title extraction now respects cancellation.
- GitHub `gh` availability checks are cached per runtime.
- Config file parse/read failures warn once instead of failing silently.
- Config overlay merging is now recursive for nested `piInternet` objects (`piWebSurf` remains supported as a legacy alias).
- Packaging metadata was cleaned up (`LICENSE` added, stale `skills/` entry removed).
- Test runner script was added to `package.json`.
- Focused unit tests were added for search-router orchestration and config normalization/merge behavior.

## Next priorities

### 1. Optional UX improvements
- Decide whether `web_research` should eventually become persistent across session resume/fork.
- If yes, persist via `pi.appendEntry()` and restore in `session_start`.
- If no, keep the current documented session-only behavior.

### 2. Nice-to-have hardening
- Add retry/backoff for transient search/fetch failures.
- Add Jina Reader API key support if authenticated usage becomes important.
- Add snapshot tests for Reddit/Twitter/RSC parsing if scraper regressions become common.
