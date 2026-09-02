import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { arxivHtmlToMarkdown } from "../src/fetch/arxiv-html.ts";
import {
  fetchArxiv,
  parseArxivManifest,
  parseArxivUrl,
  resetArxivCache,
} from "../src/fetch/arxiv.ts";

function config() {
  const value = loadConfig();
  value.fetch.socksProxy = null;
  value.fetch.timeoutMs = 5_000;
  return value;
}

function absFixture(options: {
  current?: number;
  latest?: number;
  html?: boolean;
  source?: boolean;
} = {}): string {
  const current = options.current ?? 2;
  const latest = options.latest ?? current;
  const html = options.html ?? true;
  const source = options.source ?? true;
  const history = Array.from({ length: latest }, (_, index) => {
    const version = index + 1;
    return `<strong><a href="/abs/2401.01234v${version}">[v${version}]</a></strong> Mon, ${version} Jan 2024 00:00:00 UTC (${version} KB)<br>`;
  }).join("");
  return `<!doctype html><html><head>
    <meta name="citation_arxiv_id" content="2401.01234">
  </head><body>
    <div class="header-breadcrumbs-mobile"><strong>arXiv:2401.01234v${current}</strong></div>
    <div id="abs">
      <div class="dateline">[Submitted on 1 Jan 2024 (v1), this version v${current}]</div>
      <h1 class="title"><span class="descriptor">Title:</span>Useful Paper</h1>
      <div class="authors"><span class="descriptor">Authors:</span><a>Ada Author</a>, <a>Ben Writer</a></div>
      <blockquote class="abstract"><span class="descriptor">Abstract:</span>A useful abstract.</blockquote>
      <div class="metatable"><table>
        <tr><td class="label">Comments:</td><td>12 pages</td></tr>
        <tr><td class="label">Subjects:</td><td>Machine Learning (cs.LG)</td></tr>
        <tr><td class="label">DOI:</td><td>10.1000/example</td></tr>
      </table></div>
    </div>
    <div class="submission-history">${history}</div>
    <div class="full-text"><ul>
      <li><a class="download-pdf" href="/pdf/2401.01234v${current}">View PDF</a></li>
      ${html ? `<li><a id="latexml-download-link" href="/html/2401.01234v${current}">HTML</a></li>` : ""}
      ${source ? `<li><a class="download-eprint" href="/src/2401.01234v${current}">TeX Source</a></li>` : ""}
    </ul><div class="abs-license"><a href="https://creativecommons.org/licenses/by/4.0/" title="Test license">license</a></div></div>
    <div class="ancillary"><a class="anc-file-name" href="/src/2401.01234v${current}/anc/data.csv">data.csv</a></div>
  </body></html>`;
}

test("parseArxivUrl recognizes modern and old-style representation URLs", () => {
  assert.deepEqual(parseArxivUrl("https://arxiv.org/pdf/2401.01234v2.pdf"), {
    representation: "pdf",
    id: "2401.01234v2",
    baseId: "2401.01234",
    requestedVersion: 2,
  });
  assert.deepEqual(parseArxivUrl("https://export.arxiv.org/src/hep-th/9901001v3"), {
    representation: "src",
    id: "hep-th/9901001v3",
    baseId: "hep-th/9901001",
    requestedVersion: 3,
  });
  assert.equal(parseArxivUrl("https://example.com/abs/2401.01234"), null);
  assert.equal(parseArxivUrl("https://arxiv.org/src/2401.01234v1/anc/data.csv"), null);
});

test("parseArxivManifest returns authoritative formats, versions, and ancillary links", () => {
  const manifest = parseArxivManifest(absFixture(), "https://arxiv.org/abs/2401.01234v2");
  assert.equal(manifest.id, "2401.01234v2");
  assert.equal(manifest.latestVersion, 2);
  assert.deepEqual(manifest.authors, ["Ada Author", "Ben Writer"]);
  assert.equal(manifest.urls.html, "https://arxiv.org/html/2401.01234v2");
  assert.equal(manifest.urls.pdf, "https://arxiv.org/pdf/2401.01234v2");
  assert.equal(manifest.urls.src, "https://arxiv.org/src/2401.01234v2");
  assert.deepEqual(manifest.ancillary, [{
    label: "data.csv",
    url: "https://arxiv.org/src/2401.01234v2/anc/data.csv",
  }]);
  assert.equal(manifest.license?.url, "https://creativecommons.org/licenses/by/4.0/");
  assert.match(manifest.versions[1].detail, /2 Jan 2024/);
});

test("fetchArxiv retries transient abstract failures and caches only success", async () => {
  resetArxivCache();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response("busy", { status: 503, statusText: "Busy" });
      return new Response(absFixture(), { status: 200, headers: { "content-type": "text/html" } });
    };
    const first = await fetchArxiv("https://arxiv.org/abs/2401.01234v2", config());
    const second = await fetchArxiv("https://arxiv.org/abs/2401.01234v2", config());
    assert.equal(first?.error, null);
    assert.equal(second?.error, null);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetArxivCache();
  }
});

test("fetchArxiv does not cache a failed abstract request", async () => {
  resetArxivCache();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls <= 2) return new Response("busy", { status: 503, statusText: "Busy" });
      return new Response(absFixture(), { headers: { "content-type": "text/html" } });
    };
    await assert.rejects(fetchArxiv("https://arxiv.org/abs/2401.01234v2", config()), /HTTP 503/);
    const result = await fetchArxiv("https://arxiv.org/abs/2401.01234v2", config());
    assert.equal(result?.error, null);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
    resetArxivCache();
  }
});

