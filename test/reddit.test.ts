import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import piInternet from "../src/index.ts";
import type { PiInternetConfig } from "../src/config.ts";
import { fetchUrl, resetProxyState } from "../src/fetch/router.ts";

function makeConfig(overrides: Partial<PiInternetConfig> = {}): PiInternetConfig {
  return {
    searchProviders: ["brave", "kagi"],
    fallbackProviders: ["tavily"],
    reddit: {
      commentDepth: 4,
      proxyHost: "redlib.example",
      rateLimitMs: 1,
      ...overrides.reddit,
    },
    twitter: {
      proxyHost: null,
      rateLimitMs: 1,
      ...overrides.twitter,
    },
    github: {
      enabled: false,
      maxRepoSizeMB: 350,
      clonePath: "/tmp/pi-internet-test-github",
      refreshTtlMs: 300000,
      ...overrides.github,
    },
    youtube: {
      enabled: false,
      ...overrides.youtube,
    },
    pdf: {
      converter: "unpdf" as const,
      ...overrides.pdf,
    },
    fetch: {
      includeLinks: false,
      timeoutMs: 1000,
      socksProxy: null,
      allowPrivateNetworks: true,
      ...overrides.fetch,
    },
  };
}

async function withMockFetch<T>(handler: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  resetProxyState();

  try {
    globalThis.fetch = async (input, init) => handler(input, init);
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    resetProxyState();
  }
}

function response(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html" },
  });
}

function redditThreadHtml(commentCount = 3): string {
  const comments = Array.from({ length: commentCount }, (_, index) => {
    const n = index + 1;
    return `
      <div id="comment-${n}" class="comment">
        <p class="comment_score" title="${n}">${n}</p>
        <details open>
          <summary>
            <a class="comment_author" href="/user/commenter${n}">u/commenter${n}</a>
            <a class="created" href="#comment-${n}">now</a>
          </summary>
          <div class="comment_body"><div class="md"><p>Comment ${n}</p></div></div>
        </details>
      </div>`;
  }).join("\n");

  return `<!doctype html>
    <html><body>
      <div class="post">
        <a class="post_subreddit" href="/r/foo">r/foo</a>
        <a class="post_author" href="/user/op">u/op</a>
        <span class="created">1h ago</span>
        <p class="post_score" title="123">123</p>
        <a class="post_comments">${commentCount} comments</a>
        <h1 class="post_title">Example Reddit Thread</h1>
        <div class="post_body"><div class="md"><p>Post body text.</p></div></div>
      </div>
      <div id="comments">${comments}</div>
    </body></html>`;
}

function nestedRedditThreadHtml(): string {
  return `<!doctype html>
    <html><body>
      <div class="post">
        <a class="post_subreddit" href="/r/foo">r/foo</a>
        <a class="post_author" href="/user/op">u/op</a>
        <span class="created">1h ago</span>
        <p class="post_score" title="123">123</p>
        <h1 class="post_title">Example Reddit Thread</h1>
        <div class="post_body"><div class="md"><p>Post body text.</p></div></div>
      </div>
      <div id="comments">
        <div id="comment-1" class="comment">
          <p class="comment_score" title="1">1</p>
          <details open>
            <summary>
              <a class="comment_author" href="/user/commenter1">u/commenter1</a>
              <a class="created" href="#comment-1">now</a>
            </summary>
            <div class="comment_body"><div class="md"><p>Top comment</p></div></div>
            <blockquote class="replies">
              <div id="comment-2" class="comment">
                <p class="comment_score" title="2">2</p>
                <details open>
                  <summary>
                    <a class="comment_author" href="/user/op">u/op</a>
                    <a class="created" href="#comment-2">now</a>
                  </summary>
                  <div class="comment_body"><div class="md"><p>Nested reply</p></div></div>
                </details>
              </div>
            </blockquote>
          </details>
        </div>
      </div>
    </body></html>`;
}

