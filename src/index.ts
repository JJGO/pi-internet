/**
 * pi-internet — Web search, content fetching, and research for Pi.
 *
 * Tools:
 *   - web_search: Multi-provider search with parallel primary + fallback
 *   - fetch_url: URL fetching with specialized handlers (GitHub, Reddit, Twitter, YouTube, PDF)
 *   - web_research: Scout subagent for deep research (hidden by default)
 *
 * See the README provenance section for a brief summary of implementation sources.
 */

import { type ExtensionAPI, keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { loadConfig } from "./config.js";
import { createSearchRouter } from "./search/router.js";
import { formatResults, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS } from "./search/types.js";
import { setKagiToken, getKagiToken } from "./search/providers/kagi.js";
import { fetchUrl, resetProxyState } from "./fetch/router.js";
import { clearCloneCache } from "./fetch/github.js";
import { runScout, resolveScoutModel, buildScoutPrompt } from "./research/scout.js";
import { resetSocksProxyDispatchers } from "./util/proxy.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const IS_SCOUT = process.env.PI_INTERNET_SCOUT === "1" || process.env.PI_WEB_SURF_SCOUT === "1";

export default function piInternet(pi: ExtensionAPI) {
  // Config is loaded on-demand (never cached in closure) so session switches
  // always pick up changes. See REVIEW.md §1.1.
  function getConfig() { return loadConfig(); }

  function getSearchRouter() {
    const config = getConfig();
    return createSearchRouter({
      searchProviders: config.searchProviders,
      fallbackProviders: config.fallbackProviders,
    });
  }

  // Track whether web_research is enabled (hidden by default)
  let researchEnabled = false;
  let researchRegistered = false;
  let currentProvider: string | undefined;

  // Resolve extension directory for passing to subagent
  const extensionDir = dirname(fileURLToPath(import.meta.url));

  // Track current provider for scout model resolution
  pi.on("model_select", async (event) => {
    currentProvider = event.model.provider;
  });

  // Reset session-scoped state on session change.
  // /toggle-research is intentionally session-only.
  pi.on("session_start", async () => {
    resetProxyState();
    await resetSocksProxyDispatchers();
    researchEnabled = false;
    const active = pi.getActiveTools();
    if (active.includes("web_research")) {
      pi.setActiveTools(active.filter((name) => name !== "web_research"));
    }
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", async () => {
    resetProxyState();
    await resetSocksProxyDispatchers();
    clearCloneCache();
    researchEnabled = false;
    currentProvider = undefined;
    const active = pi.getActiveTools();
    if (active.includes("web_research")) {
      pi.setActiveTools(active.filter((name) => name !== "web_research"));
    }
  });

  // ── Tool 1: web_search ───────────────────────────────────────

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using configured providers. Returns relevant results with titles, URLs, and snippets. Leave provider unset unless the user explicitly requests a specific search engine.",
    promptSnippet: "Search the web and return results with titles, URLs, and snippets",
    promptGuidelines: [
      "Use web_search when you need to find information, documentation, or current data from the internet.",
      "Be specific in queries — include library names, version numbers, or error messages for better results.",
      "Do not set provider unless the user explicitly asks for a specific search engine. Prefer leaving it unset so configured providers can be used automatically.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "What to search for. Be specific and descriptive." }),
      numResults: Type.Optional(
        Type.Number({ description: `Number of results to return (default ${DEFAULT_NUM_RESULTS}, max ${MAX_NUM_RESULTS})` }),
      ),
      freshness: Type.Optional(
        StringEnum(["day", "week", "month", "year"] as const, {
          description: "Filter by recency",
        }),
      ),
      provider: Type.Optional(
        Type.String({ description: "Optional override. Only set this if the user explicitly requests a specific provider (brave, kagi, tavily). Otherwise leave unset." }),
      ),
    }),

    prepareArguments(args) { return args; },

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: {} };
      }

      const numResults = Math.min(Math.max(params.numResults ?? DEFAULT_NUM_RESULTS, 1), MAX_NUM_RESULTS);

      onUpdate?.({
        content: [{ type: "text", text: `Searching for "${params.query}"...` }],
        details: { status: "searching" },
      });

      const { results, provider, errors } = await getSearchRouter().search({
        query: params.query,
        numResults,
        freshness: params.freshness,
        provider: params.provider,
        signal: signal ?? undefined,
      });

      const text = formatResults(results);

      return {
        content: [{ type: "text", text }],
        details: {
          provider,
          resultCount: results.length,
          query: params.query,
          errors: errors.length > 0 ? errors : undefined,
          items: results,
        },
      };
    },

    renderCall(args, theme) {
      const query = typeof args.query === "string" ? args.query : "...";
      const display = query.length > 60 ? query.slice(0, 57) + "..." : query;
      let text = theme.fg("toolTitle", theme.bold("web_search "));
      text += theme.fg("accent", `"${display}"`);
      if (args.provider) text += theme.fg("muted", ` via ${args.provider}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Searching..."), 0, 0);
      }

      const details = result.details as {
        resultCount?: number;
        provider?: string;
        errors?: string[];
        items?: { title: string; url: string }[];
      };

      if (result.isError) {
        const content = result.content.find((c) => c.type === "text");
        return new Text(theme.fg("error", `✗ ${content?.type === "text" ? content.text : "Search failed"}`), 0, 0);
      }

      let text = theme.fg("success", `${details.resultCount ?? 0} results`);
      text += theme.fg("muted", ` via ${details.provider ?? "unknown"}`);

      if (details.errors?.length) {
        text += theme.fg("warning", ` (${details.errors.length} provider error(s))`);
      }

      if (!expanded) {
        if (details.items?.length) {
          for (const item of details.items) {
            text += `\n  ${theme.fg("toolOutput", item.title)}`;
            text += `  ${theme.fg("muted", item.url)}`;
          }
        }
        text += `\n\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
        return new Text(text, 0, 0);
      }

      // Expanded: show full results
      const content = result.content.find((c) => c.type === "text");
      if (content?.type === "text") {
        text += "\n\n" + theme.fg("toolOutput", content.text);
      }
      return new Text(text, 0, 0);
    },
  });

  // ── Tool 2: fetch_url (stub for Phase 2) ─────────────────────

  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description:
      "Fetch a URL and return clean, readable markdown content. " +
      "Handles GitHub repos (cloned locally), Reddit threads, Twitter/X profiles, " +
      "YouTube transcripts, PDFs, and regular web pages.",
    promptSnippet: "Fetch a URL and return clean markdown content",
    promptGuidelines: [
      "Use fetch_url to retrieve the content of a specific URL.",
      "For Reddit and Twitter/X URLs, this tool returns structured, token-efficient content via privacy proxies.",
      "For GitHub URLs, the repo is cloned locally — you can then use read and bash on the local path.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      selector: Type.Optional(
        Type.String({ description: "CSS selector to narrow extraction (e.g. 'main', '.docs-content')" }),
      ),
      includeLinks: Type.Optional(
        Type.Boolean({ description: "Keep hyperlinks in output (default: false, saves tokens)" }),
      ),
      verbose: Type.Optional(
        Type.Boolean({ description: "Full content: deeper Reddit comments, untruncated tweets" }),
      ),
      maxComments: Type.Optional(
        Type.Integer({ description: "Limit top-level comments for Reddit threads", minimum: 1 }),
      ),
    }),

    prepareArguments(args) { return args; },

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: { url: params.url } };
      }

      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${params.url}...` }],
        details: { status: "fetching" },
      });

      const result = await fetchUrl(params.url, getConfig(), {
        selector: params.selector,
        includeLinks: params.includeLinks,
        verbose: params.verbose,
        maxComments: params.maxComments,
        signal: signal ?? undefined,
      });

      if (result.error && !result.content) {
        throw new Error(result.error);
      }

      let text = "";
      if (result.title) text += `# ${result.title}\n\n`;
      text += result.content;
      if (result.error) text += `\n\n> ⚠️ ${result.error}`;

      return {
        content: [{ type: "text", text }],
        details: {
          url: result.url,
          title: result.title,
          truncated: result.truncated,
          error: result.error,
        },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("fetch_url "));
      text += theme.fg("accent", args.url || "...");
      if (args.selector) text += theme.fg("muted", ` → ${args.selector}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { url?: string; title?: string; error?: string };
      if (details?.error || result.isError) {
        return new Text(theme.fg("error", `✗ ${details?.error ?? "Fetch failed"}`), 0, 0);
      }
      let text = theme.fg("success", "✓ ");
      if (details?.title) text += theme.fg("toolTitle", details.title) + " ";
      if (!expanded) {
        text += `\n\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;  
        return new Text(text, 0, 0);
      }
      const content = result.content.find((c) => c.type === "text");
      if (content?.type === "text") {
        text += "\n\n" + theme.fg("toolOutput", content.text.slice(0, 2000));
      }
      return new Text(text, 0, 0);
    },
  });

  // ── Commands ──────────────────────────────────────────────────

  pi.registerCommand("search-providers", {
    description: "List configured search providers and their status",
    handler: async (_args, ctx) => {
      const providers = getSearchRouter().listProviders();
      const lines = providers.map((p) => {
        const status = p.available ? "✓" : "✗";
        return `  ${status} ${p.name} (${p.role})`;
      });
      ctx.ui.notify(`Search providers:\n${lines.join("\n")}`, "info");
    },
  });

  pi.registerCommand("kagi-login", {
    description: "Set Kagi session token for authentication",
    handler: async (_args, ctx) => {
      const hasToken = Boolean(getKagiToken());
      const token = await ctx.ui.input(
        "Enter your Kagi session token:",
        hasToken ? "Current token set (enter new to change)" : "Get token from kagi.com/settings?p=token",
      );
      if (!token) {
        ctx.ui.notify("Login cancelled", "warning");
        return;
      }
      try {
        setKagiToken(token);
        ctx.ui.notify("Kagi session token saved", "info");
      } catch (err) {
        ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("toggle-research", {
    description: "Show or hide the web_research tool for the current session",
    handler: async (_args, ctx) => {
      researchEnabled = !researchEnabled;

      if (researchEnabled) {
        // Register lazily on first enable (avoids race — see REVIEW.md §1.3)
        if (!researchRegistered && !IS_SCOUT) {
          registerWebResearchTool();
          researchRegistered = true;
        }
        const active = new Set(pi.getActiveTools());
        active.add("web_research");
        pi.setActiveTools(Array.from(active));
        ctx.ui.notify("web_research tool enabled for this session", "info");
      } else {
        // Remove web_research from active tools
        const active = pi.getActiveTools().filter((n) => n !== "web_research");
        pi.setActiveTools(active);
        ctx.ui.notify("web_research tool disabled for this session", "info");
      }
    },
  });

  // ── Tool 3: web_research (registered lazily via /toggle-research) ──
  // Skip in scout subagent to prevent infinite recursion.
  // Registered on first enable to avoid the briefly-visible race (REVIEW §1.3).

  function registerWebResearchTool() {
    pi.registerTool({
    name: "web_research",
    label: "Web Research",
    description:
      "Research a topic using a scout subagent with an isolated context window. " +
      "The scout searches the web and fetches pages, returning only relevant findings. " +
      "Noise stays in the scout's disposable context and never enters your main session.",
    promptSnippet: "Research a topic with a scout subagent that keeps noise out of your context",
    promptGuidelines: [
      "Use web_research for complex multi-source investigations where you need to search and read multiple pages without polluting your main context.",
      "Provide a specific task description so the scout knows what information to extract and what to discard.",
    ],

    prepareArguments(args) { return args; },

    parameters: Type.Object({
      task: Type.String({
        description: "What you need to know. Be specific — the scout uses this to decide what's relevant.",
      }),
      urls: Type.Optional(
        Type.Array(Type.String(), { description: "Specific URLs to research" }),
      ),
      query: Type.Optional(
        Type.String({ description: "Search query for web search" }),
      ),
      model: Type.Optional(
        Type.String({ description: "Model for the scout (default: auto-detected cheap model)" }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const model = resolveScoutModel(params.model, currentProvider);
      const hasUrls = params.urls && params.urls.length > 0;
      const hasQuery = Boolean(params.query);

      if (!hasUrls && !hasQuery) {
        throw new Error("Provide at least `urls` or `query` (or both).");
      }

      // Check if search is available for the scout
      const hasSearch = getSearchRouter().listProviders().some(
        (p) => p.available && p.role !== "unused",
      );
      if (hasQuery && !hasSearch) {
        throw new Error(
          `No search provider available for query "${params.query}". Provide explicit URLs or configure a search provider.`,
        );
      }

      const systemPrompt = buildScoutPrompt(params.task, hasSearch, params.urls, params.query);

      onUpdate?.({
        content: [{
          type: "text",
          text: `Researching ${hasQuery ? `"${params.query}"` : ""}${hasUrls ? ` + ${params.urls!.length} URL(s)` : ""} with ${model}...`,
        }],
        details: { status: "running", model },
      });

      let taskText = `Research task: ${params.task}`;
      if (hasUrls) taskText += `\n\nURLs to read:\n${params.urls!.map((u, i) => `  ${i + 1}. ${u}`).join("\n")}`;
      if (hasQuery) taskText += `\n\nSearch query: ${params.query}`;

      const result = await runScout(
        taskText,
        systemPrompt,
        model,
        extensionDir,
        ctx.cwd,
        signal ?? undefined,
        (text) => {
          onUpdate?.({
            content: [{ type: "text", text }],
            details: { status: "running", model },
          });
        },
      );

      if (result.exitCode !== 0) {
        throw new Error(result.error || result.output || "Research failed");
      }

      const usageLine = [
        `${result.usage.turns} turns`,
        `↑${result.usage.input} ↓${result.usage.output}`,
        `$${result.usage.cost.toFixed(4)}`,
        result.usage.model ?? model,
      ].join(" | ");

      return {
        content: [{ type: "text", text: result.output || "(no output)" }],
        details: {
          model: result.usage.model ?? model,
          status: "done",
          usage: result.usage,
          usageSummary: usageLine,
        },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web_research "));
      if (args.query) text += theme.fg("accent", `"${args.query}"`);
      if (args.urls?.length) {
        if (args.query) text += " + ";
        text += theme.fg("accent", `${args.urls.length} URL(s)`);
      }
      const taskPreview = (args.task ?? "").slice(0, 60);
      text += "\n  " + theme.fg("dim", taskPreview + ((args.task?.length ?? 0) > 60 ? "..." : ""));
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        const content = result.content[0];
        const preview = content?.type === "text" ? content.text.slice(0, 200) : "...";
        return new Text(theme.fg("warning", "⏳ ") + theme.fg("dim", preview), 0, 0);
      }
      if (result.isError) {
        const errText = result.content.find((c) => c.type === "text");
        return new Text(theme.fg("error", `✗ ${errText?.type === "text" ? errText.text : "Research failed"}`), 0, 0);
      }
      const details = result.details as { usageSummary?: string } | undefined;
      let text = theme.fg("success", "✓ Research complete");
      if (details?.usageSummary) text += theme.fg("muted", ` (${details.usageSummary})`);
      if (expanded) {
        const content = result.content.find((c) => c.type === "text");
        if (content?.type === "text") text += "\n\n" + theme.fg("toolOutput", content.text);
      }
      return new Text(text, 0, 0);
    },
    });
  } // end registerWebResearchTool
}
