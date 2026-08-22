import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OfferSchema } from "@northcinder/protocol";
import { runConformanceSuite } from "@northcinder/protocol/conformance";
import { createWoocommerceAdapter } from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const HOST_A = "woodmart.xtemos.com";
const HOST_B = "down-store.example.com";
const KNOWN_PRODUCT_ID = "23443";
const KNOWN_OFFER_ID = `wc|${HOST_A}|${KNOWN_PRODUCT_ID}`;

interface Recorded {
  url: string;
  host: string;
}

/**
 * Fake fetch emulating the real, doc-shaped WooCommerce Store API
 * (`wp-json/wc/store/v1/products[/:id]`), captured against a live store
 * (woodmart.xtemos.com) and trimmed. `down-store.example.com` always fails
 * (network error) to exercise the per-host degrade path.
 */
function createWooFixtureFetch(calls: Recorded[] = [], opts: { malformed?: boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url: url.toString(), host: url.host });
    const json = (status: number, body: string) =>
      new Response(body, { status, headers: { "content-type": "application/json" } });

    if (url.host === HOST_B) {
      throw new Error("simulated network failure: down-store.example.com is unreachable");
    }
    if (url.host !== HOST_A) return json(404, "{}");

    if (opts.malformed && url.pathname === "/wp-json/wc/store/v1/products") {
      return json(200, "{not valid json");
    }
    if (url.pathname === "/wp-json/wc/store/v1/products") {
      return json(200, fixture("search-lamp.json"));
    }
    const productMatch = /^\/wp-json\/wc\/store\/v1\/products\/(\d+)$/.exec(url.pathname);
    if (productMatch) {
      if (productMatch[1] === KNOWN_PRODUCT_ID) return json(200, fixture("product-known.json"));
      return json(404, '{"code":"woocommerce_rest_product_invalid_id"}');
    }
    return json(404, "{}");
  }) as typeof fetch;
}

function fixtureAdapter(calls: Recorded[] = [], stores: string[] = [HOST_A]) {
  return createWoocommerceAdapter({ stores, fetchImpl: createWooFixtureFetch(calls), env: {} });
}

// --- Conformance (offline, fixture-backed) ---------------------------------
runConformanceSuite(() => fixtureAdapter(), {
  searchQuery: { text: "lamp" },
  knownOfferId: KNOWN_OFFER_ID,
});