test("fetchReddit: rewrites plain Reddit URLs through the configured proxy", async () => {
  const requests: string[] = [];

  await withMockFetch((input) => {
    requests.push(String(input));
    return response(redditThreadHtml(1));
  }, async () => {
    const result = await fetchUrl(
      "https://www.reddit.com/r/foo/comments/abc/example_thread/",
      makeConfig(),
    );

    assert.equal(result.error, null);
    assert.equal(requests.length, 1);
    assert.equal(requests[0], "https://redlib.example/r/foo/comments/abc/example_thread");
    assert.match(result.content, /## Comments \(1\)/);
    assert.match(result.content, /Comment 1/);
  });
});

test("fetchReddit: concurrent requests preserve the configured proxy interval", async () => {
  const requestTimes: number[] = [];
  const rateLimitMs = 25;

  await withMockFetch(() => {
    requestTimes.push(Date.now());
    return response(redditThreadHtml(1));
  }, async () => {
    await Promise.all(["one", "two", "three"].map((id) => fetchUrl(
      `https://www.reddit.com/r/foo/comments/${id}/example_thread/`,
      makeConfig({ reddit: { commentDepth: 4, proxyHost: "redlib.example", rateLimitMs } }),
    )));
  });

  assert.equal(requestTimes.length, 3);
  for (let index = 1; index < requestTimes.length; index++) {
    const interval = requestTimes[index] - requestTimes[index - 1];
    assert.ok(interval >= rateLimitMs - 5, `request interval ${interval}ms was below the configured limit`);
  }
});

test("fetchReddit: parses direct URLs on the configured proxy host", async () => {
  const requests: string[] = [];

  await withMockFetch((input) => {
    requests.push(String(input));
    return response(nestedRedditThreadHtml());
  }, async () => {
    const result = await fetchUrl(
      "https://redlib.example/r/foo/comments/abc/example_thread/",
      makeConfig(),
    );

    assert.equal(result.error, null);
    assert.equal(requests.length, 1);
    assert.equal(requests[0], "https://redlib.example/r/foo/comments/abc/example_thread");
    assert.match(result.content, /## Comments \(2\)/);
    assert.match(result.content, /Top comment/);
    assert.match(result.content, /> Nested reply/);
  });
});

test("fetchReddit: surfaces configured proxy failures without falling back to reddit.com", async () => {
  const requests: string[] = [];

  await withMockFetch((input) => {
    requests.push(String(input));
    return response("proxy unavailable", 503);
  }, async () => {
    const result = await fetchUrl(
      "https://www.reddit.com/r/foo/comments/abc/example_thread/",
      makeConfig(),
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0], "https://redlib.example/r/foo/comments/abc/example_thread");
    assert.match(result.error ?? "", /Reddit proxy redlib\.example returned HTTP 503/);
    assert.equal(result.content, "");
  });
});

test("fetchUrl: failed direct Reddit fetch suggests configuring a Redlib proxy", async () => {
  const requests: string[] = [];

  await withMockFetch((input) => {
    requests.push(String(input));
    return response("blocked", 403);
  }, async () => {
    const result = await fetchUrl(
      "https://www.reddit.com/r/foo/comments/abc/example_thread/",
      makeConfig({ reddit: { commentDepth: 4, proxyHost: null, rateLimitMs: 1 } }),
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0], "https://www.reddit.com/r/foo/comments/abc/example_thread/");
    assert.match(result.error ?? "", /Direct Reddit fetch failed/);
    assert.match(result.error ?? "", /PI_INTERNET_REDLIB_PROXY/);
  });
});

