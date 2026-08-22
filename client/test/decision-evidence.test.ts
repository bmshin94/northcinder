import { describe, expect, it } from "vitest";
import {
  RANK_ELIMINATION_CODES,
  type CandidateDecisionEvidence,
  type InterpretedQuery,
  type RankedResult,
} from "@northcinder/protocol";
import { assessDecisionReadiness, redactEphemeralBuyerContext } from "../src/decision-evidence.js";

const PRODUCT_CHECKLIST = ["product.identity", "product.primary-facts"] as const;
const SELLER_CHECKLIST = ["seller.identity", "seller.policies"] as const;
const PRODUCT_SUBJECT = "FictionalCo TrailCell 90 — 2026 USB-C edition, 90 Wh";
const SELLER_SUBJECT =
  "BrightSound Outlet — https://brightsound.example.test — merchant of record: Example Trading Ltd — buyer geography: US";

function ranked(
  offerId: string,
  amount: number,
  reasons: RankedResult["reasons"] = [{ criterion: "price", detail: `price ${amount} USD` }],
): RankedResult {
  return {
    offer: {
      id: offerId,
      product: {
        id: `product-${offerId}`,
        title: `TrailCell ${offerId}`,
        url: `https://shop.example.test/products/${offerId}`,
        attributes: {},
      },
      price: { amount, currency: "USD" },
      merchant: { id: "shop.example.test", name: "Example Shop", domain: "shop.example.test" },
      availability: "in_stock",
      sourceStore: "shopify",
      sponsored: false,
    },
    score: 100 - amount / 1_000,
    reasons,
  };
}

function completeEvidence(result: RankedResult): CandidateDecisionEvidence {
  const productSubject = `${PRODUCT_SUBJECT} — MPN TC90-${result.offer.id}`;
  return {
    sourceStore: result.offer.sourceStore,
    offerId: result.offer.id,
    productIdentity: {
      canonical: productSubject,
      variant: "2026 USB-C edition, 90 Wh",
      identifiers: [{ scheme: "mpn", value: `TC90-${result.offer.id}` }],
    },
    sellerIdentity: SELLER_SUBJECT,
    landedCost: {
      components: [{ kind: "item_price", amount: result.offer.price }],
      knownTotal: result.offer.price,
      unknownComponents: [],
      completeness: "complete",
    },
    returnPolicy: {
      summary: "Returns accepted within 30 days.",
      sourceUrl: "https://shop.example.test/returns",
      observedAt: "2026-08-20T12:00:00Z",
      windowDays: 30,
    },
    warranty: {
      summary: "Manufacturer warranty lasts 24 months.",
      sourceUrl: "https://shop.example.test/warranty",
      observedAt: "2026-08-20T12:00:00Z",
      durationMonths: 24,
    },
    claims: [
      {
        lane: "product",
        checklistIds: ["product.primary-facts"],
        subjectIdentity: productSubject,
        claim: "The manual specifies a 90 Wh battery.",
        sourceIds: [`manual-${result.offer.id}`],
        sourceRelationship: "primary",
        sourceUse: "subject_evidence",
        sourceUrl: `https://docs.example.test/${result.offer.id}/manual.pdf`,
        sourceType: "manufacturer manual",
        observedAt: "2026-08-20T12:00:00Z",
        confidence: "high",
        conflicts: [],
        unknowns: [],
      },
      {
        lane: "seller",
        checklistIds: ["seller.identity"],
        subjectIdentity: SELLER_SUBJECT,
        sellerIdentity: SELLER_SUBJECT,
        claim: "The business record names Example Trading Ltd as merchant of record.",
        sourceIds: [`registry-${result.offer.id}`],
        sourceRelationship: "primary",
        sourceUse: "subject_evidence",
        sourceUrl: `https://registry.example.test/${result.offer.id}`,
        sourceType: "business registry",
        observedAt: "2026-08-20T12:00:00Z",
        confidence: "high",
        conflicts: [],
        unknowns: [],
      },
    ],
    productReceipt: {
      checklistItemIds: [...PRODUCT_CHECKLIST],
      openChecklistItemIds: [],
      provisional: false,
    },
    sellerReceipt: {
      checklistItemIds: [...SELLER_CHECKLIST],
      openChecklistItemIds: [],
      provisional: false,
    },
  };
}

function assess(results: RankedResult[], evidence: CandidateDecisionEvidence[] = []) {
  return assessDecisionReadiness({
    results,
    evidence,
    productChecklistIds: PRODUCT_CHECKLIST,
    sellerChecklistIds: SELLER_CHECKLIST,
  });
}

