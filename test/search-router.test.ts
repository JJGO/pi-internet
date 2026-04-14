import assert from "node:assert/strict";
import test from "node:test";
import { createSearchRouter } from "../src/search/router.ts";
import type { SearchProvider, SearchResult } from "../src/search/types.ts";

function makeProvider(
  name: string,
  options: {
    available?: boolean;
    onSearch?: () => Promise<SearchResult[]> | SearchResult[];
  } = {},
): SearchProvider {
  return {
    name,
    isAvailable() {
      return options.available ?? true;
    },
    async search() {
      if (!options.onSearch) return [];
      return await options.onSearch();
    },
  };
}

test("createSearchRouter: falls back when all primaries fail", async () => {
  const providers = {
    alpha: makeProvider("alpha", { onSearch: async () => { throw new Error("alpha down"); } }),
    beta: makeProvider("beta", { onSearch: async () => { throw new Error("beta down"); } }),
    gamma: makeProvider("gamma", {
      onSearch: () => [{ title: "Result", url: "https://example.com", snippet: "ok", provider: "gamma" }],
    }),
  };

  const router = createSearchRouter(
    { searchProviders: ["alpha", "beta"], fallbackProviders: ["gamma"] },
    providers,
  );

  const result = await router.search({ query: "test", numResults: 5 });
  assert.equal(result.provider, "gamma (fallback)");
  assert.equal(result.results.length, 1);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /alpha/);
  assert.match(result.errors[1], /beta/);
});

test("createSearchRouter: merges successful primaries and preserves provider errors", async () => {
  const providers = {
    alpha: makeProvider("alpha", {
      onSearch: () => [
        { title: "A1", url: "https://a.example/1", snippet: "a1", provider: "alpha" },
        { title: "A2", url: "https://shared.example", snippet: "short", provider: "alpha" },
      ],
    }),
    beta: makeProvider("beta", {
      onSearch: () => [
        { title: "B1", url: "https://b.example/1", snippet: "b1", provider: "beta" },
        { title: "A2", url: "https://shared.example", snippet: "much longer shared snippet", provider: "beta" },
      ],
    }),
    gamma: makeProvider("gamma", { onSearch: async () => { throw new Error("gamma failed"); } }),
  };

  const router = createSearchRouter(
    { searchProviders: ["alpha", "beta", "gamma"], fallbackProviders: [] },
    providers,
  );

  const result = await router.search({ query: "test", numResults: 10 });
  assert.equal(result.provider, "alpha+beta");
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].title, "A1");
  assert.equal(result.results[1].title, "B1");
  assert.equal(result.results[2].snippet, "much longer shared snippet");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /gamma/);
});

test("createSearchRouter: provider override uses only the requested provider", async () => {
  let alphaCalls = 0;
  let betaCalls = 0;

  const providers = {
    alpha: makeProvider("alpha", {
      onSearch: () => {
        alphaCalls++;
        return [{ title: "Alpha", url: "https://alpha.example", snippet: "alpha" }];
      },
    }),
    beta: makeProvider("beta", {
      onSearch: () => {
        betaCalls++;
        return [{ title: "Beta", url: "https://beta.example", snippet: "beta" }];
      },
    }),
  };

  const router = createSearchRouter(
    { searchProviders: ["alpha"], fallbackProviders: ["beta"] },
    providers,
  );

  const result = await router.search({ query: "test", provider: "beta" });
  assert.equal(result.provider, "beta");
  assert.equal(result.results[0].title, "Beta");
  assert.equal(alphaCalls, 0);
  assert.equal(betaCalls, 1);
});