test("fetchReddit: non-verbose output caps comments and verbose output shows all parsed comments", async () => {
  await withMockFetch(() => response(redditThreadHtml(25)), async () => {
    const compact = await fetchUrl(
      "https://www.reddit.com/r/foo/comments/abc/example_thread/",
      makeConfig(),
    );

    assert.equal(compact.error, null);
    assert.match(compact.content, /## Comments \(25\)/);
    assert.match(compact.content, /Comment 20/);
    assert.doesNotMatch(compact.content, /Comment 21/);
    assert.match(compact.content, /5\/25 parsed comments not displayed/);

    const verbose = await fetchUrl(
      "https://www.reddit.com/r/foo/comments/abc/example_thread/",
      makeConfig(),
      { verbose: true },
    );

    assert.equal(verbose.error, null);
    assert.match(verbose.content, /Comment 25/);
    assert.doesNotMatch(verbose.content, /parsed comments not displayed/);
  });
});

test("fetchReddit: verbose is the public knob; fetch_url does not expose maxComments", () => {
  const tools: Array<{ name: string; parameters?: { properties?: Record<string, unknown> } }> = [];

  piInternet({
    on() {},
    registerTool(tool: { name: string; parameters?: { properties?: Record<string, unknown> } }) {
      tools.push(tool);
    },
    registerCommand() {},
    getActiveTools() { return []; },
    setActiveTools() {},
  } as never);

  const fetchTool = tools.find((tool) => tool.name === "fetch_url");
  assert.ok(fetchTool);
  assert.ok(fetchTool.parameters?.properties);
  assert.equal("verbose" in fetchTool.parameters.properties, true);
  assert.equal("maxComments" in fetchTool.parameters.properties, false);
});

const GIF_IMAGE = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const NETWORK_BLOCK = "You've been blocked by network security.\n\n"
  + "To continue, log in to your Reddit account or use your developer token\n\n"
  + "If you think you've been blocked by mistake, file a ticket below and we'll look into it.\n\n"
  + "[Log in](https://www.reddit.com/login/)[File a ticket](https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=21879292693140)";

function directConfig(): PiInternetConfig {
  return makeConfig({ reddit: { proxyHost: null, commentDepth: 4, rateLimitMs: 1 } });
}

test("fetchUrl: direct Reddit image hosts download images, not navigation pages", async () => {
  for (const host of ["i.redd.it", "preview.redd.it"]) {
    await withMockFetch((_input, init) => {
      assert.equal(new Headers(init?.headers).get("accept"), "*/*");
      return new Response(GIF_IMAGE, { headers: { "content-type": "image/gif" } });
    }, async () => {
      const url = `https://${host}/image.gif?width=1&s=signature`;
      const result = await fetchUrl(url, directConfig());
      const path = result.artifacts?.imageDownload;
      try {
        assert.equal(result.error, null);
        assert.equal(result.url, url);
        assert.ok(path);
        assert.deepEqual(await readFile(path), GIF_IMAGE);
        assert.match(result.content, /Dimensions: 1x1/);
        assert.equal(result.images, undefined);
      } finally {
        if (path) await rm(dirname(path), { recursive: true, force: true });
      }
    });
  }
});

test("fetchUrl: Reddit network-security HTML is a failure even when Jina is unavailable", async () => {
  const html = await readFile(new URL("./fixtures/reddit-network-block.html", import.meta.url), "utf8");
  await withMockFetch((input) => String(input).startsWith("https://r.jina.ai/")
    ? response("Unavailable", 503) : response(html), async () => {
    const result = await fetchUrl("https://www.reddit.com/media?url=example", directConfig());
    assert.match(result.error ?? "", /Reddit verification\/block page/);
    assert.match(result.error ?? "", /PI_INTERNET_REDLIB_PROXY/);
    assert.equal(result.content, "");
    assert.equal(result.artifacts, undefined);
  });
});

test("fetchUrl: Jina network-security Markdown is a failure on Reddit and media hosts", async () => {
  for (const host of ["www.reddit.com", "i.redd.it", "preview.redd.it", "external-preview.redd.it"]) {
    const requests: string[] = [];
    await withMockFetch((input) => {
      requests.push(String(input));
      return String(input).startsWith("https://r.jina.ai/")
        ? new Response(`Title: Reddit\n\nMarkdown Content:\n${NETWORK_BLOCK}`)
        : response('<html><body><div id="root"></div></body></html>');
    }, async () => {
      const result = await fetchUrl(`https://${host}/image.jpg`, directConfig());
      assert.ok(requests.some((url) => url.startsWith("https://r.jina.ai/")));
      assert.match(result.error ?? "", /Reddit verification\/block page/);
      assert.equal(result.content, "");
      assert.equal(result.artifacts, undefined);
      assert.equal(result.images, undefined);
    });
  }
});

test("fetchUrl: quoted block messages remain usable on other hosts and Reddit discussions", async () => {
  const explanation = "This discussion explains why the message appears and how the response differs from a real image. ".repeat(10);
  const quoted = `# Reddit security discussion\n\n> ${NETWORK_BLOCK.replace(/\n/g, "\n> ")}\n\n${explanation}`;
  for (const [host, content] of [["news.example", NETWORK_BLOCK], ["i.redd.it.evil.test", NETWORK_BLOCK], ["www.reddit.com", quoted]]) {
    await withMockFetch((input) => String(input).startsWith("https://r.jina.ai/")
      ? new Response(`Markdown Content:\n${content}`)
      : response('<html><body><div id="root"></div></body></html>'), async () => {
      const result = await fetchUrl(`https://${host}/article`, directConfig());
      assert.equal(result.error, null);
      assert.equal(result.content, content.trim());
    });
  }

  await withMockFetch(() => response(`<html><head><title>Reddit security discussion</title></head><body><article>
    <h1>Reddit security discussion</h1><p>${explanation}</p><blockquote><p>You've been blocked by network security.</p>
    <p>To continue, log in to your Reddit account or use your developer token</p></blockquote></article></body></html>`), async () => {
    const result = await fetchUrl("https://www.reddit.com/r/help/comments/abc/security/", directConfig());
    assert.equal(result.error, null);
    assert.match(result.content, /This discussion explains/);
    assert.match(result.content, /blocked by network security/);
  });
});
