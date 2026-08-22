import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BuyersBrief, DecisionReadiness, InterpretedQuery } from "@northcinder/protocol";
import { projectDecisionState, readDecisionStates, withDecisionOutcome } from "../src/decision-state.js";

const brief = {
  searchId: "search_decision",
  query: {
    text: "quiet café headphones",
    buyerContext: { subject: "private buyer detail" },
    criteria: [{ id: "price", label: "Under budget", importance: "required", kind: "max_price", value: { amount: 20_000, currency: "USD" } }],
  },
  finalists: [
    {
      rank: 1,
      offerId: "offer-1",
      sourceStore: "shopify",
      title: "Café Headphones",
      url: "https://shop.example.test/offer-1",
      merchant: { id: "shop.example.test", name: "Café Shop" },
      price: { amount: 12_900, currency: "USD" },
      availability: "in_stock",
      sponsored: false,
      imageUrl: "https://shop.example.test/images/offer-1.png",
      productIdentity: {
        canonical: "Café Headphones — midnight — over-ear",
        variant: "midnight — over-ear",
        identifiers: [],
      },
      sellerState: "unknown",
      freshness: { status: "unknown" },
      verificationState: "merchant_verified",
      decisionStatus: "provisional",
      importantUnknowns: ["missing return policy"],
      decisiveDownside: "Return policy still needs research.",
      rawReasons: [{ criterion: "price", detail: "raw ranking reason must not persist" }],
      whyThis: ["Lower price for the stated budget."],
      tradeoffs: [],
      provenance: { price: { source: "https://shop.example.test/offer-1" } },
    },
    {
      rank: 2,
      offerId: "offer-2",
      sourceStore: "ebay",
      title: "Other Headphones",
      url: "https://ebay.example.test/offer-2",
      merchant: { id: "ebay.example.test", name: "Other Shop" },
      price: { amount: 13_500, currency: "USD" },
      availability: "in_stock",
      sponsored: false,
      sellerState: "unknown",
      freshness: { status: "unknown" },
      verificationState: "merchant_verified",
      decisionStatus: "provisional",
      importantUnknowns: [],
      decisiveDownside: "Costs more.",
      rawReasons: [{ criterion: "price", detail: "another raw reason" }],
      whyThis: ["Alternative."],
      tradeoffs: [],
      provenance: { price: { source: "https://ebay.example.test/offer-2" } },
    },
  ],
  rejected: [{ offerId: "rejected", sourceStore: "shopify", title: "Rejected", eliminatedBy: ["required price exceeded"] }],
  coverage: [{ store: "shopify", status: "searched", offerCount: 1 }, { store: "ebay", status: "searched", offerCount: 1 }],
  offersConsidered: 3,
  decisionSummary: [
    { role: "top_fit", sourceStore: "shopify", offerId: "offer-1", roleReason: "First qualifying finalist." },
    { role: "budget_or_different", sourceStore: "ebay", offerId: "offer-2", roleReason: "Comparison alternative." },
  ],
  unresolvedResearchQuestions: ["For Café Headphones: resolve missing_return_policy."],
} as BuyersBrief;

const readiness = {
  status: "provisional",
  reasons: ["missing_return_policy"],
  qualifyingOfferKeys: ['["shopify","offer-1"]', '["ebay","offer-2"]'],
  offers: [],
} as DecisionReadiness;

function auditLine(state: unknown): string {
  return JSON.stringify({ at: "2026-08-20T12:00:00.000Z", type: "search", decisionState: state });
}

