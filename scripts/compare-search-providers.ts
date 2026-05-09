import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { brave } from "../src/search/providers/brave.ts";
import { kagi } from "../src/search/providers/kagi.ts";
import { tavily } from "../src/search/providers/tavily.ts";
import type { SearchOptions, SearchProvider, SearchResult } from "../src/search/types.ts";
import { fetchWithProxy } from "../src/util/proxy.ts";

interface QuerySpec {
  id: string;
  label: string;
  query: string;
  freshness?: SearchOptions["freshness"];
}

interface ProviderRun {
  provider: string;
  available: boolean;
  status: "ok" | "skipped" | "error";
  durationMs: number;
  resultCount: number;
  results: SearchResult[];
  error?: string;
}

interface QueryComparison {
  query: QuerySpec;
  runs: ProviderRun[];
  uniqueUrlCount: number;
  overlapMatrix: Record<string, Record<string, number>>;
}

interface ComparisonReport {
  generatedAt: string;
  sessionId: string;
  numResults: number;
  outputDir: string;
  queries: QuerySpec[];
  comparisons: QueryComparison[];
}

interface CliOptions {
  numResults: number;
  outputDir: string;
  providerNames?: string[];
  queries: QuerySpec[];
}

const DEFAULT_NUM_RESULTS = 5;

const DEFAULT_QUERIES: QuerySpec[] = [
  {
    id: "docs-react-useeffect-cleanup",
    label: "Official docs lookup",
    query: "React useEffect cleanup docs",
  },
  {
    id: "tech-pytorch-fsdp-offload",
    label: "Niche technical query",
    query: "PyTorch FSDP CPU offload",
  },
  {
    id: "policy-eu-ai-act-deadlines",
    label: "Policy / compliance query",
    query: "EU AI Act startup deadlines",
  },
  {
    id: "company-parallel-benchmark",
    label: "Company / product lookup",
    query: "Parallel Web Systems benchmark",
  },
  {
    id: "news-ai-model-releases",
    label: "Fresh news query",
    query: "AI model releases April 2026",
    freshness: "month",
  },
];

function createParallelProvider(sessionId: string): SearchProvider {
  return {
    name: "parallel",

    isAvailable() {
      return true;
    },

    async search(options: SearchOptions): Promise<SearchResult[]> {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };

      const apiKey = process.env.PARALLEL_API_KEY;
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      const objective = options.freshness
        ? `${options.query}. Prioritize results from the last ${options.freshness}.`
        : options.query;

      const response = await fetchWithProxy("https://search.parallel.ai/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "tools/call",
          params: {
            name: "web_search",
            arguments: {
              objective,
              search_queries: [trimTo(options.query, 100)],
              session_id: sessionId,
            },
          },
        }),
        signal: options.signal,
      });

      if (!response.ok) {
        throw new Error(`Parallel MCP HTTP ${response.status}: ${await response.text()}`);
      }

      const payload = await response.json() as {
        error?: { message?: string };
        result?: {
          content?: Array<{ type?: string; text?: string }>;
        };
      };

      if (payload.error) {
        throw new Error(payload.error.message ?? "Parallel MCP returned an error");
      }

      const rawText = payload.result?.content?.find((part) => part.type === "text")?.text;
      if (!rawText) {
        throw new Error("Parallel MCP did not return text content");
      }

      let parsed: {
        results?: Array<{
          url: string;
          title?: string | null;
          publish_date?: string | null;
          excerpts?: string[];
        }>;
      };
      try {
        parsed = JSON.parse(rawText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse Parallel MCP response JSON: ${message}`);
      }

      return (parsed.results ?? []).map((result) => ({
        title: result.title ?? "",
        url: result.url,
        snippet: (result.excerpts ?? []).join("\n\n"),
        publishedDate: result.publish_date ?? undefined,
        provider: "parallel",
      }));
    },
  };
}

function parseArgs(argv: string[]): CliOptions {
  const customQueries: QuerySpec[] = [];
  let numResults = DEFAULT_NUM_RESULTS;
  let outputDir = defaultOutputDir();
  let providerNames: string[] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--num-results") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --num-results");
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid --num-results value: ${value}`);
      }
      numResults = parsed;
      continue;
    }

    if (arg === "--out-dir") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --out-dir");
      outputDir = resolve(value);
      continue;
    }

    if (arg === "--providers") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --providers");
      providerNames = value
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
      continue;
    }

    if (arg === "--query") {
      const value = argv[++i];
      if (!value) throw new Error("Missing value for --query");
      customQueries.push({
        id: `custom-${customQueries.length + 1}-${slugify(value)}`,
        label: `Custom query ${customQueries.length + 1}`,
        query: value,
      });
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    numResults,
    outputDir,
    providerNames,
    queries: customQueries.length > 0 ? customQueries : DEFAULT_QUERIES,
  };
}

