# Defuddle benchmark for `pi-internet`

Date: 2026-08-27

## Decision

**Extend Readability with Defuddle: yes, conditionally.**

**Replace Readability with Defuddle alone: no.**

**Add Defuddle as a guarded fallback: yes.** Pin 0.19.3, keep it after Readability and RSC, and pass its cleaned HTML through the existing Markdown converter. This order avoids the known Wikipedia fraction corruption when Readability already returns useful content.

Defuddle was materially better on this corpus. Its native Markdown averaged **3.326/4** across completeness, cleanliness, and structure, compared with **2.763/4** for the current Readability pipeline. It reduced severe extraction failures from **5 pages to 2** and recovered pages that Readability silently truncated or returned empty.

Defuddle also had a catastrophic false-success on RFC 9110: it returned only section 6.4 while producing enough text to look valid. It silently changed `4/3` to `43` in a Wikipedia caption. Those failures make a Defuddle-only replacement unsafe.

The safest first integration is a local fallback chain:

1. Run Readability on the already-fetched HTML.
2. If Readability is absent or shorter than the existing acceptance threshold, try the existing RSC extractor and then Defuddle with `useAsync: false`.
3. Pass Defuddle's cleaned HTML through `pi-internet`'s existing Markdown converter. This preserves current link/image policy.
4. Keep Jina as the final rendered/blocked-page fallback.

This is also the design adopted by the current `pi-web-access` source: Readability → RSC → local Defuddle → hosted fallbacks. It avoids Defuddle's RFC and Wikipedia failures because Readability succeeds on those pages. It recovers empty and short Readability failures without changing the successful path.

A later experiment can run both local extractors and prefer Defuddle unless `defuddle.length < 2/3 * readability.length`. That policy scored better in this corpus, but 45 pages are not enough evidence to make Defuddle the default selector. The existing 500-character threshold also misses partial-but-long Readability failures, including Git rebase and the Ars article, so fallback-only integration is deliberately the safe first step rather than the final quality ceiling.

## Scope

The benchmark started with 50 predetermined URLs. Forty-five returned usable HTML and all 45 were retained. Five were excluded only because fetching failed before extraction:

- W3C WebAuthn: HTTP 403
- Two Stack Overflow pages: HTTP 403
- npm Defuddle package page: HTTP 403
- Meta Discourse Markdown reference: HTTP 404

The scored corpus contained:

| Category | Pages |
|---|---:|
| Technical documentation | 14 |
| Engineering and design articles | 10 |
| News articles | 8 |
| Structured/reference pages | 7 |
| Community pages | 3 |
| Product/package pages | 3 |
| **Total** | **45** |

This corpus represents the generic HTML path. It deliberately did not benchmark GitHub, Reddit, X, YouTube, or PDF behavior already owned by specialized `pi-internet` handlers.

## Pi ecosystem cross-check

Research on 2026-08-27 covered the installed package inventory, pi.dev extension catalog searches for web/fetch/browser/readability packages, npm metadata searches, current GitHub source, Answer Overflow, and a recent r/PiCodingAgent discussion. No package was installed or executed.

The comparison below is about generic HTML extraction policy, not each extension's full search or media feature set.