describe("bounded persisted decision state", () => {
  it("persists only bounded profile effects from the matching interpretation and updates only the outcome", () => {
    const interpreted: InterpretedQuery = {
      criteria: {
        text: "quiet café headphones",
        buyerContext: { subject: "private buyer detail" },
      },
      appliedProfileEntries: [{ id: "pref_budget", origin: "stated", kind: "budget", appliedTo: "maxPrice", detail: "120.00 USD" }],
      overriddenProfileEntries: [{ id: "pref_delivery", origin: "inferred", kind: "delivery", appliedTo: "deliveryBy", detail: "within 3 days", overriddenBy: "per-query deliveryBy" }],
      unmatchedQueryWords: [],
    };
    const state = projectDecisionState({ brief, decisionReadiness: readiness, interpreted });

    expect(state.profileEffects).toEqual({
      applied: [{ id: "pref_budget", origin: "stated", kind: "budget", appliedTo: "maxPrice", detail: "120.00 USD" }],
      overridden: [{ id: "pref_delivery", origin: "inferred", kind: "delivery", appliedTo: "deliveryBy", detail: "within 3 days", overriddenBy: "per-query deliveryBy" }],
    });
    expect(JSON.stringify(state)).not.toContain("private buyer detail");
    expect(withDecisionOutcome(state, { orderId: "order_1", state: "kept", recordedAt: "2026-08-21T12:00:00.000Z" })).toEqual({
      ...state,
      outcome: "kept",
    });
  });

  it("warns when an oversized profile effect is truncated before projection warnings are captured", () => {
    const state = projectDecisionState({
      brief,
      decisionReadiness: readiness,
      interpreted: {
        criteria: { text: "quiet café headphones" },
        appliedProfileEntries: [{ id: "pref_long", origin: "stated", kind: "ethics", appliedTo: "ethicsFlags", detail: "x".repeat(2_001) }],
        overriddenProfileEntries: [],
        unmatchedQueryWords: [],
      },
    });
    expect(state.profileEffects.applied[0]!.detail).toHaveLength(2_000);
    expect(state.projectionWarnings).toContain("Profile effect details were shortened for the local Decisions display.");
  });

  it("projects only bounded decision display facts and redacts buyer context", () => {
    const state = projectDecisionState({ brief, decisionReadiness: readiness });
    expect(state).toMatchObject({
      searchId: "search_decision",
      request: "quiet café headphones",
      criteria: { text: "quiet café headphones" },
      chosenOffer: null,
      outcome: null,
      coverage: [
        { store: "shopify", status: "searched", offerCount: 1 },
        { store: "ebay", status: "searched", offerCount: 1 },
      ],
      unresolvedResearchQuestions: ["For Café Headphones: resolve missing_return_policy."],
      readiness: { status: "provisional", reasons: ["missing_return_policy"] },
      candidates: [
        {
          role: "top_fit",
          sourceStore: "shopify",
          offerId: "offer-1",
          title: "Café Headphones",
          rank: 1,
          imageUrl: "https://shop.example.test/images/offer-1.png",
          productIdentity: { variant: "midnight — over-ear" },
        },
        { role: "budget_or_different", sourceStore: "ebay", offerId: "offer-2", title: "Other Headphones", rank: 2 },
      ],
      projectionWarnings: [],
    });
    const serialized = JSON.stringify(state);
    for (const forbidden of ["private buyer detail", "raw ranking reason", "another raw reason", "rejected", "provenance", "rawReasons", "buyerContext"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("reads newest valid snapshots, suppresses stale records behind an invalid newest snapshot, and preserves utf8 across tiny chunks", () => {
    const directory = mkdtempSync(join(tmpdir(), "northcinder-decision-state-"));
    const path = join(directory, "audit.jsonl");
    const old = projectDecisionState({ brief, decisionReadiness: readiness });
    const latest = projectDecisionState({ brief: { ...brief, searchId: "search_latest" }, decisionReadiness: readiness, chosenOffer: { sourceStore: "shopify", offerId: "offer-1" } });
    appendFileSync(path, `${auditLine(old)}\nnot json\n${auditLine(latest)}\n${JSON.stringify({ type: "search", searchId: "search_decision", decisionState: { searchId: "search_decision", broken: true } })}\n`);

    expect(readDecisionStates(path, { chunkSize: 3, limit: 99 })).toEqual({
      states: [latest],
      invalidRecords: 1,
    });
  });

  it("returns empty state for an absent audit file and caps the output at fifty", () => {
    const directory = mkdtempSync(join(tmpdir(), "northcinder-decision-state-"));
    const path = join(directory, "audit.jsonl");
    expect(readDecisionStates(path)).toEqual({ states: [], invalidRecords: 0 });
    for (let index = 0; index < 51; index += 1) {
      appendFileSync(path, `${auditLine(projectDecisionState({ brief: { ...brief, searchId: `search_${index}` }, decisionReadiness: readiness }))}\n`);
    }
    expect(readDecisionStates(path, { limit: 100 }).states).toHaveLength(50);
    expect(readDecisionStates(path, { limit: Number.NaN }).states).toHaveLength(20);
    expect(readDecisionStates(path, { limit: 1.5 }).states).toHaveLength(1);
  });

  it("resolves NUL-bearing exact offer tuples without delimiter collisions", () => {
    const collisionBrief = {
      ...brief,
      finalists: [
        { ...brief.finalists[0]!, sourceStore: "a\u0000b", offerId: "c", title: "First exact tuple" },
        { ...brief.finalists[1]!, sourceStore: "a", offerId: "b\u0000c", title: "Second exact tuple" },
      ],
      decisionSummary: [{ role: "top_fit" as const, sourceStore: "a\u0000b", offerId: "c", roleReason: "First exact tuple." }],
    } as BuyersBrief;
    expect(projectDecisionState({ brief: collisionBrief, decisionReadiness: readiness }).candidates).toMatchObject([
      { sourceStore: "a\u0000b", offerId: "c", title: "First exact tuple" },
    ]);
  });

  it("lossily bounds protocol-valid display text with a visible projection warning", () => {
    const state = projectDecisionState({ brief, decisionReadiness: readiness });
    const projected = projectDecisionState({
      brief: { ...brief, query: { ...brief.query, text: "x".repeat(2_001) } },
      decisionReadiness: readiness,
    });
    expect(projected.request).toHaveLength(2_000);
    expect(projected.request.endsWith("…")).toBe(true);
    expect(projected.projectionWarnings).toContain("Request text was shortened for the local Decisions display.");

    const directory = mkdtempSync(join(tmpdir(), "northcinder-decision-state-"));
    const path = join(directory, "audit.jsonl");
    appendFileSync(path, `${auditLine({
      ...state,
      request: "x".repeat(2_001),
      criteria: { ...state.criteria, mustHaveAttributes: Array.from({ length: 33 }, () => "bounded") },
      coverage: Array.from({ length: 101 }, () => ({ store: "shop", status: "searched", offerCount: 1 })),
    })}\n`);
    expect(readDecisionStates(path)).toEqual({ states: [], invalidRecords: 1 });
  });

  it("preserves protocol-sized exact offer references while bounding or omitting oversized display fields", () => {
    const sourceStore = "s".repeat(500);
    const offerId = "o".repeat(500);
    const finalist = {
      ...brief.finalists[0]!,
      sourceStore,
      offerId,
      title: "t".repeat(2_001),
      url: `https://shop.example.test/${"u".repeat(2_000)}`,
      imageUrl: `https://shop.example.test/${"i".repeat(2_000)}`,
      merchant: { id: "m".repeat(501), name: "n".repeat(201) },
      tradeoffs: [{ dimension: "price" as const, detail: "d".repeat(2_001) }],
    };
    const candidateBrief = {
      ...brief,
      finalists: [finalist, brief.finalists[1]!],
      decisionSummary: [{
        ...brief.decisionSummary[0]!,
        sourceStore: finalist.sourceStore,
        offerId: finalist.offerId,
      }],
    } as BuyersBrief;
    const state = projectDecisionState({ brief: candidateBrief, decisionReadiness: readiness });
    expect(state.candidates[0]).toMatchObject({ sourceStore, offerId });
    expect(state.candidates[0]!.title).toHaveLength(2_000);
    expect(state.candidates[0]!.merchant.id).toHaveLength(500);
    expect(state.candidates[0]!.merchant.name).toHaveLength(200);
    expect(state.candidates[0]!.tradeoffs[0]!.detail).toHaveLength(2_000);
    expect(state.candidates[0]!.url).toBeUndefined();
    expect(state.candidates[0]!.imageUrl).toBeUndefined();
    expect(state.projectionWarnings).toEqual(expect.arrayContaining([
      "Candidate titles were shortened for the local Decisions display.",
      "Candidate product links were omitted because they exceeded the local Decisions display bound.",
      "Candidate image links were omitted because they exceeded the local Decisions display bound.",
      "Merchant identifiers were shortened for the local Decisions display.",
      "Merchant names were shortened for the local Decisions display.",
      "Candidate tradeoff details were shortened for the local Decisions display.",
    ]));
  });

  it("keeps unsafe or absent images non-actionable while retaining exact identity", () => {
    const candidateBrief = {
      ...brief,
      finalists: [{ ...brief.finalists[0]!, imageUrl: "javascript:alert(1)" }, brief.finalists[1]!],
    } as BuyersBrief;
    const state = projectDecisionState({ brief: candidateBrief, decisionReadiness: readiness });
    expect(state.candidates[0]!.productIdentity).toEqual(brief.finalists[0]!.productIdentity);
    expect(state.candidates[0]!.imageUrl).toBe("javascript:alert(1)");
    expect(state.candidates[1]!.productIdentity).toBeUndefined();
    expect(state.candidates[1]!.imageUrl).toBeUndefined();
  });

  it("round-trips a bounded candidate tradeoff dimension and detail", () => {
    const candidateBrief = {
      ...brief,
      finalists: [{
        ...brief.finalists[0]!,
        tradeoffs: [{ dimension: "price", detail: "12.00 USD less than the next finalist." }],
      }, brief.finalists[1]!],
    } as BuyersBrief;
    expect(projectDecisionState({ brief: candidateBrief, decisionReadiness: readiness }).candidates[0]!.tradeoffs).toEqual([
      { dimension: "price", detail: "12.00 USD less than the next finalist." },
    ]);
  });

  it("discloses when extra candidate tradeoffs are omitted from the bounded display state", () => {
    const candidateBrief = {
      ...brief,
      finalists: [{
        ...brief.finalists[0]!,
        tradeoffs: Array.from({ length: 21 }, (_, index) => ({
          dimension: "price" as const,
          detail: `Tradeoff ${index + 1}`,
        })),
      }, brief.finalists[1]!],
    } as BuyersBrief;
    const state = projectDecisionState({ brief: candidateBrief, decisionReadiness: readiness });
    expect(state.candidates[0]!.tradeoffs).toHaveLength(20);
    expect(state.projectionWarnings).toContain("Some candidate decision details were omitted from the local Decisions display.");
  });
});
