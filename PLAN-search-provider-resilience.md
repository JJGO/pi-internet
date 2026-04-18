# Implementation Plan — Search Provider Resilience

Updated: 2026-04-18
Status: planning only

## Goal

Improve `web_search` behavior when configured primaries degrade, specifically:

1. If a provider returns **HTTP 429**, disable that provider for the **rest of the current session**.
2. If primaries return **fewer merged results than requested**, query fallback providers to **fill the gap**.
3. Surface a **small, informative warning** to the user when a provider fails and especially when it becomes session-disabled, without making the tool noisy.

This plan assumes the desired behavior is:
- **Primary-first** remains the default.
- **Fallbacks are augmentation**, not replacement, when primaries succeed but under-deliver.
- **Explicit `provider` override** should still mean “use only that provider”, but 429 should still disable that provider for the session.

## Current behavior

Today the router does this:

1. Run all available primaries in parallel.
2. If at least one primary succeeds, merge results and return immediately.
3. Only if **all** primaries fail, try fallback providers.

Consequences:
- Brave quota exhaustion keeps producing repeated request-time failures.
- A single successful primary prevents Tavily fallback entirely.
- The UI only shows a generic `N provider error(s)` count.

## Proposed design

### 1. Add structured provider failures

Introduce a search-specific error type so providers can communicate machine-readable failure metadata to the router.

Recommended shape:

```ts
class SearchProviderError extends Error {
  provider: string;
  statusCode?: number;
  code?: "rate_limited" | "auth" | "http" | "network" | "unknown";
  disableForSession: boolean;
  userMessage?: string;
}
```

Why:
- String-matching provider errors in the router will get brittle fast.
- We need a clean way to distinguish:
  - retryable ordinary failures
  - configuration/auth failures
  - session-disabling failures like 429

### 2. Add session-scoped disabled-provider state

Add a module-level search runtime state, similar to the fetch proxy-disable pattern.

Recommended API:

```ts
resetSearchProviderState(): void
isSearchProviderDisabled(name: string): boolean
disableSearchProvider(name: string, reason: string): void
getDisabledSearchProviders(): { name: string; reason: string }[]
```

Design notes:
- This state should live outside `createSearchRouter()` because the router is recreated on each tool call.
- `session_start` and `session_shutdown` should reset it.
- Disabling should happen only on intentionally classified failures, starting with **429**.

### 3. Teach providers to classify failures

#### Brave

Update `src/search/providers/brave.ts` so:
- `429` throws `SearchProviderError` with:
  - `code: "rate_limited"`
  - `statusCode: 429`
  - `disableForSession: true`
  - concise `userMessage`, e.g. `Brave rate limit reached; disabled for this session`
- other HTTP failures throw structured errors without `disableForSession`

#### Kagi / Tavily

They do not need session-disable behavior initially, but they should ideally throw structured errors too so the router can render cleaner diagnostics.

Reasonable initial mapping:
- auth/token issues → `code: "auth"`, `disableForSession: false`
- ordinary HTTP errors → `code: "http"`, `disableForSession: false`
- network failures → `code: "network"`, `disableForSession: false`

### 4. Change router orchestration

Update `src/search/router.ts` with this algorithm:

#### A. Resolve active primaries
- Start from configured primary names.
- Drop providers that are not configured.
- Drop providers disabled for this session.

#### B. Run remaining primaries in parallel
- Keep current parallel behavior.
- Capture both:
  - successful result sets
  - structured failure metadata / warnings

#### C. Merge primary results
- Merge and dedupe successful primary results.
- If merged result count is already `>= numResults`, return immediately.

#### D. Fill with fallbacks when needed
- If merged count is `< numResults`, try configured fallback providers sequentially.
- Skip any fallback already disabled for the session.
- After each fallback success, merge into the current pool and stop once `numResults` is reached.

Important detail:
- Each fallback should likely still fetch up to the full requested `numResults`, not just the numeric remainder, because cross-provider dedupe may eliminate many entries.

#### E. Session-disable on 429
- When catching a `SearchProviderError` with `disableForSession: true`, record the disable state immediately.
- Subsequent searches in the same session must skip that provider entirely.

### 5. Add lightweight user-facing warnings

The current UI only shows `N provider error(s)`. That is too opaque for this case.

Recommended result details shape:

```ts
{
  provider: string;
  resultCount: number;
  query: string;
  errors?: string[];
  warnings?: string[];
  items: SearchResult[];
}
```

Recommended warning behavior:
- On the search that triggers disablement, include a short warning such as:
  - `Brave hit rate limits and was disabled for this session.`
- On searches where fallback had to be used to fill missing results, optionally include:
  - `Used Tavily fallback because primary providers returned too few results.`

UX rule:
- Keep warnings short and summary-like in collapsed view.
- Do not dump raw HTTP responses in the summary line.
- Full error details can remain available in expanded view.

### 6. Update renderer text

Update `src/index.ts` rendering for `web_search` to distinguish:
- hard failure
- provider errors
- user-facing warnings

Recommended collapsed output shape:
- `8 results via kagi+tavily (fallback) (1 warning)`
- and, only if present, one short muted line such as:
  - `Brave rate-limited; disabled for this session.`

This should remain intentionally subtle.

### 7. Keep `/search-providers` truthful

