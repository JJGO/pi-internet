import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { SearchProviderError } from "../src/search/errors.ts";
import { createSearchRouter } from "../src/search/router.ts";
import {
  disableSearchProvider,
  getDisabledSearchProviders,
  resetSearchProviderState,
} from "../src/search/state.ts";
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

beforeEach(() => {
  resetSearchProviderState();
});

afterEach(() => {
  resetSearchProviderState();
});

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
  assert.equal(result.warnings.length, 0);
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
  assert.equal(result.warnings.length, 0);
  assert.match(result.errors[0], /gamma/);
});

test("createSearchRouter: fallback fills when primaries under-deliver", async () => {
  const providers = {
    alpha: makeProvider("alpha", {
      onSearch: () => [
        { title: "A1", url: "https://a.example/1", snippet: "a1", provider: "alpha" },
      ],
    }),
    gamma: makeProvider("gamma", {
      onSearch: () => [
        { title: "G1", url: "https://g.example/1", snippet: "g1", provider: "gamma" },
        { title: "G2", url: "https://g.example/2", snippet: "g2", provider: "gamma" },
      ],
    }),
  };

  const router = createSearchRouter(
    { searchProviders: ["alpha"], fallbackProviders: ["gamma"] },
    providers,
  );

  const result = await router.search({ query: "test", numResults: 3 });
  assert.equal(result.provider, "alpha+gamma (fallback)");
  assert.equal(result.results.length, 3);
  assert.deepEqual(result.results.map((item) => item.title), ["A1", "G1", "G2"]);
  assert.deepEqual(result.warnings, ["Used gamma fallback because primary providers returned too few results."]);
});

test("createSearchRouter: fallback stops once enough merged results exist", async () => {
  let gammaCalls = 0;
  let deltaCalls = 0;

  const providers = {
    alpha: makeProvider("alpha", {
      onSearch: () => [
        { title: "A1", url: "https://a.example/1", snippet: "a1", provider: "alpha" },
      ],
    }),
    gamma: makeProvider("gamma", {
      onSearch: () => {
        gammaCalls++;
        return [
          { title: "G1", url: "https://g.example/1", snippet: "g1", provider: "gamma" },
          { title: "G2", url: "https://g.example/2", snippet: "g2", provider: "gamma" },
        ];
      },
    }),
    delta: makeProvider("delta", {
      onSearch: () => {
        deltaCalls++;
        return [{ title: "D1", url: "https://d.example/1", snippet: "d1", provider: "delta" }];
      },
    }),
  };

  const router = createSearchRouter(
    { searchProviders: ["alpha"], fallbackProviders: ["gamma", "delta"] },
    providers,
  );

  const result = await router.search({ query: "test", numResults: 3 });
  assert.equal(result.results.length, 3);
  assert.equal(gammaCalls, 1);
  assert.equal(deltaCalls, 0);
});

test("createSearchRouter: 429 disables a provider for the session and skips it later", async () => {
  let alphaCalls = 0;
  let betaCalls = 0;

  const providers = {
    alpha: makeProvider("alpha", {
      onSearch: () => {
        alphaCalls++;
        throw new SearchProviderError({
          provider: "alpha",
          message: "Alpha rate limit",
          statusCode: 429,
          code: "rate_limited",
          disableForSession: true,
          disableReason: "rate limited",
          userMessage: "Alpha rate-limited; disabled for this session.",
        });
      },
    }),
    beta: makeProvider("beta", {
      onSearch: () => {
        betaCalls++;
        return [{ title: "Beta", url: "https://beta.example/1", snippet: "beta", provider: "beta" }];
      },
    }),
  };

  const router = createSearchRouter(
    { searchProviders: ["alpha", "beta"], fallbackProviders: [] },
    providers,
  );

  const first = await router.search({ query: "test", numResults: 3 });
  assert.equal(first.provider, "beta");
  assert.deepEqual(first.warnings, ["Alpha rate-limited; disabled for this session."]);
  assert.equal(alphaCalls, 1);
  assert.equal(betaCalls, 1);
  assert.deepEqual(getDisabledSearchProviders(), [{ name: "alpha", reason: "rate limited" }]);

  const second = await router.search({ query: "test again", numResults: 3 });
  assert.equal(second.provider, "beta");
  assert.equal(alphaCalls, 1);
  assert.equal(betaCalls, 2);
  assert.equal(second.warnings.length, 0);
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

test("createSearchRouter: explicit provider override disables on rate limit and does not fallback", async () => {
  let alphaCalls = 0;
  let betaCalls = 0;

  const providers = {
    alpha: makeProvider("alpha", {
      onSearch: () => {
        alphaCalls++;
        throw new SearchProviderError({
          provider: "alpha",
          message: "Alpha rate limit",
          statusCode: 429,
          code: "rate_limited",
          disableForSession: true,
          disableReason: "rate limited",
          userMessage: "Alpha rate-limited; disabled for this session.",
        });
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

  await assert.rejects(
    router.search({ query: "test", provider: "alpha" }),
    /Alpha rate-limited; disabled for this session\./,
  );
  assert.equal(alphaCalls, 1);
  assert.equal(betaCalls, 0);
  assert.deepEqual(getDisabledSearchProviders(), [{ name: "alpha", reason: "rate limited" }]);
});

test("createSearchRouter: explicit provider override fails fast when disabled for the session", async () => {
  let betaCalls = 0;

  const providers = {
    beta: makeProvider("beta", {
      onSearch: () => {
        betaCalls++;
        return [{ title: "Beta", url: "https://beta.example", snippet: "beta" }];
      },
    }),
  };

  disableSearchProvider("beta", "rate limited");

  const router = createSearchRouter(
    { searchProviders: [], fallbackProviders: ["beta"] },
    providers,
  );

  await assert.rejects(
    router.search({ query: "test", provider: "beta" }),
    /disabled for this session \(rate limited\)/,
  );
  assert.equal(betaCalls, 0);
});

test("createSearchRouter: resetSearchProviderState clears disabled providers", async () => {
  disableSearchProvider("alpha", "rate limited");
  assert.deepEqual(getDisabledSearchProviders(), [{ name: "alpha", reason: "rate limited" }]);

  resetSearchProviderState();
  assert.deepEqual(getDisabledSearchProviders(), []);
});

test("createSearchRouter: listProviders includes disabled-for-session status", async () => {
  const providers = {
    alpha: makeProvider("alpha"),
    beta: makeProvider("beta"),
  };

  disableSearchProvider("alpha", "rate limited");

  const router = createSearchRouter(
    { searchProviders: ["alpha"], fallbackProviders: ["beta"] },
    providers,
  );

  assert.deepEqual(router.listProviders(), [
    {
      name: "alpha",
      available: true,
      role: "primary",
      disabledForSession: true,
      disabledReason: "rate limited",
    },
    {
      name: "beta",
      available: true,
      role: "fallback",
      disabledForSession: false,
      disabledReason: undefined,
    },
  ]);
});
