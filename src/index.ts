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

import { type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum, complete, type UserMessage } from "@earendil-works/pi-ai";
import { loadConfig } from "./config.js";
import { createSearchRouter } from "./search/router.js";
import { resetSearchProviderState } from "./search/state.js";
import { formatResults, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS } from "./search/types.js";
import { setKagiToken, getKagiToken } from "./search/providers/kagi.js";
import { fetchUrl, resetProxyState } from "./fetch/router.js";
import { clearCloneCache } from "./fetch/github.js";
import { runScout, resolveScoutModel, buildScoutPrompt } from "./research/scout.js";
import { resetSocksProxyDispatchers } from "./util/proxy.js";
import { throwTruncatedToolError, truncateToolText } from "./util/truncation.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const IS_SCOUT = process.env.PI_INTERNET_SCOUT === "1";
const OFFLINE_WARNING = "pi-internet disabled because PI_OFFLINE=1";

function isOfflineModeEnabled(): boolean {
  const value = process.env.PI_OFFLINE?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

const DESCRIPTION_CLEANUP_PROMPT = `Clean this YouTube video description for an AI coding agent.

Keep:
- concise summary/context
- important links only if they identify a referenced resource
- chapter-like or source-like information if useful

Remove:
- subscribe/follow/patreon/discord/merch boilerplate
- sponsor/affiliate/code spam unless central to the video
- repeated social links
- generic legal/footer noise
- long URL dumps

Return plain markdown, max ~2000 characters. If nothing useful remains, return an empty string.`;

export default function piInternet(pi: ExtensionAPI) {
  if (isOfflineModeEnabled()) {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(OFFLINE_WARNING, "warning");
      } else {
        console.warn(`[pi-internet] ${OFFLINE_WARNING}`);
      }
    });
    return;
  }

  // Config is loaded on-demand (never cached in closure) so session switches
  // always pick up changes.
  function getConfig() { return loadConfig(); }

  function getSearchRouter() {
    const config = getConfig();
    return createSearchRouter({
      searchProviders: config.searchProviders,
      fallbackProviders: config.fallbackProviders,
    });
  }

  async function cleanYouTubeDescription(
    description: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!ctx.model) throw new Error("No active model for YouTube description cleanup");

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok || !auth.apiKey) {
      throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
    }

    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: description }],
      timestamp: Date.now(),
    };

    const response = await complete(
      ctx.model,
      { systemPrompt: DESCRIPTION_CLEANUP_PROMPT, messages: [userMessage] },
      { apiKey: auth.apiKey, headers: auth.headers, signal },
    );

    if (response.stopReason === "aborted" || response.stopReason === "error") {
      throw new Error(response.errorMessage ?? "Description cleanup failed");
    }

    return response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
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
    resetSearchProviderState();
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
    resetSearchProviderState();
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
      "Search the web using configured providers. Returns relevant results with titles, URLs, and snippets. " +
      "Leave provider unset unless the user explicitly requests a specific search engine. " +
      "Output is truncated to 50KB or 2000 lines, whichever is hit first.",
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

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: {} };
      }

      const numResults = Math.min(Math.max(params.numResults ?? DEFAULT_NUM_RESULTS, 1), MAX_NUM_RESULTS);

      onUpdate?.({
        content: [{ type: "text", text: "Searching the web..." }],
        details: { status: "searching" },
      });

      const { results, provider, errors, warnings } = await getSearchRouter().search({
        query: params.query,
        numResults,
        freshness: params.freshness,
        provider: params.provider,
        signal: signal ?? undefined,
      }).catch(throwTruncatedToolError);

      const output = await truncateToolText(formatResults(results), {
        continuation: "Refine the query or request fewer results to see omitted content.",
      });

      return {
        content: [{ type: "text", text: output.text }],
        details: {
          provider,
          resultCount: results.length,
          query: params.query,
          errors: errors.length > 0 ? errors : undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
          items: results,
          truncation: output.truncation,
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
        warnings?: string[];
        items?: { title: string; url: string }[];
      };

      if (result.isError) {
        const content = result.content.find((c) => c.type === "text");
        return new Text(theme.fg("error", `✗ ${content?.type === "text" ? content.text : "Search failed"}`), 0, 0);
      }

      let text = theme.fg("success", `${details.resultCount ?? 0} results`);
      text += theme.fg("muted", ` via ${details.provider ?? "unknown"}`);

      const badges: string[] = [];
      if (details.errors?.length) badges.push(`${details.errors.length} provider error(s)`);
      if (details.warnings?.length) badges.push(`${details.warnings.length} warning${details.warnings.length === 1 ? "" : "s"}`);
      if (badges.length > 0) {
        text += theme.fg("warning", ` (${badges.join(", ")})`);
      }

      if (!expanded) {
        if (details.warnings?.length) {
          text += `\n${theme.fg("muted", details.warnings[0])}`;
        }
        if (details.items?.length) {
          for (const item of details.items) {
            text += `\n  ${theme.fg("toolOutput", item.title)}`;
            text += `  ${theme.fg("muted", item.url)}`;
          }
        }
        text += `\n\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
        return new Text(text, 0, 0);
      }

      if (details.warnings?.length) {
        text += "\n" + details.warnings.map((warning) => theme.fg("warning", `• ${warning}`)).join("\n");
      }
      if (details.errors?.length) {
        text += "\n" + details.errors.map((error) => theme.fg("muted", `• ${error}`)).join("\n");
      }

      const content = result.content.find((c) => c.type === "text");
      if (content?.type === "text") {
        text += "\n\n" + theme.fg("toolOutput", content.text);
      }
      return new Text(text, 0, 0);
    },
  });

  // ── Tool 2: fetch_url ───────────────────────────────────────

  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description:
      "Fetch a URL and return clean, readable markdown content. " +
      "Handles GitHub repos/files/PRs/issues/releases/Actions/gists, Reddit threads, Twitter/X profiles, " +
      "YouTube videos/playlists/channels, PDFs, and regular web pages. " +
      "Output is truncated to 50KB or 2000 lines; complete truncated output is saved to a temporary file.",
    promptSnippet: "Fetch a URL and return clean markdown content",
    promptGuidelines: [
      "Use fetch_url to retrieve the content of a specific URL.",
      "For Reddit and Twitter/X URLs, this tool returns structured, token-efficient content via privacy proxies.",
      "For GitHub repo/file/tree URLs, the repo is cloned locally — use read and bash on the local path. GitHub PRs/issues/releases/Actions/gists are fetched through GitHub-native APIs instead of HTML scraping.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      selector: Type.Optional(
        Type.String({ description: "CSS selector to narrow extraction (e.g. 'main', '.docs-content')" }),
      ),
      includeLinks: Type.Optional(
        Type.Boolean({ description: "Keep hyperlinks in output (default: true; set false for compact reading)" }),
      ),
      verbose: Type.Optional(
        Type.Boolean({ description: "Full content: all parsed Reddit comments/deeper replies, untruncated tweets" }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: { url: params.url } };
      }

      onUpdate?.({
        content: [{ type: "text", text: "Fetching URL..." }],
        details: { status: "fetching" },
      });

      const allowImages = ctx.model?.input.includes("image") ?? false;
      const result = await fetchUrl(params.url, getConfig(), {
        selector: params.selector,
        includeLinks: params.includeLinks,
        verbose: params.verbose,
        allowImages,
        cleanYouTubeDescription: async (description) => cleanYouTubeDescription(description, ctx, signal ?? undefined),
        signal: signal ?? undefined,
      });

      if (result.error && !result.content) {
        return throwTruncatedToolError(result.error);
      }

      let text = "";
      if (result.title) text += `# ${result.title}\n\n`;
      text += result.content;
      if (result.error) text += `\n\n> ⚠️ ${result.error}`;

      const output = await truncateToolText(text, {
        continuation: "Use the read tool on the full-output file to inspect omitted content.",
        fullOutput: result.fullOutputPath
          ? { existingPath: result.fullOutputPath }
          : { prefix: "pi-internet-fetch-", filename: "output.md" },
      });

      return {
        content: [
          { type: "text" as const, text: output.text },
          ...(result.images ?? []).map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ],
        details: {
          url: result.url,
          title: result.title,
          truncated: output.truncation?.truncated ?? false,
          fullOutputPath: output.fullOutputPath,
          error: result.error,
          imageCount: result.images?.length ?? 0,
          artifacts: result.artifacts,
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
      const details = result.details as {
        url?: string;
        title?: string;
        error?: string;
        truncated?: boolean;
      };
      if (details?.error || result.isError) {
        return new Text(theme.fg("error", `✗ ${details?.error ?? "Fetch failed"}`), 0, 0);
      }
      let text = theme.fg("success", "✓ ");
      if (details?.title) text += theme.fg("toolTitle", details.title) + " ";
      if (details?.truncated) text += theme.fg("warning", "(truncated)");
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
        const disabled = p.disabledForSession
          ? ` — disabled for session${p.disabledReason ? ` (${p.disabledReason})` : ""}`
          : "";
        return `  ${status} ${p.name} (${p.role})${disabled}`;
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
        // Register lazily on first enable so the tool is never briefly visible
        // before session_start hides it.
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

  function registerWebResearchTool() {
    pi.registerTool({
    name: "web_research",
    label: "Web Research",
    description:
      "Research a topic using a scout subagent with an isolated context window. " +
      "The scout searches the web and fetches pages, returning only relevant findings. " +
      "Noise stays in the scout's disposable context and never enters your main session. " +
      "Reports are truncated to 50KB or 2000 lines; complete truncated reports are saved to a temporary file.",
    promptSnippet: "Research a topic with a scout subagent that keeps noise out of your context",
    promptGuidelines: [
      "Use web_research for complex multi-source investigations where you need to search and read multiple pages without polluting your main context.",
      "Provide a specific task description so the scout knows what information to extract and what to discard.",
    ],

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
        return throwTruncatedToolError("Provide at least `urls` or `query` (or both).");
      }

      // Check if search is available for the scout
      const hasSearch = getSearchRouter().listProviders().some(
        (p) => p.available && p.role !== "unused",
      );
      if (hasQuery && !hasSearch) {
        return throwTruncatedToolError(
          `No search provider available for query "${params.query}". Provide explicit URLs or configure a search provider.`,
        );
      }

      const systemPrompt = buildScoutPrompt(params.task, hasSearch, params.urls, params.query);

      onUpdate?.({
        content: [{ type: "text", text: "Starting research scout..." }],
        details: { status: "running" },
      });

      let taskText = `Research task: ${params.task}`;
      if (hasUrls) taskText += `\n\nURLs to read:\n${params.urls!.map((u, i) => `  ${i + 1}. ${u}`).join("\n")}`;
      if (hasQuery) taskText += `\n\nSearch query: ${params.query}`;

      let completedTurns = 0;
      const result = await runScout(
        taskText,
        systemPrompt,
        model,
        extensionDir,
        ctx.cwd,
        signal ?? undefined,
        () => {
          completedTurns++;
          onUpdate?.({
            content: [{ type: "text", text: `Scout completed research turn ${completedTurns}; synthesizing findings...` }],
            details: { status: "running" },
          });
        },
      ).catch(throwTruncatedToolError);

      if (result.exitCode !== 0) {
        return throwTruncatedToolError(result.error || result.output || "Research failed");
      }

      const usageLine = [
        `${result.usage.turns} turns`,
        `↑${result.usage.input} ↓${result.usage.output}`,
        `$${result.usage.cost.toFixed(4)}`,
        result.usage.model ?? model,
      ].join(" | ");

      const output = await truncateToolText(result.output || "(no output)", {
        continuation: "Use the read tool on the full-report file to inspect omitted findings.",
        fullOutput: { prefix: "pi-internet-research-", filename: "report.md" },
      });

      return {
        content: [{ type: "text", text: output.text }],
        details: {
          model: result.usage.model ?? model,
          status: "done",
          usage: result.usage,
          usageSummary: usageLine,
          truncation: output.truncation,
          fullOutputPath: output.fullOutputPath,
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
      const details = result.details as { usageSummary?: string; truncation?: { truncated: boolean } } | undefined;
      let text = theme.fg("success", "✓ Research complete");
      if (details?.usageSummary) text += theme.fg("muted", ` (${details.usageSummary})`);
      if (details?.truncation?.truncated) text += theme.fg("warning", " (truncated)");
      if (expanded) {
        const content = result.content.find((c) => c.type === "text");
        if (content?.type === "text") text += "\n\n" + theme.fg("toolOutput", content.text);
      }
      return new Text(text, 0, 0);
    },
    });
  } // end registerWebResearchTool
}
