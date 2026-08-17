import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OfferSchema } from "@northcinder/protocol";
import { runConformanceSuite } from "@northcinder/protocol/conformance";
import { createEbayAdapter } from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const KNOWN_ITEM_ID = "v1|110552649522|410108227370";

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** Fake fetch emulating the sandbox OAuth + Browse endpoints (doc-shaped fixtures). */
function createEbayFixtureFetch(calls: Recorded[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({
      url: url.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(init?.body ? { body: String(init.body) } : {}),
    });
    const json = (status: number, body: string) =>
      new Response(body, { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/identity/v1/oauth2/token") {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (!auth.startsWith("Basic ")) return json(401, '{"error":"invalid_client"}');
      return json(200, fixture("token.json"));
    }
    const bearer = new Headers(init?.headers).get("authorization") ?? "";
    if (bearer !== "Bearer v^1.1#i^1#SANDBOX-FIXTURE-TOKEN") return json(401, '{"errors":[{"errorId":1001}]}');
    if (url.pathname === "/buy/browse/v1/item_summary/search") {
      return json(200, fixture("search-headphones.json"));
    }
    if (url.pathname.startsWith("/buy/browse/v1/item/")) {
      const itemId = decodeURIComponent(url.pathname.slice("/buy/browse/v1/item/".length));
      if (itemId === KNOWN_ITEM_ID) return json(200, fixture("item-known.json"));
      return json(404, '{"errors":[{"errorId":11001,"domain":"API_BROWSE","message":"The specified item Id was not found."}]}');
    }
    return json(404, "{}");
  }) as typeof fetch;
}

function fixtureAdapter(calls: Recorded[] = []) {
  return createEbayAdapter({
    clientId: "fixture-client-id",
    clientSecret: "fixture-client-secret",
    environment: "sandbox",
    fetchImpl: createEbayFixtureFetch(calls),
    env: {},
  });
}

// --- Conformance (offline, fixture-backed) ---------------------------------
runConformanceSuite(() => fixtureAdapter(), {
  searchQuery: { text: "wireless headphones" },
  knownOfferId: KNOWN_ITEM_ID,
});

