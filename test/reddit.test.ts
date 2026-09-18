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

test("fetchUrl: image filenames are not scanned as Reddit verification content", async () => {
  for (const host of ["i.redd.it", "preview.redd.it", "www.reddit.com"]) {
    for (const [mimeType, extension] of [["image/gif", "gif"], ["image/avif", "avif"]]) {
      await withMockFetch(() => new Response(GIF_IMAGE, { headers: { "content-type": mimeType } }), async () => {
        const url = `https://${host}/js_challenge.${extension}?note=please%20wait%20for%20verification`;
        const result = await fetchUrl(url, directConfig());
        const path = result.artifacts?.imageDownload;
        try {
          assert.equal(result.error, null);
          assert.equal(result.url, url);
          if (mimeType === "image/gif") {
            assert.ok(path);
            assert.deepEqual(await readFile(path), GIF_IMAGE);
            assert.match(result.content, /Downloaded image to:/);
          } else {
            assert.equal(path, undefined);
            assert.match(result.content, /image\/avif cannot be displayed/);
            assert.ok(result.content.includes(url));
          }
        } finally {
          if (path) await rm(dirname(path), { recursive: true, force: true });
        }
      });
    }
  }
});

test("fetchUrl: Reddit block headlines use the same apostrophe normalization as content", async () => {
  const html = (await fixture("reddit-network-block.html")).replaceAll("You've", "You’ve");
  await withMockFetch((input) => String(input).startsWith("https://r.jina.ai/")
    ? response("Unavailable", 503) : response(html), async () => {
    const result = await fetchUrl("https://www.reddit.com/media?url=example", directConfig());
    assert.equal(result.title, "You’ve been blocked by network security.");
    assert.match(result.error ?? "", /Reddit verification\/block page/);
    assert.equal(result.content, "");
    assert.equal(result.artifacts, undefined);
  });
});

