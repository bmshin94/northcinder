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
  imageUrl: "https://mock-merchant.example/item-1.jpg",
  productIdentity: {
    canonical: "Mock Merchant Wool Blend Sneaker blue US 9",
    variant: "blue US 9",
    identifiers: [],
  },
  landedCost: {
    components: [{ kind: "item_price" as const, amount: { amount: 9800, currency: "USD" } }],
    knownTotal: { amount: 9800, currency: "USD" },
    unknownComponents: [],
    completeness: "complete" as const,
  },
  sellerState: "trusted" as const,
  freshness: { status: "known" as const, observedAt: "2026-07-04T12:00:00.000Z" },
  verificationState: "merchant_verified" as const,
  decisionStatus: "ready" as const,
  importantUnknowns: [],
  decisiveDownside: "No decisive downside established from current evidence.",
  rawReasons: [{ criterion: "price" as const, detail: "lowest price: 9800 USD" }],
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
    decisionSummary: finalistCount === 0 ? [] : [{ role: "top_fit" as const, sourceStore: "ebay", offerId: "item-1", roleReason: "First qualifying finalist in the neutrality ranking." }],
    unresolvedResearchQuestions: [],
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

  it("enforces a resolved, unique, at-most-three role summary without allowing role or offer padding", () => {
    const brief = validBrief(3);
    brief.decisionSummary = [
      { role: "top_fit", sourceStore: "ebay", offerId: "item-1", roleReason: "First qualifying finalist in the neutrality ranking." },
      { role: "lower_risk", sourceStore: "ebay", offerId: "item-2", roleReason: "Has a lower evidence-risk tuple." },
      { role: "budget_or_different", sourceStore: "ebay", offerId: "item-3", roleReason: "Cheaper same-currency remaining finalist." },
    ];
    expect(BuyersBriefSchema.safeParse(brief).success).toBe(true);
    expect(BuyersBriefSchema.safeParse({ ...brief, decisionSummary: [...brief.decisionSummary, brief.decisionSummary[0]] }).success).toBe(false);
    expect(BuyersBriefSchema.safeParse({ ...brief, decisionSummary: [{ ...brief.decisionSummary[0], role: "lower_risk" }, { ...brief.decisionSummary[0], roleReason: "duplicate offer" }] }).success).toBe(false);
    expect(BuyersBriefSchema.safeParse({ ...brief, decisionSummary: [{ ...brief.decisionSummary[0], offerId: "missing" }] }).success).toBe(false);
  });

  it("requires top_fit first and permits each later role only in its fixed progressive sequence", () => {
    const brief = validBrief(3);
    brief.decisionSummary = [
      { role: "top_fit", sourceStore: "ebay", offerId: "item-1", roleReason: "First qualifying finalist in the neutrality ranking." },
      { role: "lower_risk", sourceStore: "ebay", offerId: "item-2", roleReason: "Has a lower evidence-risk tuple." },
      { role: "budget_or_different", sourceStore: "ebay", offerId: "item-3", roleReason: "Cheaper same-currency remaining finalist." },
    ];
    expect(BuyersBriefSchema.safeParse(brief).success).toBe(true);
    expect(BuyersBriefSchema.safeParse({ ...brief, decisionSummary: [brief.decisionSummary[1]!] }).success).toBe(false);
    expect(BuyersBriefSchema.safeParse({ ...brief, decisionSummary: [brief.decisionSummary[0]!, brief.decisionSummary[2]!, brief.decisionSummary[1]!] }).success).toBe(false);
  });

  it("keeps decision display fields strict and bounds unique unanswered questions", () => {
    const brief = validBrief(1);
    expect(BuyersBriefSchema.safeParse(brief).success).toBe(true);
    expect(BuyersBriefSchema.safeParse({ ...brief, finalists: [{ ...brief.finalists[0], verificationState: "guessed" }] }).success).toBe(false);
    expect(BuyersBriefSchema.safeParse({ ...brief, finalists: [{ ...brief.finalists[0], freshness: { status: "known" } }] }).success).toBe(false);
    expect(BuyersBriefSchema.safeParse({ ...brief, finalists: [{ ...brief.finalists[0], importantUnknowns: Array(13).fill("unknown") }] }).success).toBe(false);
    expect(BuyersBriefSchema.safeParse({ ...brief, unresolvedResearchQuestions: ["question", "question"] }).success).toBe(false);
    expect(BuyersBriefSchema.safeParse({ ...brief, unresolvedResearchQuestions: Array.from({ length: 13 }, (_, i) => `question ${i}`) }).success).toBe(false);
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
