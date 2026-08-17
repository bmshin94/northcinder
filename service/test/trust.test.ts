import { describe, expect, it } from "vitest";
import { TrustSignalSchema, type Merchant } from "@northcinder/protocol";
import { createSeedTrustProvider } from "../src/trust/seed-trust.js";

function merchant(overrides: Partial<Merchant> & { id: string; domain: string }): Merchant {
  return { name: overrides.id, ...overrides };
}

describe("seed trust provider (spec §4 invariant 6)", () => {
  it("an unmatched merchant comes back explicitly UNKNOWN with explanatory evidence — never silently trusted, never earning points", async () => {
    // "unknown" is an explicit signal + evidence (invariant 6: never SILENT)
    // and contributes zero ranking points. "flagged" (−40) is reserved for
    // deny-listed evidence — absence of history is not evidence of harm.
    const trust = createSeedTrustProvider();
    const signal = await trust.trustSignal(
      merchant({ id: "totally-new-shop.example", domain: "totally-new-shop.example" }),
    );

    expect(signal.level).toBe("unknown");
    expect(signal.merchantId).toBe("totally-new-shop.example");
    expect(signal.evidence).toContainEqual({
      source: "default-unknown",
      detail:
        'merchant "totally-new-shop.example" (totally-new-shop.example) is not in the trust seed and has no buyer-outcome history — explicitly unknown, never silently trusted',
    });
    expect(TrustSignalSchema.parse(signal)).toBeTruthy();
  });

  it("an allow-seeded merchant returns its seeded level with seed-list evidence", async () => {
    const trust = createSeedTrustProvider({
      allow: [{ domain: "reference.invalid", detail: "conformance reference store" }],
    });
    const signal = await trust.trustSignal(
      merchant({ id: "reference-shop", domain: "reference.invalid" }),
    );
    expect(signal.level).toBe("trusted");
    expect(signal.evidence).toContainEqual({
      source: "seed-list",
      detail: "allow-listed: conformance reference store",
    });
  });

  it("a deny-seeded merchant is flagged with the deny evidence", async () => {
    const trust = createSeedTrustProvider({
      deny: [{ domain: "scam.example", detail: "reported counterfeit storefront" }],
    });
    const signal = await trust.trustSignal(merchant({ id: "scam", domain: "scam.example" }));
    expect(signal.level).toBe("flagged");
    expect(signal.evidence).toContainEqual({
      source: "seed-list",
      detail: "deny-listed: reported counterfeit storefront",
    });
  });

  it("known major platforms rate 'known' via the platform heuristic (incl. subdomains)", async () => {
    const trust = createSeedTrustProvider();
    const shopify = await trust.trustSignal(
      merchant({ id: "cool-socks", domain: "cool-socks.myshopify.com" }),
    );
    expect(shopify.level).toBe("known");
    expect(shopify.evidence[0]!.source).toBe("platform-heuristic");

    const ebay = await trust.trustSignal(merchant({ id: "ebay", domain: "www.ebay.com" }));
    expect(ebay.level).toBe("known");
  });

  it("a self-declared platform hint NEVER raises trust: evil.example claiming shopify stays unknown, never 'known'", async () => {
    // Merchant.platform is seller-controlled (adapter-translated store output, and
    // /v1/trust accepts it straight from the request body). It must never move a
    // merchant above the unknown default — only the verifiable DOMAIN suffix counts.
    const trust = createSeedTrustProvider();
    const signal = await trust.trustSignal(
      merchant({ id: "evil", domain: "evil.example", platform: "shopify" }),
    );
    expect(signal.level).toBe("unknown");
    expect(signal.evidence).toContainEqual({
      source: "default-unknown",
      detail:
        'merchant "evil" (evil.example) is not in the trust seed and has no buyer-outcome history — explicitly unknown, never silently trusted',
    });
  });

  it("deny beats allow beats platform heuristic", async () => {
    const trust = createSeedTrustProvider({
      allow: [{ domain: "shop.example", detail: "vetted" }],
      deny: [{ domain: "shop.example", detail: "later reported fraud" }],
    });
    const signal = await trust.trustSignal(merchant({ id: "shop", domain: "shop.example" }));
    expect(signal.level).toBe("flagged");
  });
});
