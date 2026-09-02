import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import piInternet from "../src/index.ts";

interface CapturedTool {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((result: unknown) => void) | undefined,
    context: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }>;
}

interface CapturedCommand {
  handler(args: string, context: Record<string, unknown>): Promise<void>;
}

function loadExtension() {
  const tools = new Map<string, CapturedTool>();
  const commands = new Map<string, CapturedCommand>();
  let activeTools: string[] = [];

  piInternet({
    on() {},
    registerTool(tool: CapturedTool & { name: string }) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: CapturedCommand) { commands.set(name, command); },
    getActiveTools() { return activeTools; },
    setActiveTools(names: string[]) { activeTools = names; },
  } as never);

  return { tools, commands };
}

function loadTools(): Map<string, CapturedTool> {
  return loadExtension().tools;
}

function textContent(result: Awaited<ReturnType<CapturedTool["execute"]>>): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function assertWithinToolLimits(text: string): void {
  assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES);
  assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
}

test("web_search: registered tool truncates oversized provider output", async () => {
  const tools = loadTools();
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.BRAVE_API_KEY;

  try {
    process.env.BRAVE_API_KEY = "test-key";
    globalThis.fetch = async () => new Response(JSON.stringify({
      web: {
        results: [{
          title: "Large result",
          url: "https://example.com/large",
          description: "x".repeat(DEFAULT_MAX_BYTES * 2),
        }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });

    const result = await tools.get("web_search")!.execute(
      "search-1",
      { query: "large result", provider: "brave", numResults: 1 },
      undefined,
      undefined,
      {},
    );
    const text = textContent(result);

    assertWithinToolLimits(text);
    assert.match(text, /Output truncated/);
    assert.match(text, /Refine the query/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = originalApiKey;
  }
});

test("web_search: registered tool truncates thrown errors", async () => {
  const tools = loadTools();
  const result = await tools.get("web_search")!.execute(
    "search-error",
    { query: "error", provider: "x".repeat(DEFAULT_MAX_BYTES * 2) },
    undefined,
    undefined,
    {},
  ).then(
    () => assert.fail("expected web_search to throw"),
    (error: unknown) => error,
  );
  const message = result instanceof Error ? result.message : String(result);

  assertWithinToolLimits(message);
  assert.match(message, /Output truncated/);
});

test("fetch_url: registered tool truncates after formatting and saves full output", async () => {
  const tools = loadTools();
  const originalFetch = globalThis.fetch;
  const body = "content line\n".repeat(DEFAULT_MAX_LINES + 100);

  try {
    globalThis.fetch = async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });

    const result = await tools.get("fetch_url")!.execute(
      "fetch-1",
      { url: "https://example.com/report.txt" },
      undefined,
      undefined,
      {},
    );
    const text = textContent(result);
    const fullOutputPath = result.details?.fullOutputPath;

    assertWithinToolLimits(text);
    assert.match(text, /Output truncated/);
    assert.equal(typeof fullOutputPath, "string");
    try {
      assert.equal(await readFile(fullOutputPath as string, "utf8"), `# report.txt\n\n${body}`);
    } finally {
      await rm(dirname(fullOutputPath as string), { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch_url: batch urls returns one section per URL with per-URL budgets and inline errors", async () => {
  const tools = loadTools();
  const originalFetch = globalThis.fetch;
  const oversized = "long line of content\n".repeat(DEFAULT_MAX_LINES + 100);

  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("missing")) return new Response("nope", { status: 404 });
      const body = url.includes("big") ? oversized : "small page content";
      return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
    };

    const result = await tools.get("fetch_url")!.execute(
      "fetch-batch",
      { urls: ["https://example.com/big.txt", "https://example.com/missing.txt", "https://example.com/small.txt"] },
      undefined,
      undefined,
      {},
    );
    const text = textContent(result);
    const details = result.details as {
      urlCount?: number;
      failedCount?: number;
      truncated?: boolean;
      urls?: Array<{ url: string; error?: string; fullOutputPath?: string }>;
    };

    assertWithinToolLimits(text);
    assert.equal(details.urlCount, 3);
    assert.equal(details.failedCount, 1);
    assert.equal(details.truncated, true);
    assert.match(text, /big\.txt/);
    assert.match(text, /Fetch failed: HTTP 404/);
    assert.match(text, /small page content/);
    assert.match(text, /Output truncated/);

    const bigSection = details.urls?.[0];
    assert.equal(typeof bigSection?.fullOutputPath, "string");
    try {
      const full = await readFile(bigSection!.fullOutputPath!, "utf8");
      assert.ok(full.includes(oversized));
    } finally {
      await rm(dirname(bigSection!.fullOutputPath!), { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch_url: an oversized batch error does not hide later results", async () => {
  const tools = loadTools();
  const originalFetch = globalThis.fetch;
  const oversizedError = "failure detail ".repeat(DEFAULT_MAX_BYTES);
  let fullOutputPath: string | undefined;

  try {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("failing")) throw new Error(oversizedError);
      return new Response("later page content", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    };

    const result = await tools.get("fetch_url")!.execute(
      "fetch-batch-error",
      { urls: ["https://example.com/failing", "https://example.com/later.txt"] },
      undefined,
      undefined,
      {},
    );
    const text = textContent(result);
    const details = result.details as {
      urls?: Array<{ error?: string; fullOutputPath?: string }>;
    };
    fullOutputPath = details.urls?.[0]?.fullOutputPath;

    assertWithinToolLimits(text);
    assert.match(text, /failing/);
    assert.match(text, /Output truncated/);
    assert.match(text, /later page content/);
    assert.match(details.urls?.[0]?.error ?? "", /failure detail/);
    assert.equal(typeof fullOutputPath, "string");
  } finally {
    globalThis.fetch = originalFetch;
    if (fullOutputPath) await rm(dirname(fullOutputPath), { recursive: true, force: true });
  }
});

test("fetch_url: rejects both url and urls, and rejects neither", async () => {
  const tools = loadTools();
  await assert.rejects(
    tools.get("fetch_url")!.execute(
      "fetch-both",
      { url: "https://example.com", urls: ["https://example.com/a"] },
      undefined,
      undefined,
      {},
    ),
    /not both/,
  );
  await assert.rejects(
    tools.get("fetch_url")!.execute("fetch-none", {}, undefined, undefined, {}),
    /Provide `url`/,
  );
});

test("web_research: registered tool bounds updates and saves a complete oversized report", {
  skip: process.platform === "win32",
}, async () => {
  const extension = loadExtension();
  const fakeBin = await mkdtemp(join(tmpdir(), "pi-internet-bin-"));
  const fakePi = join(fakeBin, "pi");
  const report = "research finding\n".repeat(DEFAULT_MAX_LINES + 100);
  const originalPath = process.env.PATH;
  let fullOutputPath: string | undefined;

  await writeFile(fakePi, `#!/usr/bin/env node
const report = ${JSON.stringify(report)};
console.log(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: report }],
    usage: { input: 10, output: 20, cost: { total: 0.001 } },
    model: "fake-scout",
  },
}));
`, { mode: 0o755 });

  try {
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    await extension.commands.get("toggle-research")!.handler("", {
      ui: { notify() {} },
    });

    const updates: unknown[] = [];
    const result = await extension.tools.get("web_research")!.execute(
      "research-1",
      { task: "Find relevant facts", urls: ["https://example.com"] },
      undefined,
      (update) => updates.push(update),
      { cwd: process.cwd() },
    );
    const text = textContent(result);
    fullOutputPath = result.details?.fullOutputPath as string | undefined;

    assertWithinToolLimits(text);
    assert.match(text, /Output truncated/);
    assert.equal(typeof fullOutputPath, "string");
    assert.equal(await readFile(fullOutputPath!, "utf8"), report);
    for (const update of updates) {
      assert.ok(Buffer.byteLength(JSON.stringify(update), "utf8") < 1_000);
    }
  } finally {
    process.env.PATH = originalPath;
    if (fullOutputPath) await rm(dirname(fullOutputPath), { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
});
