import { describe, expect, it } from "vitest";
import type { Offer, SearchQuery, TrustSignal } from "../src/index.js";
import { SearchRankResponseSchema } from "../src/index.js";
import { rankOffers } from "../src/ranking/rank.js";
import { verifySearchRanking } from "../src/ranking/verify.js";

function makeOffer(overrides: {
  id: string;
  priceAmount: number;
  sponsored: boolean;
  merchantId?: string;
  sourceStore?: string;
}): Offer {
  return {
    id: overrides.id,
    product: {
      id: `prod-${overrides.id}`,
      title: `Product ${overrides.id}`,
      url: `https://shop.example/products/${overrides.id}`,
      attributes: {},
    },
    price: { amount: overrides.priceAmount, currency: "EUR" },
    merchant: {
      id: overrides.merchantId ?? "shop-example",
      name: "Shop Example",
      domain: "shop.example",
    },
    availability: "in_stock",
    sourceStore: overrides.sourceStore ?? "test-store",
    sponsored: overrides.sponsored,
  };
}

const QUERY: SearchQuery = { text: "usb-c hub" };

const TRUST: Record<string, TrustSignal> = {
  // trustKey({ id: "shop-example", domain: "shop.example" })
  "shop.example#shop-example": {
    merchantId: "shop-example",
    level: "trusted",
    evidence: [{ source: "seed-list", detail: "merchant is on the allow seed list" }],
  },
};

describe("SearchRankResponse — backward-compatible trustSignals extension", () => {
  it("accepts a response WITHOUT trustSignals (old services still validate)", () => {
    const legacy = { results: [], storeStatuses: [] };
    expect(SearchRankResponseSchema.parse(legacy)).toEqual({ results: [], storeStatuses: [] });
  });

  it("accepts and preserves trustSignals keyed by trustKey", () => {
    const parsed = SearchRankResponseSchema.parse({
      results: [],
      storeStatuses: [],
      trustSignals: TRUST,
    });
    expect(parsed.trustSignals).toEqual(TRUST);
  });
});