describe("woocommerce adapter — Store API mapping", () => {
  it("maps real doc-shaped products to schema-valid offers with exact content", async () => {
    const adapter = fixtureAdapter();
    const result = await adapter.search({ text: "lamp" }, { timeoutMs: 1000 });
    if (!result.ok) throw new Error(`search failed: ${result.error.message}`);
    expect(result.offers).toHaveLength(2);
    const [lamp, chair] = result.offers;

    expect(lamp!.product.title).toBe("Lamp Black Wall");
    expect(lamp!.product.url).toBe("https://woodmart.xtemos.com/shop/other/decor/lamp-black-wall/");
    // "24500" at currency_minor_unit 2 -> already protocol minor units.
    expect(lamp!.price).toEqual({ amount: 24500, currency: "USD" });
    expect(lamp!.merchant).toEqual({
      id: "woodmart.xtemos.com",
      name: "woodmart.xtemos.com",
      domain: "woodmart.xtemos.com",
      platform: "woocommerce",
    });
    expect(lamp!.availability).toBe("in_stock");
    expect(lamp!.sponsored).toBe(false);
    expect(lamp!.sourceStore).toBe("woocommerce");
    // HTML stripped from short_description.
    expect(lamp!.product.description).toBe("A hand-finished black wall lamp with a warm brass accent.");
    expect(lamp!.product.description).not.toContain("<p>");
    expect(lamp!.product.description).not.toContain("<strong>");
    expect(lamp!.product.attributes.shortDescription).toBe("A hand-finished black wall lamp with a warm brass accent.");
    expect(lamp!.product.imageUrl).toBe("https://woodmart.xtemos.com/wp-content/uploads/2018/09/decor-product-3-1.jpg");

    // Sold-out / is_in_stock:false -> out_of_stock.
    expect(chair!.availability).toBe("out_of_stock");
    expect(chair!.price).toEqual({ amount: 39000, currency: "USD" });

    for (const offer of result.offers) expect(OfferSchema.safeParse(offer).success).toBe(true);
  });

  it("sends search + per_page and never contacts an unconfigured host", async () => {
    const calls: Recorded[] = [];
    const adapter = fixtureAdapter(calls);
    await adapter.search({ text: "lamp", maxResults: 7 }, { timeoutMs: 1000 });
    const call = calls[0]!;
    const url = new URL(call.url);
    expect(url.host).toBe(HOST_A);
    expect(url.pathname).toBe("/wp-json/wc/store/v1/products");
    expect(url.searchParams.get("search")).toBe("lamp");
    expect(url.searchParams.get("per_page")).toBe("7");
    expect(calls.every((c) => c.host === HOST_A)).toBe(true);
  });

  it("getOffer resolves a product by encoded host+id", async () => {
    const adapter = fixtureAdapter();
    const result = await adapter.getOffer(KNOWN_OFFER_ID, { timeoutMs: 1000 });
    if (!result.ok) throw new Error(`getOffer failed: ${result.error.message}`);
    expect(result.offer.id).toBe(KNOWN_OFFER_ID);
    expect(result.offer.price).toEqual({ amount: 24500, currency: "USD" });
    expect(result.offer.product.description).toContain("hand-finished black wall lamp");
  });

  it("getOffer: unknown product id -> not_found; malformed offer id -> not_found without a network call", async () => {
    const calls: Recorded[] = [];
    const adapter = fixtureAdapter(calls);
    const unknown = await adapter.getOffer(`wc|${HOST_A}|999999`, { timeoutMs: 1000 });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("not_found");
    const before = calls.length;
    const bogus = await adapter.getOffer("not-a-woocommerce-offer-id", { timeoutMs: 1000 });
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) expect(bogus.error.code).toBe("not_found");
    expect(calls.length).toBe(before);
  });

  it("getOffer: a host outside the configured scope surfaces as permission_denied", async () => {
    const adapter = fixtureAdapter();
    const result = await adapter.getOffer(`wc|some-other-store.example.com|1`, { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("permission_denied");
  });
});

describe("woocommerce adapter — per-host fan-out and degrade", () => {
  it("one configured host down does not fail the search; the other host's offers still return", async () => {
    const adapter = fixtureAdapter([], [HOST_A, HOST_B]);
    const result = await adapter.search({ text: "lamp" }, { timeoutMs: 1000 });
    if (!result.ok) throw new Error(`expected partial success, got ${result.error.code}: ${result.error.message}`);
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.offers.every((o) => o.merchant.domain === HOST_A)).toBe(true);
    expect(result.sourceStatuses).toEqual(expect.arrayContaining([
      { source: HOST_A, ok: true, offerCount: expect.any(Number) },
      { source: HOST_B, ok: false, error: expect.objectContaining({ code: "unavailable" }) },
    ]));
    expect(result.sourceStatuses?.find((status) => !status.ok && status.source === HOST_B)?.error).not.toHaveProperty("details");
  });

  it("all configured hosts down -> honest unavailable error, never a fake empty success", async () => {
    const adapter = createWoocommerceAdapter({ stores: [HOST_B], fetchImpl: createWooFixtureFetch(), env: {} });
    const result = await adapter.search({ text: "lamp" }, { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unavailable");
  });

  it("malformed JSON from a store surfaces as invalid_response, never a crash or fake result", async () => {
    const adapter = createWoocommerceAdapter({ stores: [HOST_A], fetchImpl: createWooFixtureFetch([], { malformed: true }), env: {} });
    const result = await adapter.search({ text: "lamp" }, { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unavailable");
  });
});

describe("woocommerce adapter — configuration honesty", () => {
  it("preserves a provider 429 Retry-After as a typed rate_limited error", async () => {
    const adapter = createWoocommerceAdapter({
      env: { WOOCOMMERCE_STORE_HOSTS: "shop.example" },
      fetchImpl: async () => new Response("{}", { status: 429, headers: { "Retry-After": "2" } }),
    });
    const result = await adapter.search({ text: "anything" }, { timeoutMs: 100 });
    expect(result).toMatchObject({ ok: false, error: { code: "rate_limited", retryAfterMs: 2_000 } });
  });

  it("uses the maximum Retry-After when every configured host is rate limited", async () => {
    const delays: Record<string, string> = { "shop-one.example": "1", "shop-two.example": "3" };
    const adapter = createWoocommerceAdapter({
      stores: Object.keys(delays),
      fetchImpl: async (input) => new Response("{}", {
        status: 429,
        headers: { "Retry-After": delays[new URL(input instanceof Request ? input.url : String(input)).hostname]! },
      }),
      env: {},
    });
    const result = await adapter.search({ text: "anything" }, { timeoutMs: 100 });
    expect(result).toMatchObject({ ok: false, error: { code: "rate_limited", retryAfterMs: 3_000 } });
  });

  it("keeps the largest typed Retry-After when a rate-limited and timed-out store all fail", async () => {
    const adapter = createWoocommerceAdapter({
      stores: ["limited-shop.example", "slow-shop.example"],
      fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
        const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
        if (host === "limited-shop.example") {
          return Promise.resolve(new Response("{}", { status: 429, headers: { "Retry-After": "3" } }));
        }
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }) as typeof fetch,
      env: {},
    });

    const result = await adapter.search({ text: "anything" }, { timeoutMs: 100 });

    expect(result).toMatchObject({ ok: false, error: { code: "unavailable", retryAfterMs: 3_000 } });
  });

  it("no stores configured -> structured not_configured naming WOOCOMMERCE_STORE_HOSTS, never fake success", async () => {
    const adapter = createWoocommerceAdapter({ env: {} });
    const search = await adapter.search({ text: "anything" }, { timeoutMs: 500 });
    expect(search.ok).toBe(false);
    if (search.ok) return;
    expect(search.error.code).toBe("not_configured");
    expect(search.error.retryable).toBe(false);
    expect(search.error.message).toMatch(/WOOCOMMERCE_STORE_HOSTS/);
    const offer = await adapter.getOffer(KNOWN_OFFER_ID, { timeoutMs: 500 });
    expect(offer.ok).toBe(false);
    if (!offer.ok) expect(offer.error.code).toBe("not_configured");
  });

  it("reads WOOCOMMERCE_STORE_HOSTS from env when no explicit stores are passed", () => {
    const adapter = createWoocommerceAdapter({ env: { WOOCOMMERCE_STORE_HOSTS: "a.example.com, b.example.com" } });
    expect(adapter.manifest.permissions.allowedHosts).toEqual(["a.example.com", "b.example.com"]);
  });

  it("refreshes a legacy mixed-case offer id but rejects an unconfigured host without provider I/O", async () => {
    const calls: Recorded[] = [];
    const adapter = fixtureAdapter(calls);
    const legacyId = "wc|Woodmart.XtEmOs.COM|23443";

    const refreshed = await adapter.getOffer(legacyId, { timeoutMs: 1_000 });
    expect(refreshed).toMatchObject({ ok: true, offer: { id: legacyId } });

    const beforeOutOfScope = calls.length;
    const rejected = await adapter.getOffer("wc|Unconfigured.Example|1", { timeoutMs: 1_000 });
    expect(rejected).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(calls).toHaveLength(beforeOutOfScope);
  });

  it("manifest scopes exactly the configured hosts, no user session, no checkout, no sponsored concept", () => {
    const adapter = fixtureAdapter();
    expect(adapter.manifest.id).toBe("woocommerce");
    expect(adapter.manifest.permissions.allowedHosts).toEqual([HOST_A]);
    expect(adapter.manifest.permissions.userSession).toBe(false);
    expect(adapter.manifest.capabilities.checkout).toBe(false);
  });

  it("times out gracefully with a structured timeout error", async () => {
    const hangingFetch: typeof fetch = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const adapter = createWoocommerceAdapter({ stores: [HOST_A], fetchImpl: hangingFetch, env: {} });
    const result = await adapter.search({ text: "x" }, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("timeout");
  });
});