describe("ebay adapter — Buy Browse mapping", () => {
  it("maps itemSummaries to schema-valid offers with exact content", async () => {
    const adapter = fixtureAdapter();
    const result = await adapter.search({ text: "wireless headphones" }, { timeoutMs: 1000 });
    if (!result.ok) throw new Error(`search failed: ${result.error.message}`);
    expect(result.offers).toHaveLength(2);
    const [sony, bose] = result.offers;
    expect(sony!.product.title).toBe("Sony WH-1000XM5 Wireless Noise Canceling Headphones - Black");
    expect(sony!.price).toEqual({ amount: 24800, currency: "USD" });
    expect(sony!.product.url).toBe("https://sandbox.ebay.com/itm/110552649522");
    expect(sony!.merchant).toEqual({
      id: "ebay:soundgear-outlet",
      name: "soundgear-outlet",
      domain: "ebay.com",
      platform: "ebay",
    });
    expect(sony!.condition).toBe("new");
    expect(sony!.shipping?.cost).toEqual({ amount: 0, currency: "USD" });
    expect(sony!.sponsored).toBe(false);
    expect(sony!.sourceStore).toBe("ebay");
    expect(bose!.condition).toBe("refurbished");
    expect(bose!.price).toEqual({ amount: 17995, currency: "USD" });
    expect(bose!.shipping?.cost).toEqual({ amount: 599, currency: "USD" });
    for (const offer of result.offers) expect(OfferSchema.safeParse(offer).success).toBe(true);
  });

  it("fetches an app token once (Basic auth) and reuses it across calls", async () => {
    const calls: Recorded[] = [];
    const adapter = fixtureAdapter(calls);
    await adapter.search({ text: "a" }, { timeoutMs: 1000 });
    await adapter.search({ text: "b" }, { timeoutMs: 1000 });
    const tokenCalls = calls.filter((c) => c.url.includes("/oauth2/token"));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from("fixture-client-id:fixture-client-secret").toString("base64")}`,
    );
    expect(tokenCalls[0]!.body).toContain("grant_type=client_credentials");
  });

  it("getOffer maps the item page incl. availability and delivery estimate", async () => {
    const adapter = fixtureAdapter();
    const result = await adapter.getOffer(KNOWN_ITEM_ID, { timeoutMs: 1000 });
    if (!result.ok) throw new Error(`getOffer failed: ${result.error.message}`);
    expect(result.offer.id).toBe(KNOWN_ITEM_ID);
    expect(result.offer.availability).toBe("in_stock");
    expect(result.offer.product.brand).toBe("Sony");
    expect(result.offer.product.description).toContain("noise cancellation");
    expect(result.offer.price).toEqual({ amount: 24800, currency: "USD" });
  });

  it("getOffer for an unknown item returns structured not_found", async () => {
    const adapter = fixtureAdapter();
    const result = await adapter.getOffer("v1|999999999999|0", { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_found");
    expect(result.error.retryable).toBe(false);
  });
});

describe("ebay adapter — configuration honesty", () => {
  it("missing keys → structured not_configured naming the env vars, NEVER fake success", async () => {
    const adapter = createEbayAdapter({ env: {} });
    const search = await adapter.search({ text: "anything" }, { timeoutMs: 500 });
    expect(search.ok).toBe(false);
    if (search.ok) return;
    expect(search.error.code).toBe("not_configured");
    expect(search.error.retryable).toBe(false);
    expect(search.error.message).toMatch(/EBAY_CLIENT_ID/);
    const offer = await adapter.getOffer(KNOWN_ITEM_ID, { timeoutMs: 500 });
    expect(offer.ok).toBe(false);
    if (!offer.ok) expect(offer.error.code).toBe("not_configured");
  });

  it("reads credentials and environment from env", async () => {
    const calls: Recorded[] = [];
    const adapter = createEbayAdapter({
      fetchImpl: createEbayFixtureFetch(calls),
      env: {
        EBAY_CLIENT_ID: "fixture-client-id",
        EBAY_CLIENT_SECRET: "fixture-client-secret",
        EBAY_ENV: "sandbox",
      },
    });
    const result = await adapter.search({ text: "headphones" }, { timeoutMs: 1000 });
    expect(result.ok).toBe(true);
    expect(calls.every((c) => c.url.startsWith("https://api.sandbox.ebay.com/"))).toBe(true);
  });

  it("manifest scopes ONLY the host for the configured instance (sandbox), not both", () => {
    const adapter = fixtureAdapter(); // environment: "sandbox"
    expect(adapter.manifest.id).toBe("ebay");
    expect(adapter.manifest.permissions.allowedHosts).toEqual(["api.sandbox.ebay.com"]);
    expect(adapter.manifest.permissions.userSession).toBe(false);
    expect(adapter.manifest.capabilities.checkout).toBe(false);
  });

  it("manifest scopes ONLY the production host when configured for production", () => {
    const adapter = createEbayAdapter({
      clientId: "fixture-client-id",
      clientSecret: "fixture-client-secret",
      environment: "production",
      env: {},
    });
    expect(adapter.manifest.permissions.allowedHosts).toEqual(["api.ebay.com"]);
  });

  it("on a 401 from a cached (revoked) token, clears the cache and retries once with a fresh token", async () => {
    const calls: Recorded[] = [];
    let tokenIssueCount = 0;
    const fetchImpl: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({
        url: url.toString(),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      const json = (status: number, body: string) =>
        new Response(body, { status, headers: { "content-type": "application/json" } });
      if (url.pathname === "/identity/v1/oauth2/token") {
        tokenIssueCount += 1;
        return json(
          200,
          JSON.stringify({ access_token: `token-${tokenIssueCount}`, expires_in: 7200 }),
        );
      }
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      // The first-issued token is treated as revoked server-side (a 401 the
      // adapter must not have cached its way around); the SECOND token
      // (fetched only if the adapter clears its cache and re-authenticates)
      // is accepted.
      if (bearer === "Bearer token-1") return json(401, '{"errors":[{"errorId":1001}]}');
      if (bearer === "Bearer token-2" && url.pathname === "/buy/browse/v1/item_summary/search") {
        return json(200, fixture("search-headphones.json"));
      }
      return json(404, "{}");
    }) as typeof fetch;

    const adapter = createEbayAdapter({
      clientId: "fixture-client-id",
      clientSecret: "fixture-client-secret",
      environment: "sandbox",
      fetchImpl,
      env: {},
    });

    const result = await adapter.search({ text: "wireless headphones" }, { timeoutMs: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offers.length).toBeGreaterThan(0);

    // Exactly one retry: two token fetches (original + refreshed), two
    // Browse calls (the 401 then the successful retry).
    expect(tokenIssueCount).toBe(2);
    const browseCalls = calls.filter((c) => c.url.includes("/item_summary/search"));
    expect(browseCalls).toHaveLength(2);
    expect(browseCalls[0]!.headers.authorization).toBe("Bearer token-1");
    expect(browseCalls[1]!.headers.authorization).toBe("Bearer token-2");
  });

  it("times out gracefully with a structured timeout error", async () => {
    const hangingFetch: typeof fetch = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const adapter = createEbayAdapter({
      clientId: "x",
      clientSecret: "y",
      environment: "sandbox",
      fetchImpl: hangingFetch,
      env: {},
    });
    const result = await adapter.search({ text: "x" }, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("timeout");
  });
});