describe("assessDecisionReadiness", () => {
  it("reports zero or entirely eliminated candidate sets as insufficient using structured elimination metadata", () => {
    expect(assess([])).toEqual({
      status: "insufficient",
      reasons: ["candidate_set_empty"],
      qualifyingOfferKeys: [],
      offers: [],
    });

    const legacyEliminated = ranked("legacy", 20_000, [
      {
        criterion: "price",
        detail: "wording deliberately unrelated to elimination",
        code: RANK_ELIMINATION_CODES.OVER_BUDGET,
      },
    ]);
    const flagged = ranked("flagged", 10_000, [
      { criterion: "flagged_merchant", detail: "wording deliberately unrelated to risk" },
    ]);
    const result = assess([legacyEliminated, flagged]);
    expect(result.status).toBe("insufficient");
    expect(result.reasons).toEqual(["no_qualifying_candidates"]);
    expect(result.qualifyingOfferKeys).toEqual([]);
    expect(result.offers.map((offer) => offer.status)).toEqual(["eliminated", "eliminated"]);
  });

  it("keeps one otherwise complete candidate provisional because the set is thin", () => {
    const first = ranked("first", 12_900);
    const readiness = assess([first], [completeEvidence(first)]);
    expect(readiness.status).toBe("provisional");
    expect(readiness.reasons).toEqual(["candidate_set_thin"]);
    expect(readiness.offers[0]).toMatchObject({ status: "provisional", gaps: ["candidate_set_thin"] });
  });

  it.each([
    ["missing product identity", (e: CandidateDecisionEvidence) => ({ ...e, productIdentity: undefined }), "missing_product_identity"],
    [
      "partial landed cost",
      (e: CandidateDecisionEvidence) => ({
        ...e,
        landedCost: { ...e.landedCost!, completeness: "partial" as const, unknownComponents: ["tax" as const] },
      }),
      "landed_cost_incomplete",
    ],
    ["missing return policy", (e: CandidateDecisionEvidence) => ({ ...e, returnPolicy: undefined }), "missing_return_policy"],
    ["missing warranty", (e: CandidateDecisionEvidence) => ({ ...e, warranty: undefined }), "missing_warranty"],
    [
      "open product checklist",
      (e: CandidateDecisionEvidence) => ({
        ...e,
        productReceipt: {
          checklistItemIds: [...PRODUCT_CHECKLIST],
          openChecklistItemIds: ["product.primary-facts"],
          provisional: true,
        },
      }),
      "product_checklist_open",
    ],
    [
      "provisional seller receipt",
      (e: CandidateDecisionEvidence) => ({
        ...e,
        sellerReceipt: { ...e.sellerReceipt!, provisional: true },
      }),
      "seller_research_provisional",
    ],
    [
      "claim conflict",
      (e: CandidateDecisionEvidence) => ({
        ...e,
        claims: [{ ...e.claims[0]!, conflicts: ["The exact-variant measurements disagree."] }, e.claims[1]!],
      }),
      "evidence_conflict",
    ],
    [
      "claim unknown",
      (e: CandidateDecisionEvidence) => ({
        ...e,
        claims: [{ ...e.claims[0]!, unknowns: ["Long-term capacity is unknown."] }, e.claims[1]!],
      }),
      "evidence_unknown",
    ],
  ])("reports a stable gap for %s and prevents ready", (_name, mutate, expectedGap) => {
    const first = ranked("first", 12_900);
    const second = ranked("second", 13_500);
    const readiness = assess([first, second], [mutate(completeEvidence(first))]);
    expect(readiness.status).toBe("provisional");
    expect(readiness.offers[0]!.gaps).toContain(expectedGap);
  });

  it("does not let commercial or context-only claims clear either research lane", () => {
    const first = ranked("first", 12_900);
    const second = ranked("second", 13_500);
    const evidence = completeEvidence(first);
    evidence.claims = [
      { ...evidence.claims[0]!, sourceRelationship: "commercial", sourceUse: "commercial_claim" },
      { ...evidence.claims[1]!, sourceUse: "context_only" },
    ];
    const readiness = assess([first, second], [evidence]);
    expect(readiness.offers[0]!.gaps).toEqual(expect.arrayContaining(["missing_product_claim", "missing_seller_claim"]));
    expect(readiness.status).toBe("provisional");
  });

  it("keeps a correct candidate identity provisional when only its product claim subject names another product", () => {
    const first = ranked("first", 12_900);
    const second = ranked("second", 13_500);
    const evidence = completeEvidence(first);
    evidence.claims[0] = {
      ...evidence.claims[0]!,
      subjectIdentity: "FictionalCo TrailCell 60 — different model and variant",
    };
    const readiness = assess([first, second], [evidence]);
    expect(readiness.status).toBe("provisional");
    expect(readiness.offers[0]!.gaps).toContain("product_identity_mismatch");
  });

  it("is ready with two qualifying candidates and a fully evidenced top qualifying candidate without changing rank", () => {
    const first = ranked("first", 12_900);
    const second = ranked("second", 13_500);
    const before = structuredClone([first, second]);
    const readiness = assess([first, second], [completeEvidence(first)]);
    expect(readiness.status).toBe("ready");
    expect(readiness.reasons).toEqual([]);
    expect(readiness.qualifyingOfferKeys).toEqual(['["shopify","first"]', '["shopify","second"]']);
    expect(readiness.offers[0]).toMatchObject({
      offerKey: '["shopify","first"]',
      status: "ready",
      gaps: [],
    });
    expect([first, second]).toEqual(before);
  });

  it("counts duplicate exact-offer rows once so one candidate cannot satisfy the two-candidate gate", () => {
    const first = ranked("first", 12_900);
    const readiness = assess([first, structuredClone(first)], [completeEvidence(first)]);
    expect(readiness.status).toBe("provisional");
    expect(readiness.reasons).toEqual(["candidate_set_thin"]);
    expect(readiness.qualifyingOfferKeys).toEqual(['["shopify","first"]']);
    expect(readiness.offers).toHaveLength(1);
  });

  it("returns readiness for more than twenty ranked results", () => {
    const results = Array.from({ length: 25 }, (_, index) => ranked(`offer-${index}`, 12_900 + index));
    const readiness = assess(results, [completeEvidence(results[0]!)]);
    expect(readiness.status).toBe("ready");
    expect(readiness.qualifyingOfferKeys).toHaveLength(25);
    expect(readiness.offers).toHaveLength(25);
  });

  it("caps aggregate conflict and unknown display at sixteen while preserving exact totals and gap truth", () => {
    const first = ranked("first", 12_900);
    const second = ranked("second", 13_500);
    const evidence = completeEvidence(first);
    evidence.claims[0] = {
      ...evidence.claims[0]!,
      conflicts: Array.from({ length: 9 }, (_, index) => `product conflict ${index}`),
      unknowns: Array.from({ length: 9 }, (_, index) => `product unknown ${index}`),
    };
    evidence.claims[1] = {
      ...evidence.claims[1]!,
      conflicts: Array.from({ length: 8 }, (_, index) => `seller conflict ${index}`),
      unknowns: Array.from({ length: 8 }, (_, index) => `seller unknown ${index}`),
    };
    const readiness = assess([first, second], [evidence]);
    expect(readiness.status).toBe("provisional");
    expect(readiness.offers[0]).toMatchObject({
      gaps: expect.arrayContaining(["evidence_conflict", "evidence_unknown"]),
      totalConflictCount: 17,
      conflictsTruncated: true,
      totalUnknownCount: 17,
      unknownsTruncated: true,
    });
    expect(readiness.offers[0]!.conflicts).toHaveLength(16);
    expect(readiness.offers[0]!.unknowns).toHaveLength(16);
  });

  it("keeps adversarial delimiter-bearing offer tuples distinct in evidence lookup and readiness output", () => {
    const first = ranked("b:c", 12_900);
    first.offer.sourceStore = "a";
    const second = ranked("c", 13_500);
    second.offer.sourceStore = "a:b";
    const readiness = assess(
      [first, second],
      [completeEvidence(first), completeEvidence(second)],
    );
    expect(readiness.status).toBe("ready");
    expect(readiness.qualifyingOfferKeys).toEqual(['["a","b:c"]', '["a:b","c"]']);
    expect(readiness.offers.map((offer) => offer.offerKey)).toEqual(['["a","b:c"]', '["a:b","c"]']);
    expect(new Set(readiness.offers.map((offer) => offer.offerKey)).size).toBe(2);
  });
});

