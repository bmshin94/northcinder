import { describe, expect, it } from "vitest";
import { OfferSchema } from "../src/schemas/core.js";
import { BuyersBriefSchema, CoverageEntrySchema } from "../src/schemas/brief.js";

const FINALIST = {
  rank: 1,
  offerId: "item-1",
  sourceStore: "ebay",
  title: "Wool Blend Sneaker",
  url: "https://mock-merchant.example/item-1",
  merchant: { id: "mock-merchant.example", name: "Mock Merchant" },
  price: { amount: 9800, currency: "USD" },
  availability: "in_stock" as const,
  sponsored: false,
  whyThis: ["price: lowest price: 9800 USD"],
  tradeoffs: [{ dimension: "price" as const, detail: "cheapest finalist at 98.00 USD" }],
  provenance: {
    price: { source: "https://mock-merchant.example/item-1", fetchedAt: "2026-07-04T12:00:00.000Z" },
  },
};

function validBrief(finalistCount: number) {
  return {
    searchId: "search_1",
    query: { text: "sneakers" },
    finalists: Array.from({ length: finalistCount }, (_, i) => ({
      ...FINALIST,
      rank: i + 1,
      offerId: `item-${i + 1}`,
    })),
    rejected: [
      {
        offerId: "item-9",
        sourceStore: "ebay",
        title: "Overpriced Sneaker",
        eliminatedBy: ["over budget: price 99999 USD exceeds budget 12000 USD"],
      },
    ],
    coverage: [
      { store: "ebay", status: "searched" as const, offerCount: 6 },
      { store: "amazon", status: "blocked" as const, offerCount: 0, detail: "bot check triggered" },
    ],
    offersConsidered: finalistCount + 1,
  };
}

describe("BuyersBrief schema", () => {
  it("accepts a valid brief with finalists, rejected appendix, and coverage", () => {
    const brief = BuyersBriefSchema.parse(validBrief(3));
    expect(brief.finalists).toHaveLength(3);
    expect(brief.coverage[1]).toEqual({
      store: "amazon",
      status: "blocked",
      offerCount: 0,
      detail: "bot check triggered",
    });
  });

  it("REJECTS more than 5 finalists — the ≤5 cap is schema-enforced, never padded past", () => {
    expect(BuyersBriefSchema.safeParse(validBrief(6)).success).toBe(false);
    expect(BuyersBriefSchema.safeParse(validBrief(5)).success).toBe(true);
  });

  it("allows ZERO finalists (fewer qualify → fewer shown; padding is forbidden, emptiness is honest)", () => {
    expect(BuyersBriefSchema.safeParse(validBrief(0)).success).toBe(true);
  });

  it("a rejected offer must name at least one eliminating criterion", () => {
    const brief = validBrief(1);
    brief.rejected[0]!.eliminatedBy = [];
    expect(BuyersBriefSchema.safeParse(brief).success).toBe(false);
  });

  it("coverage status vocabulary is exactly searched|blocked|not_configured|error", () => {
    for (const status of ["searched", "blocked", "not_configured", "error"]) {
      expect(CoverageEntrySchema.safeParse({ store: "s", status, offerCount: 0 }).success).toBe(true);
    }
    expect(CoverageEntrySchema.safeParse({ store: "s", status: "skipped", offerCount: 0 }).success).toBe(false);
  });

  it("a finalist's whyThis is non-empty by construction — a recommendation always says why", () => {
    const brief = validBrief(1);
    (brief.finalists[0] as { whyThis: string[] }).whyThis = [];
    expect(BuyersBriefSchema.safeParse(brief).success).toBe(false);
  });
});

describe("Offer.fetchedAt (provenance stamp)", () => {
  const offer = {
    id: "item-1",
    product: { id: "item-1", title: "Sneaker", url: "https://s.example/1", attributes: {} },
    price: { amount: 9800, currency: "USD" },
    merchant: { id: "s.example", name: "S", domain: "s.example" },
    availability: "in_stock",
    sourceStore: "ebay",
    sponsored: false,
  };

  it("is optional (backward compatible) and accepts an ISO datetime", () => {
    expect(OfferSchema.safeParse(offer).success).toBe(true);
    const stamped = OfferSchema.parse({ ...offer, fetchedAt: "2026-07-04T12:00:00.000Z" });
    expect(stamped.fetchedAt).toBe("2026-07-04T12:00:00.000Z");
  });

  it("rejects a non-datetime stamp", () => {
    expect(OfferSchema.safeParse({ ...offer, fetchedAt: "yesterday" }).success).toBe(false);
  });
});