function printHelp(): void {
  console.log(`compare-search-providers

Usage:
  npx tsx scripts/compare-search-providers.ts [options]

Options:
  --providers brave,kagi,tavily,parallel   Limit the comparison to specific providers
  --query "..."                            Add a custom query (repeatable)
  --num-results 5                          Number of results to request from each provider
  --out-dir .tmp/my-run                    Directory for raw results and markdown summary
  --help                                   Show this help

If no --query arguments are provided, the script runs a built-in representative query set.`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.outputDir, { recursive: true });

  const sessionId = randomUUID();
  const providers = resolveProviders(sessionId, options.providerNames);

  if (providers.length === 0) {
    throw new Error("No matching providers selected.");
  }

  console.log(`Comparing providers: ${providers.map((provider) => provider.name).join(", ")}`);
  console.log(`Queries: ${options.queries.length}`);
  console.log(`Results per provider: ${options.numResults}`);
  console.log(`Output directory: ${options.outputDir}`);

  const comparisons: QueryComparison[] = [];

  for (let index = 0; index < options.queries.length; index++) {
    const query = options.queries[index];
    console.log(`\n[${index + 1}/${options.queries.length}] ${query.label}: ${query.query}`);

    const runs = await Promise.all(
      providers.map((provider) => runProvider(provider, query, options.numResults)),
    );

    for (const run of runs) {
      if (run.status === "ok") {
        console.log(`  ${padRight(run.provider, 8)} ok       ${String(run.resultCount).padStart(2)} results  ${formatDuration(run.durationMs)}`);
      } else if (run.status === "skipped") {
        console.log(`  ${padRight(run.provider, 8)} skipped  ${run.error ?? "not configured"}`);
      } else {
        console.log(`  ${padRight(run.provider, 8)} error    ${run.error ?? "unknown error"}`);
      }
    }

    const comparison: QueryComparison = {
      query,
      runs,
      uniqueUrlCount: countUniqueUrls(runs),
      overlapMatrix: buildOverlapMatrix(runs),
    };

    comparisons.push(comparison);
    writeQueryArtifacts(options.outputDir, comparison);
  }

  const report: ComparisonReport = {
    generatedAt: new Date().toISOString(),
    sessionId,
    numResults: options.numResults,
    outputDir: options.outputDir,
    queries: options.queries,
    comparisons,
  };

  writeFileSync(join(options.outputDir, "summary.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(options.outputDir, "summary.md"), renderMarkdownReport(report));

  console.log("\nSummary:");
  printConsoleSummary(comparisons);
  console.log(`\nWrote summary.json and summary.md to ${options.outputDir}`);
}

function resolveProviders(sessionId: string, requestedNames?: string[]): SearchProvider[] {
  const allProviders: SearchProvider[] = [
    brave,
    kagi,
    tavily,
    createParallelProvider(sessionId),
  ];

  if (!requestedNames || requestedNames.length === 0) {
    return allProviders;
  }

  const requested = new Set(requestedNames);
  return allProviders.filter((provider) => requested.has(provider.name));
}

async function runProvider(
  provider: SearchProvider,
  query: QuerySpec,
  numResults: number,
): Promise<ProviderRun> {
  if (!provider.isAvailable()) {
    return {
      provider: provider.name,
      available: false,
      status: "skipped",
      durationMs: 0,
      resultCount: 0,
      results: [],
      error: "not configured",
    };
  }

  const startedAt = Date.now();
  try {
    const results = await provider.search({
      query: query.query,
      numResults,
      freshness: query.freshness,
    });
    const limitedResults = results.slice(0, numResults);

    return {
      provider: provider.name,
      available: true,
      status: "ok",
      durationMs: Date.now() - startedAt,
      resultCount: limitedResults.length,
      results: limitedResults,
    };
  } catch (error) {
    return {
      provider: provider.name,
      available: true,
      status: "error",
      durationMs: Date.now() - startedAt,
      resultCount: 0,
      results: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function writeQueryArtifacts(outputDir: string, comparison: QueryComparison): void {
  const queryDir = join(outputDir, comparison.query.id);
  mkdirSync(queryDir, { recursive: true });

  writeFileSync(
    join(queryDir, "query.json"),
    JSON.stringify(
      {
        query: comparison.query,
        uniqueUrlCount: comparison.uniqueUrlCount,
        overlapMatrix: comparison.overlapMatrix,
      },
      null,
      2,
    ),
  );

  for (const run of comparison.runs) {
    writeFileSync(join(queryDir, `${run.provider}.json`), JSON.stringify(run, null, 2));
  }
}

function countUniqueUrls(runs: ProviderRun[]): number {
  const urls = new Set<string>();
  for (const run of runs) {
    if (run.status !== "ok") continue;
    for (const result of run.results) {
      urls.add(canonicalizeUrl(result.url));
    }
  }
  return urls.size;
}

function buildOverlapMatrix(runs: ProviderRun[]): Record<string, Record<string, number>> {
  const okRuns = runs.filter((run) => run.status === "ok");
  const urlSets = new Map<string, Set<string>>(
    okRuns.map((run) => [
      run.provider,
      new Set(run.results.map((result) => canonicalizeUrl(result.url))),
    ]),
  );

  const matrix: Record<string, Record<string, number>> = {};
  for (const runA of okRuns) {
    matrix[runA.provider] = {};
    for (const runB of okRuns) {
      const urlsA = urlSets.get(runA.provider) ?? new Set<string>();
      const urlsB = urlSets.get(runB.provider) ?? new Set<string>();
      matrix[runA.provider][runB.provider] = countIntersection(urlsA, urlsB);
    }
  }

  return matrix;
}

function countIntersection(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const value of a) {
    if (b.has(value)) count++;
  }
  return count;
}

function canonicalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.hash = "";

    const keptParams = [...url.searchParams.entries()]
      .filter(([key]) => !key.toLowerCase().startsWith("utm_"))
      .sort(([a], [b]) => a.localeCompare(b));

    url.search = "";
    for (const [key, value] of keptParams) {
      url.searchParams.append(key, value);
    }

    const normalizedPath = url.pathname.endsWith("/") && url.pathname !== "/"
      ? url.pathname.slice(0, -1)
      : url.pathname;

    return `${url.protocol}//${url.hostname.toLowerCase()}${normalizedPath}${url.search}`;
  } catch {
    return input.trim();
  }
}

function renderMarkdownReport(report: ComparisonReport): string {
  const lines: string[] = [];

  lines.push("# Search provider comparison");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Session ID: \`${report.sessionId}\``);
  lines.push(`- Results requested per provider: ${report.numResults}`);
  lines.push(`- Output directory: \`${report.outputDir}\``);
  lines.push("");
  lines.push("## Query status summary");
  lines.push("");

  const providerOrder = unique(report.comparisons.flatMap((comparison) => comparison.runs.map((run) => run.provider)));
  const summaryHeader = ["Query", ...providerOrder];
  const summaryRows = report.comparisons.map((comparison) => {
    const cells = [comparison.query.query];
    for (const provider of providerOrder) {
      const run = comparison.runs.find((entry) => entry.provider === provider);
      cells.push(formatSummaryCell(run));
    }
    return cells;
  });

  lines.push(renderMarkdownTable(summaryHeader, summaryRows));

  for (const comparison of report.comparisons) {
    lines.push("");
    lines.push(`## ${comparison.query.label}`);
    lines.push("");
    lines.push(`- Query: \`${comparison.query.query}\``);
    if (comparison.query.freshness) {
      lines.push(`- Freshness: \`${comparison.query.freshness}\``);
    }
    lines.push(`- Unique URLs across providers: ${comparison.uniqueUrlCount}`);

    const overlapProviders = Object.keys(comparison.overlapMatrix);
    if (overlapProviders.length > 0) {
      lines.push("");
      lines.push("### URL overlap");
      lines.push("");
      const overlapHeader = ["Provider", ...overlapProviders];
      const overlapRows = overlapProviders.map((providerA) => [
        providerA,
        ...overlapProviders.map((providerB) => String(comparison.overlapMatrix[providerA][providerB] ?? 0)),
      ]);
      lines.push(renderMarkdownTable(overlapHeader, overlapRows));
    }

    for (const run of comparison.runs) {
      lines.push("");
      lines.push(`### ${run.provider}`);
      lines.push("");
      lines.push(`- Status: ${run.status}`);
      lines.push(`- Duration: ${formatDuration(run.durationMs)}`);
      if (run.status === "ok") {
        lines.push(`- Result count: ${run.resultCount}`);
        lines.push("");
        if (run.results.length === 0) {
          lines.push("No results returned.");
        } else {
          run.results.forEach((result, index) => {
            lines.push(`${index + 1}. [${escapeMarkdownLinkText(result.title || result.url)}](${result.url})`);
            const meta: string[] = [];
            if (result.publishedDate) meta.push(result.publishedDate);
            meta.push(hostnameFromUrl(result.url));
            lines.push(`   - ${meta.join(" • ")}`);
            if (result.snippet.trim()) {
              lines.push(`   - ${collapseWhitespace(result.snippet, 320)}`);
            }
          });
        }
      } else if (run.error) {
        lines.push(`- Error: ${run.error}`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

function renderMarkdownTable(header: string[], rows: string[][]): string {
  const escapedHeader = header.map(escapeMarkdownCell);
  const escapedRows = rows.map((row) => row.map(escapeMarkdownCell));
  return [
    `| ${escapedHeader.join(" | ")} |`,
    `| ${escapedHeader.map(() => "---").join(" | ")} |`,
    ...escapedRows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function printConsoleSummary(comparisons: QueryComparison[]): void {
  const providerOrder = unique(comparisons.flatMap((comparison) => comparison.runs.map((run) => run.provider)));
  const rows: string[][] = [
    ["query", ...providerOrder],
    ...comparisons.map((comparison) => [
      truncate(comparison.query.query, 34),
      ...providerOrder.map((provider) => formatSummaryCell(comparison.runs.find((run) => run.provider === provider))),
    ]),
  ];

  const widths = rows[0].map((_, columnIndex) => Math.max(...rows.map((row) => row[columnIndex].length)));

  for (const row of rows) {
    console.log(row.map((cell, index) => padRight(cell, widths[index])).join("  "));
  }
}

function formatSummaryCell(run: ProviderRun | undefined): string {
  if (!run) return "-";
  if (run.status === "ok") return `${run.resultCount} @ ${formatDuration(run.durationMs)}`;
  if (run.status === "skipped") return "skipped";
  return "error";
}

function hostnameFromUrl(input: string): string {
  try {
    return new URL(input).hostname;
  } catch {
    return input;
  }
}

function defaultOutputDir(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(join(".tmp", "compare-search-providers", timestamp));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "query";
}

function trimTo(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function collapseWhitespace(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return truncate(collapsed, maxLength);
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[\[\]]/g, "\\$&");
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(2)}s`;
}

function padRight(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

await main();