describe("redactEphemeralBuyerContext", () => {
  it("removes buyer context from an audit copy while preserving every ranked criterion and the input object", () => {
    const interpreted: InterpretedQuery = {
      criteria: {
        text: "trail battery",
        maxPrice: { amount: 15_000, currency: "USD" },
        buyerContext: {
          subject: "birthday gift for my child",
          intendedUse: "private medical travel",
          location: "home address",
        },
        criteria: [
          { id: "capacity", label: "At least 90 Wh", importance: "required", kind: "attribute", value: "90 Wh" },
        ],
      },
      appliedProfileEntries: [],
      overriddenProfileEntries: [],
      unmatchedQueryWords: ["trail"],
    };
    const redacted = redactEphemeralBuyerContext(interpreted);
    expect(redacted.criteria).toEqual({
      text: "trail battery",
      maxPrice: { amount: 15_000, currency: "USD" },
      criteria: [
        { id: "capacity", label: "At least 90 Wh", importance: "required", kind: "attribute", value: "90 Wh" },
      ],
    });
    expect(interpreted.criteria.buyerContext).toBeDefined();
    expect(redacted.appliedProfileEntries).toEqual(interpreted.appliedProfileEntries);
    expect(redacted.unmatchedQueryWords).toEqual(["trail"]);
  });
});