describe("verifySearchRanking — client-side recomputation of the open ranking", () => {
  const offers = [
    makeOffer({ id: "a", priceAmount: 10000, sponsored: false }),
    makeOffer({ id: "b", priceAmount: 20000, sponsored: false }),
    makeOffer({ id: "c", priceAmount: 5000, sponsored: true }),
  ];

  it("verifies an honest service response: recomputed order, scores and reasons all match", () => {
    const honest = {
      results: rankOffers(offers, QUERY, { trust: TRUST }),
      trustSignals: TRUST,
    };
    const v = verifySearchRanking(honest, QUERY);
    expect(v).toEqual({ verified: true, comparedOffers: 3 });
  });

  it("flags a boosted re-order with the EXACT divergence per position", () => {
    const ranked = rankOffers(offers, QUERY, { trust: TRUST });
    // Tamper: a "boosted" service moves the last (sponsored) offer to the top.
    const boosted = [ranked[2]!, ranked[0]!, ranked[1]!];
    const v = verifySearchRanking({ results: boosted, trustSignals: TRUST }, QUERY);
    expect(v.verified).toBe(false);
    if (v.verified !== false) throw new Error("unreachable");
    const orderDivergences = v.divergences.filter((d) => d.kind === "order_mismatch");
    expect(orderDivergences).toEqual([
      {
        kind: "order_mismatch",
        position: 1,
        expected: { offerKey: '["test-store","a"]', score: ranked[0]!.score },
        actual: { offerKey: '["test-store","c"]', score: ranked[2]!.score },
      },
      {
        kind: "order_mismatch",
        position: 2,
        expected: { offerKey: '["test-store","b"]', score: ranked[1]!.score },
        actual: { offerKey: '["test-store","a"]', score: ranked[0]!.score },
      },
      {
        kind: "order_mismatch",
        position: 3,
        expected: { offerKey: '["test-store","c"]', score: ranked[2]!.score },
        actual: { offerKey: '["test-store","b"]', score: ranked[1]!.score },
      },
    ]);
    expect(v.expectedOrder).toEqual(['["test-store","a"]', '["test-store","b"]', '["test-store","c"]']);
    expect(v.actualOrder).toEqual(['["test-store","c"]', '["test-store","a"]', '["test-store","b"]']);
  });

  it("flags a service that keeps the order but inflates a score", () => {
    const ranked = rankOffers(offers, QUERY, { trust: TRUST });
    const inflated = ranked.map((r, i) => (i === 0 ? { ...r, score: r.score + 50 } : r));
    const v = verifySearchRanking({ results: inflated, trustSignals: TRUST }, QUERY);
    expect(v.verified).toBe(false);
    if (v.verified !== false) throw new Error("unreachable");
    expect(v.divergences).toEqual([
      {
        kind: "score_mismatch",
        position: 1,
        expected: { offerKey: '["test-store","a"]', score: ranked[0]!.score },
        actual: { offerKey: '["test-store","a"]', score: ranked[0]!.score + 50 },
      },
    ]);
  });

  it("flags a service that rewrites the reasons", () => {
    const ranked = rankOffers(offers, QUERY, { trust: TRUST });
    const rewritten = ranked.map((r, i) =>
      i === 0 ? { ...r, reasons: [{ criterion: "price" as const, detail: "totally the best, trust us" }] } : r,
    );
    const v = verifySearchRanking({ results: rewritten, trustSignals: TRUST }, QUERY);
    expect(v.verified).toBe(false);
    if (v.verified !== false) throw new Error("unreachable");
    expect(v.divergences).toEqual([
      expect.objectContaining({ kind: "reasons_mismatch", position: 1 }),
    ]);
  });

  it("rejects service mutations to explicit-criterion order, score, or auditable reasons", () => {
    const criterion = {
      id: "storage",
      label: "128GB storage",
      importance: "preferred",
      kind: "attribute",
      value: "128GB",
    } as const;
    const matching = {
      ...makeOffer({ id: "z-match", priceAmount: 10_000, sponsored: false }),
      product: {
        ...makeOffer({ id: "z-match", priceAmount: 10_000, sponsored: false }).product,
        attributes: { storage: "128GB" },
      },
    };
    const missing = makeOffer({ id: "a-miss", priceAmount: 10_000, sponsored: false });
    const query: SearchQuery = { text: "phone", criteria: [criterion] };
    const ranked = rankOffers([missing, matching], query, { trust: TRUST });
    expect(ranked.map((result) => result.offer.id)).toEqual(["z-match", "a-miss"]);

    const wrongOrder = [ranked[1]!, ranked[0]!];
    expect(verifySearchRanking({ results: wrongOrder, trustSignals: TRUST }, query).verified).toBe(false);

    const wrongScore = ranked.map((result, index) =>
      index === 0 ? { ...result, score: result.score + 1 } : result,
    );
    expect(verifySearchRanking({ results: wrongScore, trustSignals: TRUST }, query).verified).toBe(false);

    const wrongReasons = ranked.map((result, index) =>
      index === 0
        ? {
            ...result,
            reasons: result.reasons.filter((reason) => reason.criterionId !== criterion.id),
          }
        : result,
    );
    expect(verifySearchRanking({ results: wrongReasons, trustSignals: TRUST }, query).verified).toBe(false);
  });

  it("detects a swapped response whose delimiter-bearing store/id tuples share the same legacy colon label", () => {
    const first = makeOffer({ id: "b:c", sourceStore: "a", priceAmount: 10_000, sponsored: false });
    const second = makeOffer({ id: "c", sourceStore: "a:b", priceAmount: 10_000, sponsored: false });
    const ranked = rankOffers([second, first], QUERY, { trust: TRUST });
    const swapped = [ranked[1]!, ranked[0]!];
    const verification = verifySearchRanking({ results: swapped, trustSignals: TRUST }, QUERY);
    expect(verification.verified).toBe(false);
    if (verification.verified !== false) throw new Error("unreachable");
    expect(verification.divergences.map((divergence) => divergence.kind)).toEqual([
      "order_mismatch",
      "order_mismatch",
    ]);
  });

  it("is not_applicable when the service did not return trustSignals (pre-extension service)", () => {
    const v = verifySearchRanking({ results: rankOffers(offers, QUERY) }, QUERY);
    expect(v).toEqual({
      verified: "not_applicable",
      reason:
        "service response did not include trustSignals — the ranking inputs cannot be deterministically recomputed (older service)",
    });
  });

  it("is not_applicable for an empty result set", () => {
    const v = verifySearchRanking({ results: [], trustSignals: {} }, QUERY);
    expect(v).toEqual({ verified: "not_applicable", reason: "no results to verify" });
  });
});
