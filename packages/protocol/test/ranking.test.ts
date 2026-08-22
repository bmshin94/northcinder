import { describe, expect, it } from "vitest";
import type { Offer, SearchQuery, TrustSignal } from "../src/index.js";
import { RankedResultSchema } from "../src/index.js";
import {
  rankOffers,
  SPONSORED_DEPRIORITIZATION_DETAIL,
} from "../src/ranking/rank.js";
import { trustKey } from "../src/trust/key.js";

function makeOffer(overrides: {
  id: string;
  priceAmount: number;
  sponsored: boolean;
  title?: string;
  attributes?: Record<string, string>;
  merchantId?: string;
  availability?: Offer["availability"];
  sourceStore?: string;
}): Offer {
  return {
    id: overrides.id,
    product: {
      id: `prod-${overrides.id}`,
      title: overrides.title ?? `Product ${overrides.id}`,
      url: `https://shop.example/products/${overrides.id}`,
      attributes: overrides.attributes ?? {},
    },
    price: { amount: overrides.priceAmount, currency: "EUR" },
    merchant: {
      id: overrides.merchantId ?? "shop-example",
      name: "Shop Example",
      domain: "shop.example",
    },
    availability: overrides.availability ?? "in_stock",
    sourceStore: overrides.sourceStore ?? "test-store",
    sponsored: overrides.sponsored,
  };
}

const QUERY: SearchQuery = { text: "usb-c hub" };

describe("rankOffers — the DoD neutrality test", () => {
  it("ranks a criteria-worse sponsored offer below the non-sponsored best, with exact reasons", () => {
    // Sponsored offer is WORSE on the user's criteria (more expensive).
    const sponsoredWorse = makeOffer({ id: "b-sponsored", priceAmount: 59900, sponsored: true });
    const organicBest = makeOffer({ id: "a-organic", priceAmount: 49900, sponsored: false });

    const results = rankOffers([sponsoredWorse, organicBest], QUERY);

    expect(results).toHaveLength(2);
    // Winner is the non-sponsored, criteria-best offer.
    expect(results[0]!.offer.id).toBe("a-organic");
    expect(results[1]!.offer.id).toBe("b-sponsored");

    // The winner's reasons cite the ACTUAL criterion with the exact price advantage.
    expect(results[0]!.reasons).toContainEqual({
      criterion: "price",
      detail: "lowest price: 49900 EUR, 10000 EUR cheaper than the next offer",
    });

    // The sponsored offer stays labeled and carries the de-prioritization reason.
    expect(results[1]!.offer.sponsored).toBe(true);
    expect(results[1]!.reasons).toContainEqual({
      criterion: "sponsored_deprioritization",
      detail: SPONSORED_DEPRIORITIZATION_DETAIL,
    });
    expect(results[1]!.reasons).toContainEqual({
      criterion: "price",
      detail: "price: 59900 EUR, 10000 EUR above the cheapest offer",
    });

    // Every result validates against the protocol schema (non-empty reasons enforced).
    for (const r of results) expect(RankedResultSchema.parse(r)).toBeTruthy();
  });

  it("a sponsored offer NEVER outranks any non-sponsored offer, even a criteria-worse one", () => {
    const sponsoredCheap = makeOffer({ id: "sp-cheap", priceAmount: 1000, sponsored: true });
    const organicPricey = makeOffer({ id: "org-pricey", priceAmount: 99900, sponsored: false });

    const results = rankOffers([sponsoredCheap, organicPricey], QUERY);
    expect(results.map((r) => r.offer.id)).toEqual(["org-pricey", "sp-cheap"]);
  });
});

