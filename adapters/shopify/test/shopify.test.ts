import { describe, expect, it } from "vitest";
import { OfferSchema } from "@northcinder/protocol";
import { runConformanceSuite } from "@northcinder/protocol/conformance";
import { createShopifyAdapter, GLOBAL_CATALOG_MCP_URL } from "../src/index.js";
import { createFixtureFetch, type RecordedCall } from "./fixture-fetch.js";

const SHOPS = ["www.allbirds.com", "www.rothys.com"];
const ROUTES = {
  "www.allbirds.com search_catalog": "allbirds-search.json",
  "www.allbirds.com get_product_details": "allbirds-product.json",
  "www.rothys.com search_catalog": "rothys-search.json",
};
const KNOWN_OFFER_ID = "sf|www.allbirds.com|gid://shopify/Product/1878275686469";

function fixtureAdapter(calls: RecordedCall[] = []) {
  return createShopifyAdapter({
    shops: SHOPS,
    fetchImpl: createFixtureFetch(ROUTES, calls),
    env: {},
  });
}

// --- Conformance (offline, fixture-backed) ---------------------------------
runConformanceSuite(() => fixtureAdapter(), {
  searchQuery: { text: "wool runner shoes" },
  knownOfferId: KNOWN_OFFER_ID,
});

describe("shopify adapter — storefront MCP leg", () => {
  it("maps real captured UCP products to schema-valid offers with exact content", async () => {
    const adapter = fixtureAdapter();
    const result = await adapter.search({ text: "wool runner shoes" }, { timeoutMs: 1000 });
    if (!result.ok) throw new Error(`search failed: ${result.error.message}`);
    const allbirds = result.offers.find((o) => o.merchant.domain === "www.allbirds.com");
    expect(allbirds).toBeDefined();
    expect(allbirds!.product.title).toBe("Women's Wool Runner - Natural Black (Black Sole)");
    expect(allbirds!.product.url).toBe("https://www.allbirds.com/products/womens-wool-runners-natural-black");
    expect(allbirds!.price).toEqual({ amount: 11000, currency: "USD" });
    expect(allbirds!.availability).toBe("in_stock");
    expect(allbirds!.sponsored).toBe(false);
    expect(allbirds!.sourceStore).toBe("shopify");
    expect(allbirds!.merchant.platform).toBe("shopify");
    // Both configured shops contribute offers.
    expect(result.offers.some((o) => o.merchant.domain === "www.rothys.com")).toBe(true);
    for (const offer of result.offers) expect(OfferSchema.safeParse(offer).success).toBe(true);
  });

  it("queries every configured shop and never any other host", async () => {
    const calls: RecordedCall[] = [];
    const adapter = fixtureAdapter(calls);
    await adapter.search({ text: "flats" }, { timeoutMs: 1000 });
    const hosts = new Set(calls.map((c) => c.host));
    expect(hosts).toEqual(new Set(SHOPS));
    for (const host of hosts) {
      expect(adapter.manifest.permissions.allowedHosts).toContain(host);
    }
  });

  it("caps the MERGED multi-shop result set to query.maxResults, not just each shop individually", async () => {
    const adapter = fixtureAdapter();
    // Each fixture shop has 10 products; each shop's own leg already caps to
    // maxResults=5, but two shops merging 5+5=10 must still be capped to 5
    // in the final result.
    const result = await adapter.search({ text: "shoes", maxResults: 5 }, { timeoutMs: 1000 });
    if (!result.ok) throw new Error(`search failed: ${result.error.message}`);
    expect(result.offers.length).toBeLessThanOrEqual(5);
  });

  it("one shop failing does not fail the search (partial results)", async () => {
    const adapter = createShopifyAdapter({
      shops: SHOPS,
      fetchImpl: createFixtureFetch({ "www.allbirds.com search_catalog": "allbirds-search.json" }),
      env: {},
    });
    const result = await adapter.search({ text: "shoes" }, { timeoutMs: 1000 });
    if (!result.ok) throw new Error("expected partial success");
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.offers.every((o) => o.merchant.domain === "www.allbirds.com")).toBe(true);
  });

  it("all shops failing degrades to a structured error, never a throw", async () => {
    const adapter = createShopifyAdapter({
      shops: SHOPS,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      env: {},
    });
    const result = await adapter.search({ text: "shoes" }, { timeoutMs: 300 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unavailable");
    expect(result.error.store).toBe("shopify");
  });

  it("getOffer resolves the known product via get_product_details (decimal-string price parsed to minor units)", async () => {
    const adapter = fixtureAdapter();
    const result = await adapter.getOffer(KNOWN_OFFER_ID, { timeoutMs: 1000 });
    if (!result.ok) throw new Error(`getOffer failed: ${result.error.message}`);
    expect(result.offer.price).toEqual({ amount: 11000, currency: "USD" });
    expect(result.offer.product.title).toBe("Women's Wool Runner - Natural Black (Black Sole)");
    expect(result.offer.id).toBe(KNOWN_OFFER_ID);
  });

  it("search offers carry the variant gid attribute the checkout cart-permalink rail consumes", async () => {
    const adapter = fixtureAdapter();
    const result = await adapter.search({ text: "wool runner shoes" }, { timeoutMs: 1000 });
    if (!result.ok) throw new Error(`search failed: ${result.error.message}`);
    const allbirds = result.offers.find((o) => o.id === KNOWN_OFFER_ID);
    expect(allbirds).toBeDefined();
    expect(allbirds!.product.attributes["shopify:variantGid"]).toBe(
      "gid://shopify/ProductVariant/32262292013136",
    );
  });

  it("getOffer carries the variant gid attribute from the selected/first available variant", async () => {
    const adapter = fixtureAdapter();
    const result = await adapter.getOffer(KNOWN_OFFER_ID, { timeoutMs: 1000 });
    if (!result.ok) throw new Error(`getOffer failed: ${result.error.message}`);
    expect(result.offer.product.attributes["shopify:variantGid"]).toBe(
      "gid://shopify/ProductVariant/32262292013136",
    );
  });

  it("getOffer for a shop outside the configured scope is permission_denied, not a network call", async () => {
    const calls: RecordedCall[] = [];
    const adapter = fixtureAdapter(calls);
    const result = await adapter.getOffer("sf|evil.example.com|gid://shopify/Product/1", { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("permission_denied");
    expect(calls).toEqual([]);
  });
});

describe("shopify adapter — global catalog leg (UCP, live-verified wire shape)", () => {
  const PROFILE = "https://agent.example/ucp-profile.json";

  it("returns structured not_configured without an agent profile and no shops", async () => {
    const adapter = createShopifyAdapter({ env: {} });
    const result = await adapter.search({ text: "anything" }, { timeoutMs: 500 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_configured");
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toMatch(/SHOPIFY_UCP_AGENT_PROFILE_URL|SHOPIFY_MCP_SHOPS/);
  });

  it("anonymous tier: sends the agent profile INSIDE the arguments (meta[\"ucp-agent\"].profile), no Authorization header", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createShopifyAdapter({
      globalCatalog: { profileUrl: PROFILE },
      fetchImpl: createFixtureFetch({ "catalog.shopify.com search_catalog": "global-catalog-search.json" }, calls),
      env: {},
    });
    const result = await adapter.search({ text: "trail running shoes", maxResults: 3 }, { timeoutMs: 1000 });
    if (!result.ok) throw new Error(`global search failed: ${result.error.message}`);

    const args = calls[0]?.args as {
      meta?: { "ucp-agent"?: { profile?: string } };
      catalog?: { query?: string; pagination?: { limit?: number } };
    };
    expect(calls[0]?.host).toBe("catalog.shopify.com");
    expect(args.meta?.["ucp-agent"]?.profile).toBe(PROFILE);
    expect(args.catalog?.query).toBe("trail running shoes");
    expect(args.catalog?.pagination?.limit).toBe(3);
    expect(calls[0]?.headers.authorization).toBeUndefined();

    // The live response shape: payload in result.structuredContent, price in
    // minor units, storefront URL on the VARIANT — all mapped to a valid Offer.
    expect(result.offers).toHaveLength(1);
    const offer = result.offers[0]!;
    expect(OfferSchema.parse(offer)).toBeTruthy();
    expect(offer.product.title).toBe("Brooks Cascadia 17 Mens Trail Running Shoes - Grey");
    expect(offer.price).toEqual({ amount: 12000, currency: "USD" });
    expect(offer.merchant.domain).toBe("startfitness.co.uk");
    expect(offer.availability).toBe("in_stock");
    expect(offer.sponsored).toBe(false);
  });

  it("clamps pagination.limit to the endpoint's 1–50 window", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createShopifyAdapter({
      globalCatalog: { profileUrl: PROFILE },
      fetchImpl: createFixtureFetch({ "catalog.shopify.com search_catalog": "global-catalog-search.json" }, calls),
      env: {},
    });
    await adapter.search({ text: "x", maxResults: 200 }, { timeoutMs: 1000 });
    const args = calls[0]?.args as { catalog?: { pagination?: { limit?: number } } };
    expect(args.catalog?.pagination?.limit).toBe(50);
  });

  it("an optional Dev-Dashboard bearer token is sent as Authorization when configured", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createShopifyAdapter({
      globalCatalog: { profileUrl: PROFILE, apiKey: "dashboard-jwt" },
      fetchImpl: createFixtureFetch({ "catalog.shopify.com search_catalog": "global-catalog-search.json" }, calls),
      env: {},
    });
    await adapter.search({ text: "x" }, { timeoutMs: 1000 });
    expect(calls[0]?.headers.authorization).toBe("Bearer dashboard-jwt");
  });

  it("keeps the endpoint URL configurable", () => {
    expect(GLOBAL_CATALOG_MCP_URL).toBe("https://catalog.shopify.com/api/ucp/mcp");
    const adapter = createShopifyAdapter({
      globalCatalog: { profileUrl: PROFILE, url: "https://alt.shopify.com/api/ucp/mcp" },
      env: {},
    });
    expect(adapter.manifest.permissions.allowedHosts).toContain("alt.shopify.com");
  });
});

describe("shopify adapter — manifest & config", () => {
  it("declares exactly the configured shops plus the catalog host, no wildcards, userSession false", () => {
    const adapter = fixtureAdapter();
    expect(adapter.manifest.id).toBe("shopify");
    expect(adapter.manifest.permissions.userSession).toBe(false);
    expect(new Set(adapter.manifest.permissions.allowedHosts)).toEqual(
      new Set(["catalog.shopify.com", ...SHOPS]),
    );
    expect(adapter.manifest.capabilities.checkout).toBe(false);
  });

  it("rejects malformed shop hosts at construction (scheme/path/wildcard)", () => {
    expect(() => createShopifyAdapter({ shops: ["https://x.com"], env: {} })).toThrow(/host/i);
    expect(() => createShopifyAdapter({ shops: ["*"], env: {} })).toThrow(/host/i);
  });

  it("reads shops and the UCP agent profile from env when not passed explicitly", async () => {
    const calls: RecordedCall[] = [];
    const adapter = createShopifyAdapter({
      env: {
        SHOPIFY_MCP_SHOPS: "www.allbirds.com, www.rothys.com",
        SHOPIFY_UCP_AGENT_PROFILE_URL: "https://agent.example/env-profile.json",
      },
      fetchImpl: createFixtureFetch({ "catalog.shopify.com search_catalog": "global-catalog-search.json" }, calls),
    });
    expect(adapter.manifest.permissions.allowedHosts).toContain("www.rothys.com");
    await adapter.search({ text: "x" }, { timeoutMs: 1000 });
    const args = calls[0]?.args as { meta?: { "ucp-agent"?: { profile?: string } } };
    expect(args.meta?.["ucp-agent"]?.profile).toBe("https://agent.example/env-profile.json");
  });

  it("times out gracefully with a structured timeout error", async () => {
    const hangingFetch: typeof fetch = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const adapter = createShopifyAdapter({ shops: SHOPS, fetchImpl: hangingFetch, env: {} });
    const result = await adapter.search({ text: "x" }, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("timeout");
    expect(result.error.retryable).toBe(true);
  });
});
