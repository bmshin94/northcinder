import { describe, expect, it } from "vitest";
import { trustKey } from "../src/trust/key.js";
import { MerchantSchema } from "../src/schemas/core.js";

describe("trustKey — canonical, collision-safe trust-map key (spec §5.1)", () => {
  it("is the bare domain for a domain-anchored store (id === domain)", () => {
    expect(
      trustKey({ id: "www.allbirds.com", domain: "www.allbirds.com" }),
    ).toBe("www.allbirds.com");
  });

  it("is domain#id for a sub-merchant whose id differs from the domain", () => {
    expect(trustKey({ id: "seller-42", domain: "ebay.com" })).toBe("ebay.com#seller-42");
  });

  it("keeps two stores with a colliding merchant.id on DISTINCT keys", () => {
    const a = trustKey({ id: "shop", domain: "alpha.example" });
    const b = trustKey({ id: "shop", domain: "beta.example" });
    expect(a).not.toBe(b);
  });

  it("keeps two marketplace sellers on ONE shared domain on DISTINCT sub-keys", () => {
    const a = trustKey({ id: "seller-1", domain: "market.example" });
    const b = trustKey({ id: "seller-2", domain: "market.example" });
    expect(a).not.toBe(b);
    expect(a).toBe("market.example#seller-1");
    expect(b).toBe("market.example#seller-2");
  });

  it("is deterministic: same merchant → identical key", () => {
    const m = { id: "seller-1", domain: "market.example" };
    expect(trustKey(m)).toBe(trustKey({ ...m }));
  });

  // --- adversarial: the "#" injection collision (BLOCKER, fixed) ---
  it("is collision-safe: a hostile id/domain containing the '#' delimiter cannot exist (MerchantSchema rejects it)", () => {
    // The attack: craft a merchant whose id === domain === a legit sub-merchant's key,
    // so trustKey() would collapse them and let the attacker poison the real signal.
    const legit = { id: "seller-1", name: "S1", domain: "ebay.com" };
    const attacker = { id: "ebay.com#seller-1", name: "evil", domain: "ebay.com#seller-1" };
    // Both would produce the SAME key if allowed:
    expect(trustKey(attacker)).toBe(trustKey(legit));
    // ...which is exactly why the schema forbids the '#' — the attacker merchant
    // can never enter the ranking pipeline (every offer is OfferSchema-parsed).
    expect(MerchantSchema.safeParse(legit).success).toBe(true);
    expect(MerchantSchema.safeParse(attacker).success).toBe(false);
    // A '#' anywhere in either field is rejected.
    expect(MerchantSchema.safeParse({ id: "a#b", name: "x", domain: "shop.example" }).success).toBe(false);
    expect(MerchantSchema.safeParse({ id: "seller", name: "x", domain: "shop#.example" }).success).toBe(false);
  });
});