If practical, update provider listing so it can show:
- configured and available
- disabled for this session

Example:
- `brave — primary — disabled for session (rate limited)`
- `kagi — primary — available`
- `tavily — fallback — available`

This is not strictly required for the core behavior, but it will make debugging much easier.

## File-level implementation outline

### `src/search/types.ts`
Option A:
- add router result metadata types for warnings

Option B:
- keep `types.ts` focused on provider/result types and create `src/search/errors.ts` plus `src/search/state.ts`

Recommended:
- new `src/search/errors.ts`
- new `src/search/state.ts`

That keeps search orchestration concerns out of generic result types.

### `src/search/errors.ts` (new)
Add:
- `SearchProviderError`
- helper constructors / type guards

### `src/search/state.ts` (new)
Add session-scoped state helpers:
- reset
- disable
- query status
- maybe retrieve displayable notices

### `src/search/providers/brave.ts`
- wrap 429 in `SearchProviderError`
- convert other HTTP failures to structured provider errors

### `src/search/providers/kagi.ts`
- optionally convert existing thrown strings/errors into `SearchProviderError`

### `src/search/providers/tavily.ts`
- optionally convert existing thrown strings/errors into `SearchProviderError`

### `src/search/router.ts`
- skip session-disabled providers
- allow fallback to fill shortages, not only total failure
- accumulate warnings separately from errors
- return richer provider label / metadata

### `src/index.ts`
- reset search provider state on `session_start` and `session_shutdown`
- pass warnings through tool result details
- render concise warnings in collapsed view
- optionally enhance `/search-providers`

### `README.md`
Update docs so behavior matches reality:
- fallback is used when primaries fail **or under-deliver**
- 429 disables a provider for the rest of the session
- warnings are surfaced tersely in search results

### `test/search-router.test.ts`
Add coverage for:
1. 429 disables a provider for the session
2. disabled provider is skipped on subsequent searches
3. fallback fills when merged primary results are below requested count
4. fallback stops once enough merged results exist
5. provider override does not invoke fallback
6. session reset clears disabled providers

Potentially add small tests for state helpers if they are split into `search/state.ts`.

## Detailed execution order

1. **Introduce structured search error type**
   - no behavior change yet
2. **Add session-scoped disabled-provider state**
   - plus reset hooks in `src/index.ts`
3. **Update Brave to emit structured 429 errors**
4. **Refactor router to understand structured failures**
5. **Implement fallback-fill logic**
6. **Add user-facing warnings to result details and renderer**
7. **Update `/search-providers` output if desired**
8. **Update README + tests**

This order keeps each step testable and avoids mixing orchestration/UI concerns too early.

## Test plan

### Unit tests

#### Router behavior
- primary success, no fallback when enough merged results exist
- primary partial success, fallback fills remaining pool
- one primary throws 429, other primary succeeds, fallback may still fill if needed
- same rate-limited provider is skipped on the next call
- all primaries unavailable/disabled, fallback still works
- all providers fail → final aggregated error remains intelligible

#### State behavior
- disable provider
- reset provider state
- disabled provider reason is preserved for display

#### Optional renderer coverage
If test setup is lightweight enough, verify the collapsed text includes warnings without overexposing raw errors.

### Manual verification

1. Configure `searchProviders = ["brave", "kagi"]`, `fallbackProviders = ["tavily"]`
2. Force Brave to return 429
3. Run search
   - expect Kagi results
   - expect subtle warning that Brave was disabled for the session
4. Run another search
   - expect Brave not to be retried
5. Use a query where Kagi returns fewer than requested unique merged results
   - expect Tavily to be queried and merged in
6. Start a new session
   - expect Brave to be retried again

## Risks / edge cases

### 1. Fallback over-querying
Asking Tavily for the full requested count can fetch more than strictly needed, but it is the simplest way to avoid underfilling after dedupe. This is likely worth the tradeoff.

### 2. Empty success from a primary
A provider may technically succeed but return zero results. For the new behavior that should count as success, but fallback should still be allowed to fill.

### 3. Explicit provider override
Recommended behavior:
- if user explicitly requests `provider: "brave"`, do **not** auto-fallback to Kagi/Tavily
- but if Brave returns 429, still disable it for the session and surface that warning

### 4. Warning repetition
Best default:
- show the disable warning on the search that caused the disablement
- do not repeat a prominent warning on every later search
- expose ongoing disabled state via `/search-providers`

## Open questions to confirm before coding

1. **Fallback fill threshold**
   - Should fallback run whenever merged results are `< numResults`?
   - This is my recommendation.

2. **Explicit provider override**
   - Should explicit `provider` still suppress fallback entirely?
   - I recommend yes.

3. **Subsequent-search warning behavior**
   - Should later searches mention skipped disabled providers, or should that only appear in `/search-providers`?
   - I recommend: only mention disablement on the triggering search, then keep later searches quiet.

4. **Disable scope**
   - Only `429`, or also some auth/rate-limit variants from other providers?
   - I recommend starting with `429` only and expanding once real cases appear.

## Acceptance criteria

- A Brave 429 disables Brave for the rest of the session.
- Later searches in the same session do not retry Brave.
- Fallback providers can contribute results even when at least one primary succeeded, if merged results are still below the requested count.
- Search UI includes a concise warning when disablement happens.
- README and tests reflect the new semantics.
