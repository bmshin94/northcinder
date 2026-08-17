import { describe, expect, it } from "vitest";
import { rankOffers } from "@northcinder/protocol";
import { buildAdaptersFromEnv } from "../src/adapters-from-env.js";
import { createDemoSponsoredAdapter, DEMO_SPONSORED_STORE_ID } from "../src/demo/sponsored-demo-adapter.js";

describe("buildAdaptersFromEnv — real-adapter service wiring (client integration)", () => {
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