describe("rankOffers — criteria scoring & reasons", () => {
  it("marks every failed required named criterion with its stable code and audit metadata", () => {
    const base = makeOffer({ id: "candidate", priceAmount: 60_000, sponsored: false, availability: "preorder" });
    const late = { ...base, shipping: { deliveryBy: "2026-09-10" } };
    const cases = [
      {
        offer: base,
        criterion: { id: "storage", label: "128GB", importance: "required", kind: "attribute", value: "128GB" },
        code: "required_attribute_missing",
      },
      {
        offer: base,
        criterion: { id: "budget", label: "Budget", importance: "required", kind: "max_price", value: { amount: 50_000, currency: "EUR" } },
        code: "required_price_exceeded",
      },
      {
        offer: late,
        criterion: { id: "delivery", label: "Delivery", importance: "required", kind: "delivery_by", value: "2026-09-01" },
        code: "required_delivery_missed",
      },
      {
        offer: base,
        criterion: { id: "delivery-known", label: "Known delivery", importance: "required", kind: "delivery_by", value: "2026-09-01" },
        code: "required_delivery_unknown",
      },
      {
        offer: base,
        criterion: { id: "ethics", label: "Fair trade", importance: "required", kind: "ethics", value: "fair-trade" },
        code: "required_ethics_missing",
      },
      {
        offer: base,
        criterion: { id: "stock", label: "In stock", importance: "required", kind: "availability", value: "in_stock" },
        code: "required_availability_mismatch",
      },
    ] as const;

    for (const testCase of cases) {
      const result = rankOffers([testCase.offer], { text: "phone", criteria: [testCase.criterion] })[0]!;
      expect(result.reasons).toContainEqual(
        expect.objectContaining({
          criterionId: testCase.criterion.id,
          importance: "required",
          code: testCase.code,
        }),
      );
    }

    const qualified = makeOffer({ id: "qualified", priceAmount: 80_000, sponsored: false, attributes: { storage: "128GB" } });
    const eliminated = makeOffer({ id: "eliminated", priceAmount: 10_000, sponsored: false });
    const requiredAttribute = cases[0].criterion;
    expect(
      rankOffers([eliminated, qualified], { text: "phone", criteria: [requiredAttribute] }).map((result) => result.offer.id),
    ).toEqual(["qualified", "eliminated"]);

    const sponsoredQualified = { ...qualified, id: "sponsored-qualified", sponsored: true };
    expect(
      rankOffers([sponsoredQualified, eliminated], { text: "phone", criteria: [requiredAttribute] }).map((result) => result.offer.id),
    ).toEqual(["eliminated", "sponsored-qualified"]);
  });

  it("awards fixed code-owned points for preferred matches without eliminating misses", () => {
    const matching = {
      ...makeOffer({
        id: "match",
        priceAmount: 60_000,
        sponsored: false,
        attributes: { storage: "128GB", sourcing: "fair-trade" },
        availability: "in_stock",
      }),
      shipping: { deliveryBy: "2026-08-25" },
    };
    const missing = makeOffer({ id: "miss", priceAmount: 60_000, sponsored: false, availability: "preorder" });
    const cases = [
      {
        criterion: { id: "storage", label: "128GB", importance: "preferred", kind: "attribute", value: "128GB" },
        points: 12,
      },
      {
        criterion: { id: "budget", label: "Budget", importance: "preferred", kind: "max_price", value: { amount: 70_000, currency: "EUR" } },
        points: 10,
      },
      {
        criterion: { id: "arrival", label: "Delivery", importance: "preferred", kind: "delivery_by", value: "2026-09-01" },
        points: 8,
      },
      {
        criterion: { id: "ethics", label: "Fair trade", importance: "preferred", kind: "ethics", value: "fair-trade" },
        points: 6,
      },
      {
        criterion: { id: "stock", label: "In stock", importance: "preferred", kind: "availability", value: "in_stock" },
        points: 4,
      },
    ] as const;

    for (const testCase of cases) {
      const baseline = rankOffers([matching], QUERY)[0]!.score;
      const preferred = rankOffers([matching], { text: "phone", criteria: [testCase.criterion] })[0]!;
      expect(preferred.score - baseline, testCase.criterion.kind).toBe(testCase.points);
      expect(preferred.reasons).toContainEqual(
        expect.objectContaining({ criterionId: testCase.criterion.id, importance: "preferred" }),
      );

      const missOffer =
        testCase.criterion.kind === "max_price"
          ? makeOffer({ id: "over-budget", priceAmount: 80_000, sponsored: false })
          : missing;
      const missBaseline = rankOffers([missOffer], QUERY)[0]!.score;
      const missed = rankOffers([missOffer], { text: "phone", criteria: [testCase.criterion] })[0]!;
      const missedReason = missed.reasons.find((reason) => reason.criterionId === testCase.criterion.id)!;
      expect(missed.score).toBe(missBaseline);
      expect(missedReason.importance).toBe("preferred");
      expect(missedReason.code).toBeUndefined();
    }

    const attributeMatch = makeOffer({
      id: "z-match",
      priceAmount: 60_000,
      sponsored: false,
      attributes: { storage: "128GB" },
    });
    const attributeMiss = makeOffer({ id: "a-miss", priceAmount: 60_000, sponsored: false });
    expect(rankOffers([attributeMatch, attributeMiss], QUERY).map((result) => result.offer.id)).toEqual([
      "a-miss",
      "z-match",
    ]);
    const ordered = rankOffers([attributeMiss, attributeMatch], {
      text: "phone",
      criteria: [cases[0].criterion],
    });
    expect(ordered.map((result) => result.offer.id)).toEqual(["z-match", "a-miss"]);
    const sponsoredMatch = { ...attributeMatch, id: "sponsored-match", sponsored: true };
    expect(
      rankOffers([sponsoredMatch, attributeMiss], {
        text: "phone",
        criteria: [cases[0].criterion],
      }).map((result) => result.offer.id),
    ).toEqual(["a-miss", "sponsored-match"]);
  });

  it("uses zero-point typed tie breakers only after main scores tie and remains input-order independent", () => {
    const attributeMatch = makeOffer({ id: "z-match", priceAmount: 10_000, sponsored: false, attributes: { storage: "128GB" } });
    const attributeMiss = makeOffer({ id: "a-miss", priceAmount: 10_000, sponsored: false });
    const attributeCriterion = {
      id: "storage-tie",
      label: "128GB",
      importance: "tie_breaker",
      kind: "attribute",
      value: "128GB",
    } as const;
    const baselineScores = Object.fromEntries(rankOffers([attributeMatch, attributeMiss], QUERY).map((result) => [result.offer.id, result.score]));
    const attributeRanked = rankOffers([attributeMiss, attributeMatch], { text: "phone", criteria: [attributeCriterion] });
    expect(attributeRanked.map((result) => result.offer.id)).toEqual(["z-match", "a-miss"]);
    expect(Object.fromEntries(attributeRanked.map((result) => [result.offer.id, result.score]))).toEqual(baselineScores);
    expect(attributeRanked[0]!.reasons).toContainEqual(
      expect.objectContaining({ criterionId: "storage-tie", importance: "tie_breaker" }),
    );
    expect(rankOffers([attributeMatch, attributeMiss], { text: "phone", criteria: [attributeCriterion] })).toEqual(attributeRanked);

    const earlier = { ...makeOffer({ id: "z-earlier", priceAmount: 10_000, sponsored: false }), shipping: { deliveryBy: "2026-08-25" } };
    const unknown = makeOffer({ id: "a-unknown", priceAmount: 10_000, sponsored: false });
    expect(
      rankOffers([unknown, earlier], {
        text: "phone",
        criteria: [{ id: "delivery-tie", label: "Earlier", importance: "tie_breaker", kind: "delivery_by", value: "2026-09-01" }],
      }).map((result) => result.offer.id),
    ).toEqual(["z-earlier", "a-unknown"]);

    const ethical = makeOffer({ id: "z-ethical", priceAmount: 10_000, sponsored: false, attributes: { sourcing: "fair-trade" } });
    const ordinary = makeOffer({ id: "a-ordinary", priceAmount: 10_000, sponsored: false });
    expect(
      rankOffers([ordinary, ethical], {
        text: "phone",
        criteria: [{ id: "ethics-tie", label: "Fair trade", importance: "tie_breaker", kind: "ethics", value: "fair-trade" }],
      }).map((result) => result.offer.id),
    ).toEqual(["z-ethical", "a-ordinary"]);

    const preorder = makeOffer({ id: "z-preorder", priceAmount: 10_000, sponsored: false, availability: "preorder", merchantId: "preorder-shop" });
    const unknownStock = makeOffer({ id: "a-unknown", priceAmount: 10_000, sponsored: false, availability: "unknown", merchantId: "unknown-shop" });
    const preorderTrust: Record<string, TrustSignal> = {
      [trustKey(preorder.merchant)]: {
        merchantId: preorder.merchant.id,
        level: "known",
        evidence: [{ source: "test", detail: "offsets the legacy preorder penalty" }],
      },
    };
    expect(
      rankOffers(
        [unknownStock, preorder],
        { text: "phone", criteria: [{ id: "stock-tie", label: "Preorder", importance: "tie_breaker", kind: "availability", value: "preorder" }] },
        { trust: preorderTrust },
      ).map((result) => result.offer.id),
    ).toEqual(["z-preorder", "a-unknown"]);

    const cheapMatch = makeOffer({ id: "match", priceAmount: 20_000, sponsored: false, attributes: { storage: "128GB" } });
    const cheapMiss = makeOffer({ id: "miss", priceAmount: 10_000, sponsored: false });
    expect(
      rankOffers([cheapMatch, cheapMiss], { text: "phone", criteria: [attributeCriterion] })[0]!.offer.id,
    ).toBe("miss");

    const low = makeOffer({ id: "low", priceAmount: 10_000, sponsored: false });
    const high = makeOffer({ id: "high", priceAmount: 20_000, sponsored: false });
    expect(
      rankOffers([high, low], {
        text: "phone",
        criteria: [{ id: "price-tie", label: "Lower", importance: "tie_breaker", kind: "max_price", value: { amount: 30_000, currency: "EUR" } }],
      }).map((result) => result.offer.id),
    ).toEqual(["low", "high"]);
  });

  it("cites matched must-have attributes and ranks the matching offer first", () => {
    const matching = makeOffer({
      id: "match",
      priceAmount: 60000,
      sponsored: false,
      attributes: { storage: "128GB", "removable battery": "yes" },
    });
    const cheaperButMissing = makeOffer({ id: "miss", priceAmount: 30000, sponsored: false });

    const query: SearchQuery = { text: "phone", mustHaveAttributes: ["128GB", "removable battery"] };
    const results = rankOffers([cheaperButMissing, matching], query);

    expect(results[0]!.offer.id).toBe("match");
    expect(results[0]!.reasons).toContainEqual({
      criterion: "spec_match",
      detail: "matches 2/2 required attributes: 128GB, removable battery",
    });
    expect(results[1]!.reasons).toContainEqual({
      criterion: "spec_match",
      detail: "matches 0/2 required attributes; missing: 128GB, removable battery",
      code: "spec_missing",
    });
  });

  it("penalizes flagged merchants and carries a flagged_merchant reason with the evidence", () => {
    const shady = makeOffer({ id: "shady", priceAmount: 10000, sponsored: false, merchantId: "shady-shop" });
    const safe = makeOffer({ id: "safe", priceAmount: 12000, sponsored: false, merchantId: "shop-example" });
    // Maps are keyed by trustKey(merchant): fixture ids differ from the shared
    // "shop.example" domain, so each gets a domain#id sub-key.
    const trust: Record<string, TrustSignal> = {
      "shop.example#shady-shop": {
        merchantId: "shady-shop",
        level: "flagged",
        evidence: [{ source: "seed-list", detail: "merchant is on the deny seed list" }],
      },
      "shop.example#shop-example": {
        merchantId: "shop-example",
        level: "trusted",
        evidence: [{ source: "seed-list", detail: "merchant is on the allow seed list" }],
      },
    };

    const results = rankOffers([shady, safe], QUERY, { trust });
    expect(results[0]!.offer.id).toBe("safe");
    expect(results[0]!.reasons).toContainEqual({
      criterion: "trust",
      detail: 'merchant "shop-example" trust level: trusted (merchant is on the allow seed list)',
    });
    expect(results[1]!.reasons).toContainEqual({
      criterion: "flagged_merchant",
      detail: 'merchant "shady-shop" is flagged: merchant is on the deny seed list',
    });
  });

  it("gives an explicit unknown signal zero points and reserves the penalty for deny evidence", () => {
    const offer = makeOffer({ id: "new-shop", priceAmount: 10000, sponsored: false });
    const baseline = rankOffers([offer], QUERY)[0]!;
    const unknown = rankOffers([offer], QUERY, {
      trust: {
        [trustKey(offer.merchant)]: {
          merchantId: offer.merchant.id,
          level: "unknown",
          evidence: [{ source: "default-unknown", detail: "no verified history" }],
        },
      },
    })[0]!;
    expect(unknown.score).toBe(baseline.score);
    expect(unknown.reasons).toContainEqual({
      criterion: "trust",
      detail: 'merchant "shop-example" trust level: unknown (no verified history)',
    });
    expect(unknown.reasons.some((reason) => reason.criterion === "flagged_merchant")).toBe(false);
  });

  it("is deterministic: same input always yields the identical output", () => {
    const offers = [
      makeOffer({ id: "x", priceAmount: 100, sponsored: false }),
      makeOffer({ id: "y", priceAmount: 100, sponsored: false }),
      makeOffer({ id: "z", priceAmount: 100, sponsored: true }),
    ];
    const a = rankOffers(offers, QUERY);
    const b = rankOffers([...offers].reverse(), QUERY);
    expect(a).toEqual(b);
  });

  it("uses the full store-scoped offer tuple as the final total-order key", () => {
    const alpha = makeOffer({ id: "same-id", sourceStore: "alpha", priceAmount: 100, sponsored: false });
    const beta = makeOffer({ id: "same-id", sourceStore: "beta", priceAmount: 100, sponsored: false });
    const forward = rankOffers([beta, alpha], QUERY);
    const reversed = rankOffers([alpha, beta], QUERY);
    expect(forward).toEqual(reversed);
    expect(forward.map((result) => result.offer.sourceStore)).toEqual(["alpha", "beta"]);
  });
});