| Extension | Verified source pipeline | Quality gate and fallback | Maintenance and trust surface | Installation fit | Confidence |
|---|---|---|---|---|---|
| `pi-internet` (incumbent) | Readability → RSC → Jina; specialized routes own GitHub, Reddit, X, YouTube, and PDFs | Accepts Readability at 500 characters; otherwise tries RSC and Jina | Small dependency set and existing local tests; Jina receives a URL only after local extraction fails | Already installed from rolling GitHub source | High |
| [`pi-web-access`](https://github.com/nicobailon/pi-web-access) | **Readability → RSC → Defuddle 0.19.3 native Markdown with `useAsync: false` → opt-in hosted extractors** | The same 500-character gate controls both RSC and Defuddle fallback | Very active and extensively tested, including a no-hidden-network Defuddle test; much larger network, credential, filesystem, subprocess, and dependency surface than this project needs | Root package is directly Pi-installable from GitHub | High |
| [`pi-smart-fetch`](https://github.com/Thinkscape/agent-smart-fetch) | Defuddle-first native Markdown; DOM body fallback; declared `rel=alternate` fetch for thin output | Falls back to the DOM only when Defuddle is empty; tries a qualified alternate when output is under 30 words | Good unit/integration coverage and TLS impersonation, but uses Defuddle async extractors, writes downloads, requires Node 24.18+, and depends on `wreq-js` | GitHub root is a Bun monorepo, not a direct single-extension Pi install; npm or an installable fork would be required | High |
| [`henyo-pi-web`](https://github.com/henyojess/henyo-pi-web) | Defuddle-first native Markdown → Jina → raw HTML | Rejects Defuddle below 100 characters or with a missing/bad title | Tests cover the gate, but inspected GitHub HEAD pins Defuddle 0.19.1, leaves async extraction enabled, and passes caller headers to the Jina fallback; published versions disagree across pi.dev, the configured registry, and GitHub | Root is directly Pi-installable from GitHub | Medium |
| [`pi-simple-web-tools`](https://github.com/jillesme/pi-simple-web-tools) | HTTP Markdown negotiation → Readability → optional Playwright → rendered body | 500-character Readability gate; full-body fallback only after browser rendering | Small and auditable with SSRF checks, but only one July 2026 commit/release and no test script | Root is directly Pi-installable from GitHub; Playwright needs a browser install | Medium |

Inspected revisions: `pi-web-access` `f46e809`; `pi-smart-fetch` `b011161`; `henyo-pi-web` `7045825`; `pi-simple-web-tools` `46c8edf`. Rolling GitHub sources can change after this date.

### What other implementations establish

- **Verified source:** The strongest independent precedent is `pi-web-access`, which added Defuddle native Markdown as a local fallback rather than replacing Readability. It pins 0.19.3, sets `useAsync: false`, and tests that extraction performs no hidden fetch. This directly supports the fallback order above; `pi-internet` should still use D-C initially to preserve its output controls.
- **Verified source:** Defuddle-first extensions use only absolute “non-empty/thin” checks. `pi-smart-fetch` accepts any non-empty Defuddle result; `henyo-pi-web` uses 100 characters plus title validity. Neither compares Defuddle with an independent local extraction, so neither would detect the RFC 9110 false-success found here.
- **Verified source:** Content negotiation and alternate-document discovery can avoid extraction entirely. `pi-simple-web-tools` asks for `text/markdown`; `pi-smart-fetch` follows declared Markdown alternates for thin pages. These are useful separate improvements, but they do not settle the Readability-versus-Defuddle selector.
- **Community-reported:** A February 2026 [scurl discussion](https://www.answeroverflow.com/m/1468588101201825824) documents a semantically malformed pricing table that an article extractor mistook for a footer. The author changed article extraction from the default to an explicit mode. This is another concrete warning against trusting a single main-content extractor.
- **Community-reported:** In a May 2026 [r/PiCodingAgent discussion](https://www.reddit.com/r/PiCodingAgent/comments/1t2yeax/what_you_guys_have_been_using_for_web_searchfetch/), users described layered setups: `pi-smart-fetch`, site-specific extraction, and Playwright/Firecrawl only after direct reading. One user specifically kept different extraction endpoints for code sites and generic articles.
- **Community-reported:** Answer Overflow contains positive Defuddle comments, but no comparative benchmark or documented protection against silent truncation. Those comments support adoption interest, not replacement safety.

### Process-fit tiers

These tiers rank extraction design fit for this repository. They are not a recommendation to replace `pi-internet` with another package.

- **S — Keep and extend `pi-internet`:** Add local-only Defuddle after Readability/RSC. It preserves specialized handlers and the current output contract while matching the safest verified ecosystem design.
- **A — `pi-web-access` design precedent:** Its exact fallback order and no-network configuration are the best external model, but installing the whole extension would duplicate `pi-internet` and add a much larger trust surface.
- **B — `pi-smart-fetch`:** Strong Defuddle-first implementation and alternate-link handling, but its absolute gate cannot detect plausible truncation and its runtime/install requirements do not fit this project.
- **B — `pi-simple-web-tools`:** Good evidence for Markdown negotiation and browser escalation, but it offers no Defuddle comparison and has limited maintenance/test evidence.
- **C — `henyo-pi-web`:** Its Defuddle-first/Jina policy is relevant, but version conflicts, old Defuddle, async extractor networking, raw-HTML fallback, and header forwarding make it a poor design source for this integration.

Unverified: [`@0xkobold/pi-web`](https://pi.dev/packages/@0xkobold/pi-web) advertises a fast → Readability → Playwright cascade, but its declared GitHub repository was unavailable. The source and trust surface could not be verified, so it is not ranked.

## Versions and configuration

| Component | Version |
|---|---|
| Mozilla Readability | 0.5.0 |
| LinkeDOM supplied to both extractors | 0.16.11 |
| `pi-internet` Turndown | 7.2.4 |
| Defuddle | 0.19.3, built from the exact upstream release tag |
| Node.js | 24.14.1; project support remains Node 22+ |

All extractors received the same saved HTML and final URL. Fetching used `pi-internet`'s browser-like headers and configured SOCKS transport. Extraction was offline.

Defuddle options were:

```ts
{
  useAsync: false,
  includeReplies: "extractors",
  removeImages: true,
  separateMarkdown: true,
  fetch: noNetworkFetch,
}
```

The injected fetch function counted and rejected every call. Defuddle made **zero network calls** across 45 pages.

Three variants were compared:

- **R:** current Readability selection followed by `pi-internet`'s `htmlToMarkdown({ includeLinks: false })`.
- **D-C:** Defuddle content selection and HTML standardization followed by the same `pi-internet` Markdown converter. This is the compatibility option.
- **D-N:** Defuddle's native Markdown conversion. This exposes its table, footnote, math, callout, and code rules, but does not preserve the current link-stripping contract.

The blind review used outputs from npm Defuddle 0.19.2 because the configured registry did not expose 0.19.3 when the run began. The exact 0.19.3 tag was then built and rerun over all 45 saved pages. Five outputs had formatting-only differences, mainly footnote spacing and removal of two Stripe images. The RFC truncation, Wikipedia corruption, page selections, and all decision-changing findings remained. Mechanical metrics below come from 0.19.3.

## Evaluation method

Seven independent fresh-context reviewers inspected randomized A/B/C output files without access to the variant mapping. Every reviewer compared output with the saved source HTML and URL.

Each output received three scores from 0 to 4:

- **Completeness:** retention of important main content.
- **Cleanliness:** exclusion of navigation, cookie, subscription, related-content, and UI noise.
- **Structure:** preservation of headings, lists, code, tables, math, captions, and discussion structure where applicable.

The report also measured:

- extraction success;
- local parsing latency;
- four-word-shingle overlap against the source `article`, `main`, `[role=main]`, or body region;
- output words, code fences, tables, links, and images;
- pages with severe extraction failure.

Source-region overlap is only supporting evidence. A DOM `main` region can itself contain noise or omit relevant material. The blind source review is the primary quality result.

## Aggregate results

### Blind quality scores

| Variant | Completeness | Cleanliness | Structure | Overall average | Severe failures |
|---|---:|---:|---:|---:|---:|
| R | 2.644 | 3.489 | 2.156 | **2.763** | 5 |
| D-C | 3.089 | **3.622** | 2.956 | **3.222** | 2 |
| D-N | **3.356** | 3.511 | **3.111** | **3.326** | 2 |

Compared with the current pipeline:

- D-C improved the overall score by **16.6%**.
- D-N improved the overall score by **20.4%**.
- D-C was the cleanest output.
- D-N was the most complete and best structured output.

A page was counted as severe when completeness was 0 or 1, or the combined score was at most 4/12.

### Category scores

Scores are averages over completeness, cleanliness, and structure.

| Category | R | D-C | D-N |
|---|---:|---:|---:|
| Documentation | 2.79 | **3.62** | 3.52 |
| Articles | 3.07 | 3.20 | **3.37** |
| News | 2.92 | 3.08 | **3.13** |
| Structured/reference | 2.62 | 2.67 | **3.05** |
| Community | 1.67 | 3.00 | **3.33** |
| Product/package | 2.67 | 3.33 | **3.44** |

Defuddle's largest practical gains were technical documentation, community pages, and product/package pages. Ordinary articles were closer.

### Mechanical metrics

| Metric | R | D-C | D-N |
|---|---:|---:|---:|
| Non-empty extraction | 43/45 | **44/45** | **44/45** |
| Median local parse time | **43 ms** | 145 ms | 141 ms |
| p95 local parse time | **152 ms** | 603 ms | 597 ms |
| Mean source-region precision | **0.912** | 0.909 | 0.904 |
| Mean source-region recall | 0.763 | 0.794 | **0.795** |
| Code fences | 103 | 475 | **480** |
| Markdown table rows | 0 | 0 | **115** |
| Markdown links | 0 | 1 | **2,026** |
| Markdown images | 0 | 0 | 8 |

Defuddle was about 3.3 times slower locally, but the absolute median remained about 145 ms. Running Readability and Defuddle sequentially had a measured median of **177 ms** and p95 of **732 ms** over saved HTML. Network fetch time is separate.

The large increase in code fences was generally useful: Defuddle recovered executable examples that the current conversion flattened. The native Markdown table support was also useful on SQLite, Cloudflare, Tailwind, Wikipedia, ar5iv, PyPI, and Homebrew pages.

The native Markdown link count is a contract mismatch, not a quality win by itself. `fetch_url` currently strips links unless requested.

## Important wins

### Git rebase manual

Readability started in the middle of the options section and omitted the name, synopsis, description, initial examples, and later sections. Both Defuddle variants retained the substantive manual and diagrams.

- R: 6/12
- D-C: 12/12
- D-N: 12/12

The existing 500-character acceptance threshold would not detect this Readability failure because the partial result still contained about 1,500 scored words.

### Ars Technica news article

Readability returned only the final “Stay in school, kids” section. Defuddle retained the introduction, employment data, intermediate analysis, and final section.

- R: 7/12, completeness 1/4
- D-C: 8/12
- D-N: 8/12

Again, the Readability result exceeded the current acceptance threshold and would suppress later fallbacks.

### Python PEP 703 discussion

Readability returned nothing. Defuddle retained the 20 posts present in the captured HTML. It did flatten authorship and reply structure, but the content remained usable.

- R: 0/12
- D-C: 7/12
- D-N: 8/12

### Technical documentation

Defuddle fixed or reduced major omissions and formatting damage on Effective Go, React state management, Git rebase, npm package metadata, Docker multi-stage builds, PostgreSQL, and SQLite. D-C scored best for the documentation category because it combined Defuddle's content boundary and code normalization with the project's cleaner link policy.

### Structured Markdown

D-N preserved tables and equations on ar5iv, Wikipedia HTTP, PyPI, Homebrew, Tailwind, and Cloudflare pages. The current Turndown configuration flattened these structures.

## Important failures

### RFC 9110 catastrophic truncation

Defuddle returned only sections 6.4, 6.4.1, and 6.4.2: about 380 scored words from a document where Readability returned about 34,700. The output was clean and long enough to appear successful.

- R: 10/12
- D-C: 7/12, completeness 1/4
- D-N: 7/12, completeness 1/4

This is the clearest reason not to replace Readability outright. Comparing local output lengths caught it: Defuddle was only about 1.3% of the Readability output.

### Wikipedia mathematical corruption

Defuddle changed the sphere-volume fraction in the lead caption from `4/3` to `43`. Its native output preserved the principal equation and more mathematical structure than Readability, but silent numeric corruption is a correctness blocker.

This reproduces upstream [issue #366](https://github.com/kepano/defuddle/issues/366).

### Client-rendered pages remain unresolved

The captured crates.io page contained only its JavaScript bootstrap shell. All three variants returned empty output. Defuddle is not a browser renderer and does not replace the RSC or Jina paths.

### Remaining shared extraction problems

All variants had important defects on some pages:

- TypeScript code blocks were malformed in different ways.
- The asyncio page lost examples and index entries.
- All variants omitted article headlines on several news sites.
- Discussion reply depth and authorship were flattened.
- Stripe pricing lost important product-to-price relationships.
- All variants returned only partial content from web.dev Baseline.

Defuddle is better on average, not reliably correct on every page.

## Guarded selection experiment

A simple corpus-derived policy was evaluated:

```text
prefer Defuddle
unless defuddle.length < 2/3 * readability.length
```

Results:

| Policy | Quality average | Severe failures | Readability overrides |
|---|---:|---:|---|
| D-C only | 3.222 | 2 | none |
| Guarded D-C | **3.244** | **1** | RFC 9110 |
| D-N only | 3.326 | 2 | none |
| Guarded D-N | **3.348** | **1** | RFC 9110 |

The remaining severe failure was the unrendered crates.io shell, where neither extractor had content to process.

This guard is intentionally one-sided. Defuddle was shorter but better on the Rust ownership landing page, so “always choose the longer result” is not justified. The ratio needs validation on a larger failure corpus before it becomes production policy.

## Dependency and operational cost

A locally packed 0.19.3 artifact was installed into an isolated runtime project.

| Item | Result |
|---|---|
| Package tarball | 633 KB |
| Installed `node_modules` | 22 MB |
| Runtime dependency count reported by npm | 27 total: 3 production, 25 optional |
| npm audit | 0 reported vulnerabilities |
| Install scripts | None observed for Defuddle |

During the benchmark, npm installed Defuddle's optional packages by default, including LinkeDOM, Turndown, Temml, and `mathml-to-latex`. That installation resolved `@xmldom/xmldom@0.9.11`, which npm warned was deprecated because it had “critical issues,” although npm audit reported no advisory. The final 0.19.3 integration resolves `@xmldom/xmldom@0.9.12` and produces no Defuddle-related npm audit finding.

The project currently uses LinkeDOM 0.16.11 while Defuddle requests `^0.18.12`, so a normal install can retain two LinkeDOM versions. Defuddle's optional math dependencies are installed even if `pi-internet` uses only cleaned HTML through its existing Markdown converter.

The configured npm registry reported Defuddle 0.19.2 as latest during the benchmark, while GitHub provided release 0.19.3. Version 0.19.3 contains security fixes for unsafe schema.org fallback HTML and SVG SMIL handling. Public npm later published 0.19.3; the integration pins that exact release.

## Recommended implementation direction

Do not implement a broad extractor framework or user-facing extractor configuration first. The smallest justified experiment is inside `src/fetch/http.ts`.

### Initial production candidate

1. Pin exact Defuddle 0.19.3 or a newer verified release after it is available from the configured registry.
2. Keep Readability as the first generic HTML extractor.
3. If Readability is absent or below the existing threshold, try RSC and then Defuddle on the same saved HTML.
4. Parse Defuddle with the existing LinkeDOM adapter and pass `useAsync: false`; keep a no-network regression test.
5. Convert Defuddle's cleaned HTML with the existing `htmlToMarkdown()` function instead of returning native Markdown.
6. Keep Jina after the local extractors.
7. Preserve `selector`, `includeLinks`, cancellation, title, and warning behavior.
8. Record the selected extractor in result details or tests so fallback decisions remain observable.

This first change intentionally copies the verified `pi-web-access` fallback shape. It does not run both extractors on every successful page, so it adds less median CPU cost and avoids the known Defuddle corruptions on pages Readability already handles.

### Later selector experiment

After the regression fixtures are stable, evaluate running both local extractors and applying the benchmark's relative-length guard. Do not promote Defuddle to the primary result based only on an absolute minimum length. Compare the candidates because the RFC failure was substantial, clean, and well above every absolute threshold used by the inspected Defuddle-first extensions.

### Required regression fixtures

At minimum, check in saved fixtures or reduced reproductions for:

- RFC 9110 section-boundary truncation;
- Wikipedia `4/3` fraction corruption;
- Git rebase mid-document Readability selection;
- Ars Technica final-section-only Readability selection;
- Python PEP 703 empty Readability result;
- TypeScript fenced-code corruption;
- a client-rendered empty shell;
- `includeLinks: false` and CSS-selector behavior;
- zero Defuddle network calls.

### Native Markdown follow-up

Defuddle native Markdown was the best-scoring variant and preserved tables, math, and code that D-C lost. Do not adopt it until the extension can retain the existing output contract without regex-based Markdown rewriting.

Prefer one of:

- an upstream Defuddle option to omit links and images while keeping native structural conversion;
- a supported Node API that converts already-cleaned, locally modified Defuddle HTML;
- a robust installed Markdown parser, only if its added dependency is justified.

Do not silently make `includeLinks: false` ineffective.

## Limitations

- This was a 45-page snapshot, not a universal web benchmark.
- The corpus emphasized English pages and coding-agent use cases.
- Five candidates could not be fetched and therefore did not reach extraction.
- Saved HTML does not include content rendered only after client JavaScript runs.
- Blind reviewers were model-based. Mechanical metrics and direct parent inspection were used to validate key findings, but the scores are still judgments.
- The source-region overlap reference is heuristic and should not be treated as ground truth.
- The blind scoring used 0.19.2 output followed by a full 0.19.3 rerun and diff inspection. No decision-changing output difference was found, but the exact 0.19.3 outputs were not independently rescored from scratch.
- Defuddle's worst-case CPU and memory behavior was not stress-tested with adversarial DOM input.

## Per-site blind scores

Each cell is the total of completeness, cleanliness, and structure, out of 12.

| Site | Category | R | D-C | D-N | Best by score |
|---|---|---:|---:|---:|---|
| [MDN Array.map](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map) | docs | 9 | 11 | 10 | D-C |
| [Node globals/fetch](https://nodejs.org/api/globals.html#fetch) | docs | 11 | 11 | 11 | tie |
| [TypeScript narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html) | docs | 7 | 8 | 8 | D-C/D-N |
| [Python asyncio](https://docs.python.org/3/library/asyncio.html) | docs | 8 | 10 | 10 | D-C/D-N |
| [Rust ownership](https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html) | docs | 9 | 12 | 12 | D-C/D-N |
| [Effective Go](https://go.dev/doc/effective_go) | docs | 8 | 12 | 11 | D-C |
| [Kubernetes deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/) | docs | 10 | 11 | 10 | D-C |
| [React managing state](https://react.dev/learn/managing-state) | docs | 7 | 12 | 12 | D-C/D-N |
| [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html) | docs | 9 | 10 | 10 | D-C/D-N |
| [SQLite window functions](https://www.sqlite.org/windowfunctions.html) | docs | 8 | 10 | 9 | D-C |
| [Git rebase](https://git-scm.com/docs/git-rebase) | docs | 6 | 12 | 12 | D-C/D-N |
| [npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json) | docs | 7 | 11 | 11 | D-C/D-N |
| [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/) | docs | 7 | 12 | 12 | D-C/D-N |
| [Terraform language](https://developer.hashicorp.com/terraform/language) | docs | 11 | 10 | 10 | R |
| [The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) | article | 10 | 10 | 10 | tie |
| [Ways DNS can break](https://jvns.ca/blog/2022/01/15/some-ways-dns-can-break/) | article | 10 | 10 | 10 | tie |
| [Microservices](https://martinfowler.com/articles/microservices.html) | article | 9 | 9 | 9 | tie |
| [Cloudflare AI stack](https://blog.cloudflare.com/internal-ai-engineering-stack/) | article | 11 | 10 | 11 | R/D-N |
| [Cloudflare standards](https://blog.cloudflare.com/engineering-standards-enforcement/) | article | 10 | 10 | 12 | D-N |
| [GitHub Docs search](https://github.blog/engineering/architecture-optimization/how-github-docs-new-search-works/) | article | 9 | 10 | 10 | D-C/D-N |
| [GitHub Codespaces](https://github.blog/engineering/infrastructure/githubs-engineering-team-moved-codespaces/) | article | 8 | 9 | 10 | D-N |
| [Anthropic effective agents](https://www.anthropic.com/research/building-effective-agents) | article | 9 | 9 | 11 | D-N |
| [Tailwind CSS v4](https://tailwindcss.com/blog/tailwindcss-v4) | article | 9 | 10 | 11 | D-N |
| [web.dev Baseline](https://web.dev/baseline) | article | 7 | 9 | 7 | D-C |
| [Ars entry-level jobs](https://arstechnica.com/ai/2026/08/ai-is-hitting-entry-level-jobs-hardest-stanford-study-finds/) | news | 7 | 8 | 8 | D-C/D-N |
| [Guardian OpenAI cyber](https://www.theguardian.com/technology/2026/aug/23/openai-cyber-attacks-threat-chris-lehane) | news | 9 | 10 | 9 | D-C |
| [BBC technology prices](https://www.bbc.com/news/articles/c1dzdndzlxqo) | news | 9 | 10 | 10 | D-C/D-N |
| [BBC technology in 2050](https://www.bbc.com/news/articles/c865n800d5jo) | news | 11 | 11 | 12 | D-N |
| [NPR Flock surveillance](https://www.npr.org/2026/08/21/nx-s1-5939851/flock-cameras-police-block-surveillance-vandalize) | news | 8 | 7 | 8 | R/D-N |
| [NPR AI escapes](https://www.npr.org/2026/08/14/nx-s1-5929579/recent-ai-escapes-are-a-warning-of-how-unpredictable-the-technology-can-be) | news | 9 | 10 | 10 | D-C/D-N |
| [AP robot conference](https://apnews.com/article/china-robot-conference-951ebd3cddaccf5afcedc68174ba626a) | news | 9 | 9 | 9 | tie |
| [AP Pixel phones](https://apnews.com/article/google-pixel-11-android-3bbad7afc4d25e15527477123415e50a) | news | 8 | 9 | 9 | D-C/D-N |
| [Wikipedia Formula](https://en.wikipedia.org/wiki/Formula) | structured | 8 | 9 | 11 | D-N |
| [Wikipedia HTTP](https://en.wikipedia.org/wiki/HTTP) | structured | 9 | 11 | 12 | D-N |
| [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) | structured | 10 | 7 | 7 | R |
| [OWASP A01 redirect stub](https://owasp.org/Top10/A01_2021-Broken_Access_Control/) | structured | 11 | 11 | 12 | D-N |
| [Attention Is All You Need](https://ar5iv.labs.arxiv.org/html/1706.03762) | structured | 9 | 8 | 11 | D-N |
| [PyPI Requests](https://pypi.org/project/requests/) | structured | 8 | 10 | 11 | D-N |
| [crates.io Serde shell](https://crates.io/crates/serde) | structured | 0 | 0 | 0 | tie |
| [HN Defuddle discussion](https://news.ycombinator.com/item?id=44067409) | community | 7 | 9 | 10 | D-N |
| [HN front page](https://news.ycombinator.com/) | community | 8 | 11 | 12 | D-N |
| [Python PEP 703 discussion](https://discuss.python.org/t/pep-703-making-the-global-interpreter-lock-optional-in-cpython/22606) | community | 0 | 7 | 8 | D-N |
| [Homebrew jq](https://formulae.brew.sh/formula/jq) | product | 9 | 10 | 12 | D-N |
| [Deno runtime docs](https://docs.deno.com/runtime/) | product | 8 | 11 | 12 | D-N |
| [Stripe pricing](https://stripe.com/pricing) | product | 7 | 9 | 7 | D-C |

## Final recommendation

Defuddle provides enough improvement to justify continued integration work. It should not be treated as a drop-in replacement whose output can be trusted whenever it is non-empty.

The next justified step is a small D-C fallback proof of concept with checked-in regression fixtures: Readability → RSC → Defuddle with `useAsync: false` → Jina. This matches the safest verified ecosystem precedent and avoids the known Defuddle failures on pages Readability already handles.

The implemented fallback pins Defuddle 0.19.3, disables its network extractors, preserves selectors and the existing link/image policy, and falls through to Jina on failure. After it has stable production evidence, separately test the guarded dual-extractor selector. If that remains reliable, pursue a supported way to use Defuddle's native structural Markdown while preserving `fetch_url` output controls.