test("fetchUrl: a discussion title preserves a complete pasted Reddit block message", async () => {
  const title = "Why does this Reddit network error appear?";
  const html = (await fixture("reddit-network-block.html"))
    .replace("<title>Reddit</title>", `<title>${title}</title>`)
    .replace("<main>", `<article><h1>${title}</h1>`)
    .replace("</main>", "</article>");
  await withMockFetch((input) => String(input).startsWith("https://r.jina.ai/")
    ? response("Unavailable", 503) : response(html), async () => {
    const result = await fetchUrl("https://www.reddit.com/r/help/comments/abc/error/", directConfig());
    assert.equal(result.title, title);
    assert.match(result.content, /You've been blocked by network security\./);
    assert.match(result.content, /To continue, log in to your Reddit account or use your developer token/);
    assert.match(result.content, /file a ticket below/);
    assert.doesNotMatch(result.error ?? "", /Reddit verification\/block page/);
  });
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

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("fetchReddit: media rewrites preserve host, port, signed query and original result URL", async () => {
  const config = makeConfig({ reddit: { proxyHost: "redlib.example:8443", commentDepth: 4, rateLimitMs: 1 } });
  for (const [host, prefix] of [["i.redd.it", "/img"], ["preview.redd.it", "/preview/pre"]]) {
    const requests: string[] = [];
    await withMockFetch((input) => {
      requests.push(String(input));
      return new Response(GIF_IMAGE, { headers: { "content-type": "Image/GIF; charset=binary" } });
    }, async () => {
      const url = `https://${host}/folder/image.jpg?width=1280&format=pjpg&auto=webp&s=ab%2BCD&repeat=1&repeat=2`;
      const result = await fetchUrl(url, config);
      const path = result.artifacts?.imageDownload;
      try {
        assert.deepEqual(requests, [`https://redlib.example:8443${prefix}/folder/image.jpg?width=1280&format=pjpg&auto=webp&s=ab%2BCD&repeat=1&repeat=2`]);
        assert.equal(result.url, url);
        assert.equal(result.error, null);
        assert.ok(path);
        assert.match(path, /\.gif$/);
        assert.deepEqual(await readFile(path), GIF_IMAGE);
        assert.equal(result.images, undefined);
      } finally {
        if (path) await rm(dirname(path), { recursive: true, force: true });
      }
    });
  }
});

test("fetchReddit: direct proxy image response is downloaded once regardless of filename", async () => {
  const url = "https://redlib.example/preview/pre/no-extension?width=1&s=a%2Fb";
  const requests: string[] = [];
  await withMockFetch((input) => {
    requests.push(String(input));
    return new Response(GIF_IMAGE, { headers: { "content-type": "image/gif" } });
  }, async () => {
    const result = await fetchUrl(url, makeConfig());
    const path = result.artifacts?.imageDownload;
    try {
      assert.deepEqual(requests, [url]);
      assert.equal(result.error, null);
      assert.ok(path);
      assert.deepEqual(await readFile(path), GIF_IMAGE);
    } finally {
      if (path) await rm(dirname(path), { recursive: true, force: true });
    }
  });
});

test("fetchUrl: unverified Reddit media subdomains retain the direct route when Redlib is configured", async () => {
  const url = "https://external-preview.redd.it/image.svg";
  const requests: string[] = [];
  await withMockFetch((input, init) => {
    requests.push(String(input));
    assert.equal(new Headers(init?.headers).get("accept"), "*/*");
    return new Response("svg", { headers: { "content-type": "image/svg+xml" } });
  }, async () => {
    const result = await fetchUrl(url, makeConfig());
    assert.equal(result.error, null);
    assert.deepEqual(requests, [url]);
    assert.equal(result.artifacts, undefined);
  });
});

test("fetchReddit: media failures never retry direct Reddit or Jina and cancel response bodies", async () => {
  for (const url of ["https://i.redd.it/image.jpg", "https://preview.redd.it/image.jpg", "https://redlib.example/img/image.jpg"]) {
    for (const [status, contentType, expected] of [
      [403, "text/html", /HTTP 403/],
      [503, "text/html", /HTTP 503/],
      [200, "text/html", /HTML instead of an image/],
      [200, "application/json", /unsupported content type/],
      [200, "video/mp4", /unsupported content type/],
    ] as const) {
      let cancelled = false;
      const requests: string[] = [];
      await withMockFetch((input) => {
        requests.push(String(input));
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
          status, headers: { "content-type": contentType },
        });
      }, async () => {
        const result = await fetchUrl(url, makeConfig());
        assert.equal(requests.length, 1);
        assert.equal(new URL(requests[0]).host, "redlib.example");
        assert.match(result.error ?? "", expected);
        assert.equal(result.content, "");
        assert.equal(result.artifacts, undefined);
        assert.equal(cancelled, true);
      });
    }
  }
});

test("fetchReddit: unsupported image formats remain URL-only and oversized images fail", async () => {
  for (const contentType of ["image/avif", "image/png"]) {
    let cancelled = false;
    await withMockFetch(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      headers: { "content-type": contentType, "content-length": String(11 * 1024 * 1024) },
    }), async () => {
      const result = await fetchUrl("https://redlib.example/img/image", makeConfig());
      assert.equal(result.artifacts, undefined);
      assert.equal(cancelled, true);
      if (contentType === "image/avif") {
        assert.equal(result.error, null);
        assert.match(result.content, /cannot be displayed/);
        assert.match(result.content, /https:\/\/redlib\.example\/img\/image/);
      } else {
        assert.match(result.error ?? "", /exceeds the 10 MiB limit/);
        assert.equal(result.content, "");
      }
    });
  }
});

test("fetchReddit: rewrites reject invalid schemes and embedded credentials before sending requests", async () => {
  await withMockFetch(() => { throw new Error("Unexpected network request"); }, async () => {
    for (const url of ["ftp://i.redd.it/image.gif", "ftp://redlib.example/img/image.gif", "https://user:secret@preview.redd.it/image.gif", "https://user@www.reddit.com/r/foo/"]) {
      const result = await fetchUrl(url, makeConfig());
      assert.match(result.error ?? "", /Unsupported URL scheme|embedded credentials/);
      assert.equal(result.artifacts, undefined);
    }
  });
});

test("fetchReddit: proxy redirects cannot escape to direct Reddit or another host", async () => {
  for (const target of ["https://i.redd.it/image.gif", "https://www.reddit.com/media", "https://other.example/image.gif", "http://redlib.example/img/image.gif"]) {
    const requests: string[] = [];
    let cancelled = false;
    await withMockFetch((input) => {
      requests.push(String(input));
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 307, headers: { location: target } });
    }, async () => {
      const result = await fetchUrl("https://i.redd.it/image.gif", makeConfig());
      assert.deepEqual(requests, ["https://redlib.example/img/image.gif"]);
      assert.match(result.error ?? "", /Cross-origin redirect blocked/);
      assert.equal(result.artifacts, undefined);
      assert.equal(cancelled, true);
    });
  }
});