describe("rankOffers — property: sponsored:true never raises rank", () => {
  // Deterministic LCG so the property run is reproducible.
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it("for random offer sets, flipping any offer to sponsored:true never improves its position", () => {
    const rnd = lcg(20260704);
    for (let iter = 0; iter < 200; iter++) {
      const n = 2 + Math.floor(rnd() * 8);
      const offers: Offer[] = Array.from({ length: n }, (_, i) =>
        makeOffer({
          id: `o${i}`,
          priceAmount: 100 + Math.floor(rnd() * 100000),
          sponsored: rnd() < 0.3,
          availability: rnd() < 0.8 ? "in_stock" : "out_of_stock",
        }),
      );
      const target = Math.floor(rnd() * n);
      if (offers[target]!.sponsored) continue; // already sponsored — nothing to flip

      const before = rankOffers(offers, QUERY);
      const flipped = offers.map((o, i) => (i === target ? { ...o, sponsored: true } : o));
      const after = rankOffers(flipped, QUERY);

      const rankBefore = before.findIndex((r) => r.offer.id === `o${target}`);
      const rankAfter = after.findIndex((r) => r.offer.id === `o${target}`);
      expect(rankAfter).toBeGreaterThanOrEqual(rankBefore);
      // And it is labeled.
      expect(after[rankAfter]!.offer.sponsored).toBe(true);
      expect(
        after[rankAfter]!.reasons.some((r) => r.criterion === "sponsored_deprioritization"),
      ).toBe(true);
    }
  });
});

