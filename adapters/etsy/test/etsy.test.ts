import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OfferSchema } from "@northcinder/protocol";
import { runConformanceSuite } from "@northcinder/protocol/conformance";
import { createEtsyAdapter } from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const KNOWN_LISTING_ID = "1234567890";

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

/** Fake fetch emulating Etsy Open API v3 (doc-shaped fixtures). */
function createEtsyFixtureFetch(calls: Recorded[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url: url.toString(), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const json = (status: number, body: string) =>
      new Response(body, { status, headers: { "content-type": "application/json" } });
    if (new Headers(init?.headers).get("x-api-key") !== "fixture-etsy-key") {
      return json(401, '{"error":"Invalid API key"}');
    }
    if (url.pathname === "/v3/application/listings/active") {
      return json(200, fixture("search-lamp.json"));
    }
    const listingMatch = /^\/v3\/application\/listings\/(\d+)$/.exec(url.pathname);
    if (listingMatch) {
      if (listingMatch[1] === KNOWN_LISTING_ID) return json(200, fixture("listing-known.json"));
      return json(404, '{"error":"Listing not found"}');
    }
    return json(404, "{}");
  }) as typeof fetch;
}

function fixtureAdapter(calls: Recorded[] = []) {
  return createEtsyAdapter({ apiKey: "fixture-etsy-key", fetchImpl: createEtsyFixtureFetch(calls), env: {} });
}

// --- Conformance (offline, fixture-backed) ---------------------------------
runConformanceSuite(() => fixtureAdapter(), {
  searchQuery: { text: "handmade ceramic lamp" },
  knownOfferId: KNOWN_LISTING_ID,
});

describe("etsy adapter — Open API v3 mapping", () => {
  it("maps active listings to schema-valid offers with exact content", async () => {
    const adapter = fixtureAdapter();
    const result = await adapter.search({ text: "handmade ceramic lamp" }, { timeoutMs: 1000 });
    if (!result.ok) throw new Error(`search failed: ${result.error.message}`);
    expect(result.offers).toHaveLength(2);
    const [lamp, vintage] = result.offers;
    expect(lamp!.product.title).toBe("Handmade Ceramic Table Lamp - Speckled Clay with Linen Shade");
    expect(lamp!.price).toEqual({ amount: 14500, currency: "USD" });
    expect(lamp!.product.url).toBe("https://www.etsy.com/listing/1234567890/handmade-ceramic-table-lamp-speckled");
    expect(lamp!.merchant).toEqual({
      id: "etsy-shop:24680135",
      name: "Etsy shop #24680135",
      domain: "etsy.com",
      platform: "etsy",
    });
    expect(lamp!.availability).toBe("in_stock");
    expect(lamp!.sponsored).toBe(false);
    expect(lamp!.sourceStore).toBe("etsy");
    // amount/divisor money conversion, not floats: 8250/100 USD -> 8250 minor units.
    expect(vintage!.price).toEqual({ amount: 8250, currency: "USD" });
    for (const offer of result.offers) expect(OfferSchema.safeParse(offer).success).toBe(true);
  });

  it("sends the API key as x-api-key and passes keywords + limit", async () => {
    const calls: Recorded[] = [];
    const adapter = fixtureAdapter(calls);
    await adapter.search({ text: "lamp", maxResults: 7 }, { timeoutMs: 1000 });
    const call = calls[0]!;
    expect(call.headers["x-api-key"]).toBe("fixture-etsy-key");
    const url = new URL(call.url);
    expect(url.host).toBe("openapi.etsy.com");
    expect(url.searchParams.get("keywords")).toBe("lamp");
    expect(url.searchParams.get("limit")).toBe("7");
  });

  it("getOffer resolves a listing by id", async () => {
    const adapter = fixtureAdapter();
    const result = await adapter.getOffer(KNOWN_LISTING_ID, { timeoutMs: 1000 });
    if (!result.ok) throw new Error(`getOffer failed: ${result.error.message}`);
    expect(result.offer.id).toBe(KNOWN_LISTING_ID);
    expect(result.offer.price).toEqual({ amount: 14500, currency: "USD" });
    expect(result.offer.product.description).toContain("hand-thrown stoneware");
  });

  it("getOffer: unknown numeric id → not_found from the API; non-numeric id → not_found without a network call", async () => {
    const calls: Recorded[] = [];
    const adapter = fixtureAdapter(calls);
    const unknown = await adapter.getOffer("9999999999", { timeoutMs: 1000 });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("not_found");
    const before = calls.length;
    const bogus = await adapter.getOffer("not-a-listing-id", { timeoutMs: 1000 });
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) expect(bogus.error.code).toBe("not_found");
    expect(calls.length).toBe(before);
  });

  it("sold-out listings map to out_of_stock", async () => {
    const soldOut = JSON.parse(fixture("search-lamp.json")) as { results: Array<Record<string, unknown>> };
    soldOut.results = [{ ...soldOut.results[0]!, quantity: 0, state: "sold_out" }];
    const adapter = createEtsyAdapter({
      apiKey: "fixture-etsy-key",
      fetchImpl: (async (_i: unknown, init?: RequestInit) => {
        if (new Headers(init?.headers).get("x-api-key") !== "fixture-etsy-key") return new Response("{}", { status: 401 });
        return new Response(JSON.stringify(soldOut), { status: 200 });
      }) as typeof fetch,
      env: {},
    });
    const result = await adapter.search({ text: "lamp" }, { timeoutMs: 1000 });
    if (!result.ok) throw new Error("search failed");
    expect(result.offers[0]!.availability).toBe("out_of_stock");
  });
});

describe("etsy adapter — configuration honesty", () => {
  it("missing key → structured not_configured naming ETSY_API_KEY, never fake success", async () => {
    const adapter = createEtsyAdapter({ env: {} });
    const search = await adapter.search({ text: "anything" }, { timeoutMs: 500 });
    expect(search.ok).toBe(false);
    if (search.ok) return;
    expect(search.error.code).toBe("not_configured");
    expect(search.error.retryable).toBe(false);
    expect(search.error.message).toMatch(/ETSY_API_KEY/);
    const offer = await adapter.getOffer(KNOWN_LISTING_ID, { timeoutMs: 500 });
    expect(offer.ok).toBe(false);
    if (!offer.ok) expect(offer.error.code).toBe("not_configured");
  });

  it("a rejected key surfaces as permission_denied, not success", async () => {
    const adapter = createEtsyAdapter({ apiKey: "wrong-key", fetchImpl: createEtsyFixtureFetch(), env: {} });
    const result = await adapter.search({ text: "lamp" }, { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("permission_denied");
  });

  it("manifest scopes exactly openapi.etsy.com, no user session, no checkout", () => {
    const adapter = fixtureAdapter();
    expect(adapter.manifest.id).toBe("etsy");
    expect(adapter.manifest.permissions.allowedHosts).toEqual(["openapi.etsy.com"]);
    expect(adapter.manifest.permissions.userSession).toBe(false);
    expect(adapter.manifest.capabilities.checkout).toBe(false);
  });

  it("times out gracefully with a structured timeout error", async () => {
    const hangingFetch: typeof fetch = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const adapter = createEtsyAdapter({ apiKey: "k", fetchImpl: hangingFetch, env: {} });
    const result = await adapter.search({ text: "x" }, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("timeout");
  });
});
