import { describe, expect, it } from "vitest";
import { rankOffers } from "@northcinder/protocol";
import * as adapterRegistry from "../src/adapters-from-env.js";
import { createDemoSponsoredAdapter, DEMO_SPONSORED_STORE_ID } from "../src/demo/sponsored-demo-adapter.js";

const { buildAdaptersFromEnv } = adapterRegistry;

function discoverySources(env: Record<string, string | undefined>) {
  const build = (adapterRegistry as typeof adapterRegistry & {
    discoverySourcesFromEnv?: (source: Record<string, string | undefined>) => Array<{ store: string; status: string }>;
  }).discoverySourcesFromEnv;
  expect(build).toBeTypeOf("function");
  return build?.(env) ?? [];
}

describe("buildAdaptersFromEnv — real-adapter service wiring (client integration)", () => {
  it("reports the exact native discovery set as not_configured without contacting a provider", () => {
    expect(discoverySources({})).toEqual([
      { store: "amazon", status: "not_configured" },
      { store: "ebay", status: "not_configured" },
      { store: "etsy", status: "not_configured" },
      { store: "shopify", status: "not_configured" },
      { store: "woocommerce", status: "not_configured" },
    ]);
  });

  it("reports locally valid configuration as ready without making a store request", () => {
    expect(discoverySources({
      AMAZON_SESSION_PROFILE: "/buyer/profile",
      EBAY_CLIENT_ID: "buyer-app",
      EBAY_CLIENT_SECRET: "buyer-secret",
      ETSY_API_KEY: "buyer-etsy-key",
      SHOPIFY_UCP_AGENT_PROFILE_URL: "https://agent.example/ucp-profile.json",
      WOOCOMMERCE_STORE_HOSTS: "woo.example.com",
    })).toEqual([
      { store: "amazon", status: "ready" },
      { store: "ebay", status: "ready" },
      { store: "etsy", status: "ready" },
      { store: "shopify", status: "ready" },
      { store: "woocommerce", status: "ready" },
    ]);
  });

  it("treats storefront hosts without the required UCP profile as invalid_configuration", () => {
    expect(discoverySources({ SHOPIFY_MCP_SHOPS: "shop.example.com" })).toContainEqual({
      store: "shopify",
      status: "invalid_configuration",
    });
  });

  it("treats a valid Shopify UCP profile alone as ready", () => {
    expect(discoverySources({ SHOPIFY_UCP_AGENT_PROFILE_URL: "https://agent.example/ucp-profile.json" })).toContainEqual({
      store: "shopify",
      status: "ready",
    });
  });

  it("reports a partial credential pair as invalid_configuration rather than ready", () => {
    expect(discoverySources({ EBAY_CLIENT_ID: "buyer-app" })).toEqual([
      { store: "amazon", status: "not_configured" },
      { store: "ebay", status: "invalid_configuration" },
      { store: "etsy", status: "not_configured" },
      { store: "shopify", status: "not_configured" },
      { store: "woocommerce", status: "not_configured" },
    ]);
  });

  it("registers all five real store adapters regardless of configuration (each degrades itself)", () => {
    const adapters = buildAdaptersFromEnv({});
    const ids = adapters.map((a) => a.manifest.id).sort();
    expect(ids).toEqual(["amazon", "ebay", "etsy", "shopify", "woocommerce"]);
  });

  it("an unconfigured store reports a structured not_configured error, never a fake result", async () => {
    const adapters = buildAdaptersFromEnv({});
    const etsy = adapters.find((a) => a.manifest.id === "etsy")!;
    const result = await etsy.search({ text: "lamp" }, { timeoutMs: 500 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("not_configured");
    expect(result.error.message).toContain("ETSY_API_KEY");
  });

  it("passes SHOPIFY_MCP_SHOPS through to the shopify adapter's allowed hosts", () => {
    const adapters = buildAdaptersFromEnv({ SHOPIFY_MCP_SHOPS: "www.allbirds.com,www.rothys.com" });
    const shopify = adapters.find((a) => a.manifest.id === "shopify")!;
    expect(shopify.manifest.permissions.allowedHosts).toContain("www.allbirds.com");
    expect(shopify.manifest.permissions.allowedHosts).toContain("www.rothys.com");
  });

  it("includes the demo sponsored adapter ONLY when NORTHCINDER_DEMO_SPONSORED_ADAPTER=1", () => {
    const without = buildAdaptersFromEnv({});
    expect(without.map((a) => a.manifest.id)).not.toContain(DEMO_SPONSORED_STORE_ID);

    const withDemo = buildAdaptersFromEnv({ NORTHCINDER_DEMO_SPONSORED_ADAPTER: "1" });
    expect(withDemo.map((a) => a.manifest.id)).toContain(DEMO_SPONSORED_STORE_ID);
  });
});

describe("demo sponsored adapter — the clearly-labeled synthetic sponsored-worse offer", () => {
  it("returns exactly one offer, marked sponsored:true and unmistakably labeled as a demo", async () => {
    const adapter = createDemoSponsoredAdapter();
    const result = await adapter.search({ text: "wool runner shoes" }, { timeoutMs: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.offers).toHaveLength(1);
    const offer = result.offers[0]!;
    expect(offer.sponsored).toBe(true);
    expect(offer.product.title).toContain("[DEMO sponsored placement]");
    expect(offer.product.title).toContain("wool runner shoes");
    expect(offer.sourceStore).toBe(DEMO_SPONSORED_STORE_ID);
    expect(offer.merchant.domain).toBe("demo-sponsored.invalid");
  });

  it("declares no network permissions — it is synthetic by construction", () => {
    const adapter = createDemoSponsoredAdapter();
    expect(adapter.manifest.permissions.allowedHosts).toEqual([]);
    expect(adapter.manifest.description).toContain("demo");
  });

  it("its offer ranks BELOW every non-sponsored offer even at the lowest price, with the reason attached", async () => {
    const adapter = createDemoSponsoredAdapter({ priceMinor: 100 }); // absurdly cheap: $1.00
    const result = await adapter.search({ text: "sneakers" }, { timeoutMs: 100 });
    if (!result.ok) throw new Error("unreachable");
    const demoOffer = result.offers[0]!;
    const organic = {
      ...demoOffer,
      id: "organic-1",
      sponsored: false,
      sourceStore: "shopify",
      merchant: { id: "real.example", name: "Real Store", domain: "real.example" },
      price: { amount: 9800, currency: "USD" as const },
    };
    const ranked = rankOffers([demoOffer, organic], { text: "sneakers" });
    expect(ranked[0]!.offer.id).toBe("organic-1");
    expect(ranked[1]!.offer.id).toBe(demoOffer.id);
    expect(ranked[1]!.reasons.map((r) => r.criterion)).toContain("sponsored_deprioritization");
  });
});