describe("rankOffers — availability tier: out-of-stock never outranks a buyable offer", () => {
  it("the cheapest offer, if out of stock, still ranks below every buyable non-sponsored offer", () => {
    const offers = [
      makeOffer({ id: "oos-cheapest", priceAmount: 4000, sponsored: false, availability: "out_of_stock" }),
      makeOffer({ id: "instock-mid", priceAmount: 9000, sponsored: false, availability: "in_stock" }),
      makeOffer({ id: "preorder-high", priceAmount: 12000, sponsored: false, availability: "preorder" }),
      makeOffer({ id: "unknown-avail", priceAmount: 15000, sponsored: false, availability: "unknown" }),
    ];
    const ranked = rankOffers(offers, QUERY);
    expect(ranked[ranked.length - 1]!.offer.id).toBe("oos-cheapest");
    // Reason names the tiering, machine-readably (code) and honestly (detail).
    const oosReason = ranked[ranked.length - 1]!.reasons.find((r) => r.criterion === "availability")!;
    expect(oosReason.code).toBe("out_of_stock");
    expect(oosReason.detail).toContain("out of stock");
  });

  it("sponsored tier stays PRIMARY: an organic out-of-stock offer still outranks a sponsored in-stock one", () => {
    const offers = [
      makeOffer({ id: "sponsored-instock", priceAmount: 4000, sponsored: true, availability: "in_stock" }),
      makeOffer({ id: "organic-oos", priceAmount: 9000, sponsored: false, availability: "out_of_stock" }),
    ];
    const ranked = rankOffers(offers, QUERY);
    expect(ranked.map((r) => r.offer.id)).toEqual(["organic-oos", "sponsored-instock"]);
  });

  it("property: flipping any offer to out_of_stock never improves its position", () => {
    function lcg(seed: number): () => number {
      let s = seed >>> 0;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
      };
    }
    const rnd = lcg(20260711);
    for (let iter = 0; iter < 200; iter++) {
      const n = 2 + Math.floor(rnd() * 8);
      const offers: Offer[] = Array.from({ length: n }, (_, i) =>
        makeOffer({
          id: `o${i}`,
          priceAmount: 100 + Math.floor(rnd() * 100000),
          sponsored: rnd() < 0.3,
          availability: rnd() < 0.8 ? "in_stock" : rnd() < 0.5 ? "preorder" : "unknown",
        }),
      );
      const target = Math.floor(rnd() * n);
      const before = rankOffers(offers, QUERY);
      const flipped: Offer[] = offers.map((o, i) =>
        i === target ? { ...o, availability: "out_of_stock" as const } : o,
      );
      const after = rankOffers(flipped, QUERY);
      const rankBefore = before.findIndex((r) => r.offer.id === `o${target}`);
      const rankAfter = after.findIndex((r) => r.offer.id === `o${target}`);
      expect(rankAfter, `iter ${iter}: out_of_stock must never raise rank`).toBeGreaterThanOrEqual(rankBefore);
    }
  });
});