test("fetchReddit: same-origin redirects retain validation and download without a second fetch pipeline", async () => {
  const requests: string[] = [];
  await withMockFetch((input) => {
    requests.push(String(input));
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { location: "/img/redirected.gif?s=keep" } })
      : new Response(GIF_IMAGE, { headers: { "content-type": "image/gif" } });
  }, async () => {
    const result = await fetchUrl("https://i.redd.it/image.gif", makeConfig());
    const path = result.artifacts?.imageDownload;
    try {
      assert.equal(result.error, null);
      assert.ok(path);
      assert.deepEqual(requests, ["https://redlib.example/img/image.gif", "https://redlib.example/img/redirected.gif?s=keep"]);
    } finally {
      if (path) await rm(dirname(path), { recursive: true, force: true });
    }
  });
});

test("fetchReddit: private-network policy still applies to rewritten media", async () => {
  const config = makeConfig();
  config.fetch.allowPrivateNetworks = false;
  await withMockFetch(() => { throw new Error("Unexpected network request"); }, async () => {
    const result = await fetchUrl("https://i.redd.it/image.gif", config, {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    assert.match(result.error ?? "", /Blocked private or reserved address/);
    assert.equal(result.artifacts, undefined);
  });
});

test("fetchReddit: cancelled image body is discarded and not returned as an artifact", async () => {
  const controller = new AbortController();
  let cancelled = false;
  await withMockFetch(() => {
    controller.abort(new Error("test cancellation"));
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "image/gif" } });
  }, async () => {
    const result = await fetchUrl("https://i.redd.it/image.gif", makeConfig(), { signal: controller.signal });
    assert.match(result.error ?? "", /test cancellation/);
    assert.equal(cancelled, true);
    assert.equal(result.artifacts, undefined);
  });
});