test("fetchArxiv verifies both requested and latest manifests for stale revisions", async () => {
  resetArxivCache();
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      const old = url.endsWith("v1");
      return new Response(absFixture({ current: old ? 1 : 2, latest: 2 }), {
        headers: { "content-type": "text/html" },
      });
    };
    const result = await fetchArxiv("https://arxiv.org/abs/2401.01234v1", config());
    assert.deepEqual(urls, [
      "https://arxiv.org/abs/2401.01234v1",
      "https://arxiv.org/abs/2401.01234",
    ]);
    assert.match(result?.content ?? "", /older; latest is v2/);
    assert.match(result?.content ?? "", /prefer latest v2/);
  } finally {
    globalThis.fetch = originalFetch;
    resetArxivCache();
  }
});

test("fetchArxiv retries the requested representation after metadata succeeds", async () => {
  resetArxivCache();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response(absFixture(), { headers: { "content-type": "text/html" } });
      if (calls === 2) return new Response("busy", { status: 503, statusText: "Busy" });
      return new Response('<article class="ltx_document"><p>Recovered full paper.</p></article>', {
        headers: { "content-type": "text/html" },
      });
    };
    const result = await fetchArxiv("https://arxiv.org/html/2401.01234v2", config());
    assert.equal(result?.error, null);
    assert.match(result?.content ?? "", /Recovered full paper/);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
    resetArxivCache();
  }
});

test("fetchArxiv reports an unavailable representation without substitution", async () => {
  resetArxivCache();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(absFixture({ html: false }), { headers: { "content-type": "text/html" } });
    };
    const result = await fetchArxiv("https://arxiv.org/html/2401.01234v2", config());
    assert.match(result?.error ?? "", /HTML is unavailable/);
    assert.match(result?.content ?? "", /HTML: unavailable/);
    assert.match(result?.content ?? "", /PDF:/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    resetArxivCache();
  }
});

test("fetchArxiv rejects a 200 non-paper HTML body and preserves verified recovery metadata", async () => {
  resetArxivCache();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response(absFixture(), { headers: { "content-type": "text/html" } });
      return new Response("<html><body><main>Challenge page</main></body></html>", { headers: { "content-type": "text/html" } });
    };
    const result = await fetchArxiv("https://arxiv.org/html/2401.01234v2", config());
    assert.match(result?.error ?? "", /no semantic paper document/);
    assert.match(result?.content ?? "", /^## arXiv representations/);
    assert.match(result?.content ?? "", /## Metadata/);
    assert.doesNotMatch(result?.content ?? "", /Challenge page/);
  } finally {
    globalThis.fetch = originalFetch;
    resetArxivCache();
  }
});

test("fetchArxiv preserves disclosure when PDF processing fails", async () => {
  resetArxivCache();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response(absFixture(), { headers: { "content-type": "text/html" } });
      return new Response("not a pdf", { headers: { "content-type": "application/pdf" } });
    };
    const result = await fetchArxiv("https://arxiv.org/pdf/2401.01234v2", config());
    assert.match(result?.error ?? "", /valid PDF signature/);
    assert.match(result?.content ?? "", /^## arXiv representations/);
    assert.match(result?.content ?? "", /## Metadata/);
  } finally {
    globalThis.fetch = originalFetch;
    resetArxivCache();
  }
});

test("arxivHtmlToMarkdown preserves TeX, figures, links, and table structure", () => {
  const html = `<article class="ltx_document">
    <h1 class="ltx_title">Title</h1>
    <p>State <math display="inline" alttext="fallback"><semantics><annotation encoding="application/x-tex">h_{t}</annotation></semantics></math>.</p>
    <figure><img src="fig.png" alt="Architecture"><figcaption>Figure 1: Model</figcaption></figure>
    <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td><a href="paper">source</a></td></tr></table>
    <table><tr><td rowspan="2">complex</td><td>x</td></tr><tr><td>y</td></tr></table>
  </article>`;
  const result = arxivHtmlToMarkdown(html, "https://arxiv.org/html/2401.01234v2");
  assert.match(result.markdown, /\$h_\{t\}\$/);
  assert.match(result.markdown, /\[Architecture\]\(https:\/\/arxiv\.org\/html\/fig\.png\)/);
  assert.match(result.markdown, /\*\*Figure 1: Model\*\*/);
  assert.match(result.markdown, /\| A \| B \|/);
  assert.match(result.markdown, /\[source\]\(https:\/\/arxiv\.org\/html\/paper\)/);
  assert.match(result.markdown, /<table>/);
  assert.match(result.markdown, /rowspan="2"/);

  const compact = arxivHtmlToMarkdown(html, "https://arxiv.org/html/2401.01234v2", undefined, false);
  assert.match(compact.markdown, /Architecture/);
  assert.match(compact.markdown, /source/);
  assert.doesNotMatch(compact.markdown, /https:\/\//);
});

test("fetchArxiv keeps representation links but strips ordinary links in compact mode", async () => {
  resetArxivCache();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(absFixture(), { headers: { "content-type": "text/html" } });
    const result = await fetchArxiv("https://arxiv.org/abs/2401.01234v2", config(), { includeLinks: false });
    assert.match(result?.content ?? "", /\[structured full text; best for reading when available\]/);
    assert.match(result?.content ?? "", /- License: Test license/);
    assert.doesNotMatch(result?.content ?? "", /\[Test license\]/);
    assert.match(result?.content ?? "", /  - v2 —/);
    assert.doesNotMatch(result?.content ?? "", /\[v2\]/);
  } finally {
    globalThis.fetch = originalFetch;
    resetArxivCache();
  }
});