// ---------------------------------------------------------------------------
// Trust-map keying — collision regression (trust-corpus spec §5.1)
// ---------------------------------------------------------------------------

describe("rankOffers — trust lookup is keyed by trustKey, not bare merchant.id", () => {
  function offerFrom(id: string, merchant: Offer["merchant"], priceAmount: number): Offer {
    return {
      id,
      product: { id: `prod-${id}`, title: `Product ${id}`, url: `https://${merchant.domain}/p/${id}`, attributes: {} },
      price: { amount: priceAmount, currency: "EUR" },
      merchant,
      availability: "in_stock",
      sourceStore: merchant.domain,
      sponsored: false,
    };
  }

  it("two stores with a COLLIDING merchant.id on different domains consume DISTINCT trust signals", () => {
    const alpha = { id: "shop", name: "Alpha Shop", domain: "alpha.example" };
    const beta = { id: "shop", name: "Beta Shop", domain: "beta.example" };
    const offers = [offerFrom("a1", alpha, 10000), offerFrom("b1", beta, 10000)];
    const trust: Record<string, TrustSignal> = {
      [trustKey(alpha)]: {
        merchantId: alpha.id,
        level: "flagged",
        evidence: [{ source: "seed-list", detail: "merchant is on the deny seed list" }],
      },
      [trustKey(beta)]: {
        merchantId: beta.id,
        level: "trusted",
        evidence: [{ source: "seed-list", detail: "merchant is on the allow seed list" }],
      },
    };

    const results = rankOffers(offers, QUERY, { trust });
    // Before the trustKey migration both offers shared one signal ("shop").
    // Now: beta's offer wins (trusted), alpha's is flagged — distinct signals.
    expect(results[0]!.offer.merchant.domain).toBe("beta.example");
    expect(results[0]!.reasons.some((r) => r.criterion === "trust" && r.detail.includes("trusted"))).toBe(true);
    expect(results[1]!.offer.merchant.domain).toBe("alpha.example");
    expect(results[1]!.reasons.some((r) => r.criterion === "flagged_merchant")).toBe(true);
  });

  it("two marketplace sellers on ONE shared domain consume distinct sub-keyed signals", () => {
    const seller1 = { id: "seller-1", name: "Seller One", domain: "market.example" };
    const seller2 = { id: "seller-2", name: "Seller Two", domain: "market.example" };
    const offers = [offerFrom("s1", seller1, 10000), offerFrom("s2", seller2, 10000)];
    const trust: Record<string, TrustSignal> = {
      [trustKey(seller1)]: {
        merchantId: seller1.id,
        level: "flagged",
        evidence: [{ source: "seed-list", detail: "merchant is on the deny seed list" }],
      },
      [trustKey(seller2)]: {
        merchantId: seller2.id,
        level: "known",
        evidence: [{ source: "platform-heuristic", detail: "listing on an established marketplace" }],
      },
    };

    const results = rankOffers(offers, QUERY, { trust });
    expect(results[0]!.offer.merchant.id).toBe("seller-2");
    expect(results[0]!.reasons.some((r) => r.criterion === "trust" && r.detail.includes("known"))).toBe(true);
    expect(results[1]!.reasons.some((r) => r.criterion === "flagged_merchant")).toBe(true);
  });
});