test("fetchReddit: gallery URLs appear once in order with body/comments and no downloads", async () => {
  const html = await fixture("redlib-gallery.html");
  const requests: string[] = [];
  await withMockFetch((input) => { requests.push(String(input)); return response(html); }, async () => {
    const result = await fetchUrl("https://www.reddit.com/r/pics/comments/abc/gallery/", makeConfig());
    assert.equal(result.error, null);
    assert.deepEqual(requests, ["https://redlib.example/r/pics/comments/abc/gallery"]);
    assert.equal(result.artifacts, undefined);
    assert.equal(result.images, undefined);
    assert.match(result.content, /Gallery body text\./);
    assert.match(result.content, /## Comments \(1\)/);
    assert.match(result.content, /Gallery comment\./);
    const first = "https://redlib.example/preview/pre/first.png?width=1190&format=png&s=first-signature";
    const second = "https://redlib.example/preview/pre/second.jpg?width=1106&format=pjpg&s=second-signature";
    assert.equal(result.content.split(first).length, 2);
    assert.equal(result.content.split(second).length, 2);
    assert.ok(result.content.indexOf("Gallery body text") < result.content.indexOf("## Images"));
    assert.ok(result.content.indexOf(first) < result.content.indexOf(second));
    assert.ok(result.content.indexOf(second) < result.content.indexOf("## Comments"));
    assert.doesNotMatch(result.content, /logo\.png|avatar\.png|comment-image\.png|original.resolution/i);
  });
});

test("fetchReddit: single-image SVG wrapper is disclosed once", async () => {
  const html = await fixture("redlib-single-image.html");
  await withMockFetch(() => response(html), async () => {
    const result = await fetchUrl("https://redlib.example/r/pics/comments/abc/single/", makeConfig());
    assert.equal(result.error, null);
    assert.match(result.content, /## Images/);
    assert.equal(result.content.split("https://redlib.example/img/single.jpeg?s=signature").length, 2);
    assert.match(result.content, /Single image body\./);
    assert.equal(result.artifacts, undefined);
  });
});

test("fetchReddit: image URLs resolve against the final proxy page and invalid media is excluded", async () => {
  const html = (await fixture("redlib-gallery.html"))
    .replaceAll("/preview/pre/first.png", "first.png")
    .replace('</div>\n  <div class="post_body">', `
      <figure><a href="javascript:alert(1)"><img src="data:image/png,abc" /></a></figure>
      <figure><a href="/img/evil&#10;row.jpg"><img src="/img/evil&#10;row.jpg" /></a></figure>
      <figure><a href="https://user:secret@example.com/img.jpg"><img src="https://user:secret@example.com/img.jpg" /></a></figure>
      <figure><video poster="/video-poster.jpg"></video></figure>
      <figure><a href="/preview/pre/second.jpg?width=1106&amp;format=pjpg&amp;s=second-signature"><img src="/duplicate-thumbnail.jpg" /></a></figure>
    </div><div class="post_body">`);
  await withMockFetch(() => {
    const res = response(html);
    Object.defineProperty(res, "url", { value: "https://redlib.example/r/pics/comments/redirected/page/" });
    return res;
  }, async () => {
    const result = await fetchUrl("https://redlib.example/r/pics/comments/abc/gallery/", makeConfig());
    assert.equal(result.error, null);
    assert.match(result.content, /https:\/\/redlib\.example\/r\/pics\/comments\/redirected\/page\/first\.png\?width=1190&format=png&s=first-signature/);
    assert.equal(result.content.split("https://redlib.example/preview/pre/second.jpg?").length, 2);
    assert.doesNotMatch(result.content, /javascript:|data:image|evil|secret|video-poster|duplicate-thumbnail/);
  });
});

test("fetchReddit: text-only threads and listings do not gain an Images section", async () => {
  await withMockFetch(() => response(redditThreadHtml(1)), async () => {
    const result = await fetchUrl("https://redlib.example/r/foo/comments/abc/text/", makeConfig());
    assert.equal(result.error, null);
    assert.doesNotMatch(result.content, /## Images/);
    assert.match(result.content, /Post body text\./);
    assert.match(result.content, /Comment 1/);
  });
  const gallery = await fixture("redlib-gallery.html");
  await withMockFetch(() => response(gallery), async () => {
    const result = await fetchUrl("https://redlib.example/r/pics/", makeConfig());
    assert.equal(result.error, null);
    assert.doesNotMatch(result.content, /## Images|first\.png|second\.jpg|Gallery comment/);
    assert.match(result.content, /\*\*Gallery post\*\*/);
    assert.match(result.content, /Gallery body text\./);
  });
});

test("fetchReddit: media and post requests share the configured throttle", async () => {
  const times: number[] = [];
  const config = makeConfig({ reddit: { proxyHost: "redlib.example", commentDepth: 4, rateLimitMs: 25 } });
  await withMockFetch((input) => {
    times.push(Date.now());
    return String(input).includes("/img/")
      ? new Response(null, { headers: { "content-type": "image/avif" } })
      : response(redditThreadHtml(1));
  }, async () => {
    const results = await Promise.all([
      fetchUrl("https://i.redd.it/image.avif", config),
      fetchUrl("https://www.reddit.com/r/foo/comments/abc/post/", config),
      fetchUrl("https://redlib.example/img/second.avif", config),
    ]);
    assert.ok(results.every((result) => result.error === null));
    assert.equal(times.length, 3);
    assert.ok(times[1] - times[0] >= 20);
    assert.ok(times[2] - times[1] >= 20);
  });
});

test("fetchUrl: a Reddit media redirect to an HTML block still fails after Jina", async () => {
  const url = "https://preview.redd.it/image.jpg?s=signature";
  const target = `https://www.reddit.com/media?url=${encodeURIComponent(url)}`;
  const requests: string[] = [];
  await withMockFetch((input) => {
    const requested = String(input);
    requests.push(requested);
    if (requested === url) return new Response(null, { status: 307, headers: { location: target } });
    if (requested === target) return response('<html><body><div id="root"></div></body></html>');
    assert.equal(requested, `https://r.jina.ai/${url}`);
    return new Response(`Markdown Content:\n${NETWORK_BLOCK}`);
  }, async () => {
    const result = await fetchUrl(url, directConfig());
    assert.equal(requests.length, 3);
    assert.equal(result.url, url);
    assert.match(result.error ?? "", /Reddit verification\/block page/);
    assert.equal(result.content, "");
    assert.equal(result.artifacts, undefined);
  });
});
