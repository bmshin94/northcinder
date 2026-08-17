import { describe, expect, it } from "vitest";
import {
  rankOffers,
  type InterpretedQuery,
  type Offer,
  type SearchQuery,
  type StoreStatus,
  type TrustSignal,
} from "@northcinder/protocol";
import { composeBuyersBrief, computeTradeoffs, whyThisLines } from "../src/compose.js";

const FETCHED_AT = "2026-07-04T09:00:00.000Z";

function offer(
  id: string,
  amount: number,
  opts: {
    title?: string;
    merchantId?: string;
    availability?: Offer["availability"];
    deliveryBy?: string;
    sponsored?: boolean;
    store?: string;
    fetchedAt?: string | null;
  } = {},
): Offer {
  const store = opts.store ?? "ebay";
  const merchantId = opts.merchantId ?? `${id}-shop.example`;
  return {
    id,
    product: {
      id: `p-${id}`,
      title: opts.title ?? `Wool Runner ${id}`,
      url: `https://${store}.example/p/${id}`,
      attributes: {},
    },
    price: { amount, currency: "USD" },
    merchant: { id: merchantId, name: `Shop ${id}`, domain: merchantId },
    availability: opts.availability ?? "in_stock",
    ...(opts.deliveryBy !== undefined ? { shipping: { deliveryBy: opts.deliveryBy } } : {}),
    sourceStore: store,
    sponsored: opts.sponsored ?? false,
    ...(opts.fetchedAt === null ? {} : { fetchedAt: opts.fetchedAt ?? FETCHED_AT }),
  };
}

function trust(merchantId: string, level: TrustSignal["level"]): TrustSignal {
  return { merchantId, level, evidence: [{ source: "seed-list", detail: `seed list says ${level}` }] };
}

const CRITERIA: SearchQuery = {
  text: "wool sneakers",
  maxPrice: { amount: 12000, currency: "USD" },
  mustHaveAttributes: ["wool"],
  deliveryBy: "2026-07-10",
};

const INTERPRETED: InterpretedQuery = {
  criteria: CRITERIA,
  appliedProfileEntries: [],
  overriddenProfileEntries: [],
  unmatchedQueryWords: [],
};

/** 10-offer fixture: 6 qualified organic, 1 over budget, 1 missing must-have, 1 out of stock, 1 sponsored. */
const TEN_OFFERS: Offer[] = [
  offer("o1", 9800, { deliveryBy: "2026-07-08", merchantId: "trusted.example" }),
  offer("o2", 10500, { deliveryBy: "2026-07-06", merchantId: "known.example" }),
  offer("o3", 9900, {}),
  offer("o4", 11000, { deliveryBy: "2026-07-09" }),
  offer("o5", 11500, { merchantId: "nosignal.example" }),
  offer("o6", 10000, { deliveryBy: "2026-07-09" }),
  offer("o7", 15000, {}), // over budget (12000 cap)
  offer("o8", 9850, { title: "Canvas Runner o8" }), // missing must-have "wool"
  offer("o9", 9950, { availability: "out_of_stock" }),
  offer("o10", 9990, { sponsored: true }),
];

const TRUST: Record<string, TrustSignal> = Object.fromEntries(
  TEN_OFFERS.filter((o) => o.merchant.id !== "nosignal.example").map((o) => [
    o.merchant.id,
    trust(o.merchant.id, o.merchant.id === "trusted.example" ? "trusted" : o.merchant.id === "known.example" ? "known" : "unknown"),
  ]),
);

const STATUSES: StoreStatus[] = [
  { store: "ebay", ok: true, offerCount: 10, durationMs: 42 },
  {
    store: "amazon",
    ok: false,
    durationMs: 7,
    error: { store: "amazon", code: "blocked", message: "bot check triggered", retryable: false },
  },
  {
    store: "etsy",
    ok: false,
    durationMs: 1,
    error: { store: "etsy", code: "not_configured", message: "ETSY_API_KEY not set", retryable: false },
  },
  {
    store: "shopify",
    ok: false,
    durationMs: 2001,
    error: { store: "shopify", code: "timeout", message: "search timed out after 2000ms", retryable: true },
  },
];

function tenOfferBrief() {
  const results = rankOffers(TEN_OFFERS, CRITERIA, { trust: TRUST });
  return composeBuyersBrief({
    searchId: "search_fixture",
    results,
    interpretedQuery: INTERPRETED,
    storeStatuses: STATUSES,
    trustSignals: TRUST,
  });
}

describe("composeBuyersBrief — 10-offer fixture through the real neutrality ranking", () => {
  it("yields exactly 5 finalists in ranking order — never padded, never re-ranked", () => {
    const brief = tenOfferBrief();
    expect(brief.finalists.map((f) => f.offerId)).toEqual(["o1", "o2", "o6", "o4", "o3"]);
    expect(brief.finalists.map((f) => f.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(brief.offersConsidered).toBe(10);
  });

  it("never pads: 3 qualifying offers yield 3 finalists", () => {
    const three = [TEN_OFFERS[0]!, TEN_OFFERS[1]!, TEN_OFFERS[2]!];
    const results = rankOffers(three, CRITERIA, { trust: TRUST });
    const brief = composeBuyersBrief({
      searchId: "search_small",
      results,
      interpretedQuery: INTERPRETED,
      storeStatuses: STATUSES,
      trustSignals: TRUST,
    });
    expect(brief.finalists).toHaveLength(3);
    expect(brief.rejected).toHaveLength(0);
  });

  it("whyThis carries EXACT strings derived from reasons[], phrased against the user's criteria", () => {
    const brief = tenOfferBrief();
    const top = brief.finalists[0]!;
    expect(top.whyThis).toEqual([
      "price: lowest price: 9800 USD, 50 USD cheaper than the next offer",
      "your must-haves (wool): matches 1/1 required attributes: wool",
      "your delivery deadline (2026-07-10): promised delivery 2026-07-08 meets requested 2026-07-10",
      "availability: in stock",
      'merchant trust: merchant "trusted.example" trust level: trusted (seed list says trusted)',
    ]);
  });

  it("tradeoffs are computed deltas vs the OTHER finalists (price / delivery / trust)", () => {
    const brief = tenOfferBrief();
    const top = brief.finalists[0]!; // o1: cheapest finalist, trusted, delivers 07-08 (o2 is earlier: 07-06)
    expect(top.tradeoffs).toEqual([
      { dimension: "price", detail: "cheapest finalist at 98.00 USD" },
      { dimension: "delivery", detail: "promised delivery 2026-07-08, 2 day(s) after the earliest finalist (2026-07-06)" },
      { dimension: "trust", detail: "highest merchant trust among finalists (trusted)" },
    ]);
    const o3 = brief.finalists.find((f) => f.offerId === "o3")!; // no promised delivery date
    expect(o3.tradeoffs).toContainEqual({
      dimension: "delivery",
      detail: "no promised delivery date — 4 other finalist(s) promise one",
    });
    expect(o3.tradeoffs).toContainEqual({
      dimension: "price",
      detail: "1.00 USD more than the cheapest finalist (98.00 USD)",
    });
  });

  it("provenance cells carry the offer's source URL + fetchedAt", () => {
    const brief = tenOfferBrief();
    const top = brief.finalists[0]!;
    expect(top.provenance.price).toEqual({ source: "https://ebay.example/p/o1", fetchedAt: FETCHED_AT });
    expect(top.provenance.title).toEqual({ source: "https://ebay.example/p/o1", fetchedAt: FETCHED_AT });
    expect(top.provenance.delivery).toEqual({ source: "https://ebay.example/p/o1", fetchedAt: FETCHED_AT });
    expect(top.provenance.trust).toEqual({ source: "trust-signal:seed-list" });
  });

  it("preserves agent-observed provenance and placement disclosure for the human-facing brief", () => {
    const observed: Offer = {
      ...offer("browser-1", 9700, { store: "agent_browser", sponsored: true }),
      acquisition: {
        kind: "agent_observed",
        observedAt: "2026-08-16T10:00:00.000Z",
        receivedAt: "2026-08-16T10:01:00.000Z",
        placement: "unknown",
      },
    };
    const brief = composeBuyersBrief({
      searchId: "search_browser",
      results: rankOffers([observed], { text: "wool sneakers" }, {}),
      interpretedQuery: {
        criteria: { text: "wool sneakers" },
        appliedProfileEntries: [],
        overriddenProfileEntries: [],
        unmatchedQueryWords: [],
      },
      storeStatuses: [{ store: "agent_browser", ok: true, offerCount: 1, durationMs: 1 }],
    });

    expect((brief.finalists[0] as unknown as { acquisition?: unknown }).acquisition).toEqual(observed.acquisition);
  });

  it("rejected appendix names id, title, and the EXACT eliminating criteria", () => {
    const brief = tenOfferBrief();
    const byId = Object.fromEntries(brief.rejected.map((r) => [r.offerId, r]));
    expect(byId.o7!.eliminatedBy).toEqual([
      "over budget: price 15000 USD exceeds budget 12000 USD",
    ]);
    expect(byId.o8!.eliminatedBy).toEqual([
      "missing must-have attributes: matches 0/1 required attributes; missing: wool",
    ]);
    expect(byId.o9!.eliminatedBy).toEqual(["out of stock"]);
    // o5 qualified but was outranked past the 5-finalist cap; o10 (sponsored
    // tier, last) is excluded by the sponsored de-prioritization — cited
    // verbatim, never a potentially-false score comparison.
    expect(byId.o5!.eliminatedBy[0]).toMatch(/^outranked on your criteria: score /);
    expect(byId.o10!.eliminatedBy).toEqual([
      "sponsored listing: labeled and ranked below all non-sponsored offers",
    ]);
    expect(brief.rejected).toHaveLength(5);
  });

  it("coverage lists EVERY registered store with honest statuses — blocked is never omitted", () => {
    const brief = tenOfferBrief();
    expect(brief.coverage).toEqual([
      { store: "ebay", status: "searched", offerCount: 10 },
      { store: "amazon", status: "blocked", offerCount: 0, detail: "blocked: bot check triggered" },
      { store: "etsy", status: "not_configured", offerCount: 0, detail: "not_configured: ETSY_API_KEY not set" },
      { store: "shopify", status: "error", offerCount: 0, detail: "timeout: search timed out after 2000ms" },
    ]);
  });

  it("a sponsored finalist is badged and NEVER above a criteria-better non-sponsored one (order inherited)", () => {
    // 2 organic + 1 sponsored (the CHEAPEST offer) → sponsored still ranks last.
    const offers = [
      offer("s1", 9800, { deliveryBy: "2026-07-08" }),
      offer("s2", 10000, {}),
      offer("s3", 5000, { sponsored: true }),
    ];
    const results = rankOffers(offers, CRITERIA, {});
    const brief = composeBuyersBrief({
      searchId: "search_sponsored",
      results,
      interpretedQuery: INTERPRETED,
      storeStatuses: STATUSES,
    });
    expect(brief.finalists.map((f) => f.offerId)).toEqual(["s1", "s2", "s3"]);
    expect(brief.finalists[2]!.sponsored).toBe(true);
    const lastNonSponsored = brief.finalists.filter((f) => !f.sponsored).map((f) => f.rank);
    expect(Math.max(...lastNonSponsored)).toBeLessThan(brief.finalists[2]!.rank);
  });

  it("the budget echo attaches ONLY to budget-relevant price reasons, money-formatted, citing the profile when applied", () => {
    const applied = [
      { id: "pe_1", origin: "stated" as const, kind: "budget", appliedTo: "maxPrice", detail: "budget 12000 USD" },
    ];
    // Base price line: plain "price:" — no budget echo.
    expect(whyThisLines([{ criterion: "price", detail: "lowest price: 9800 USD" }], CRITERIA, applied)).toEqual([
      "price: lowest price: 9800 USD",
    ]);
    // Budget-relevant price reason (as rank.ts actually emits it — with the
    // stable "over_budget" code: money-formatted echo + profile citation.
    expect(
      whyThisLines(
        [{ criterion: "price", detail: "price 15000 USD exceeds budget 12000 USD", code: "over_budget" }],
        CRITERIA,
        applied,
      ),
    ).toEqual(["your budget (from your profile) (≤ 120.00 USD): price 15000 USD exceeds budget 12000 USD"]);
    // Same without a profile-applied budget: no citation.
    expect(
      whyThisLines(
        [{ criterion: "price", detail: "price 15000 USD exceeds budget 12000 USD", code: "over_budget" }],
        CRITERIA,
        [],
      ),
    ).toEqual(["your budget (≤ 120.00 USD): price 15000 USD exceeds budget 12000 USD"]);
  });

  it("computeTradeoffs emits a spec delta when finalists differ on matched must-haves", () => {
    const partial = rankOffers(
      [offer("m1", 9800, {}), offer("m2", 9900, { title: "Canvas Runner m2" })],
      { text: "wool sneakers", mustHaveAttributes: ["wool"] },
      {},
    );
    const m2 = partial.find((r) => r.offer.id === "m2")!;
    const tradeoffs = computeTradeoffs(m2, partial, { text: "wool sneakers", mustHaveAttributes: ["wool"] });
    expect(tradeoffs).toContainEqual({
      dimension: "spec",
      detail: "matches 0/1 must-haves — the best finalist matches 1/1",
    });
  });

  it("zero qualifying offers → zero finalists (honest emptiness beats padding)", () => {
    const results = rankOffers([offer("x1", 15000, {}), offer("x2", 16000, {})], CRITERIA, {});
    const brief = composeBuyersBrief({
      searchId: "search_empty",
      results,
      interpretedQuery: INTERPRETED,
      storeStatuses: STATUSES,
    });
    expect(brief.finalists).toHaveLength(0);
    expect(brief.rejected).toHaveLength(2);
  });
});

describe("whyThisLines — defensive floor", () => {
  it("badge-only reasons fall back to verbatim reasons instead of an empty (schema-invalid) whyThis", () => {
    const lines = whyThisLines(
      [{ criterion: "sponsored_deprioritization", detail: "sponsored listing: labeled and ranked below all non-sponsored offers" }],
      { text: "x" },
      [],
    );
    expect(lines).toEqual([
      "sponsored_deprioritization: sponsored listing: labeled and ranked below all non-sponsored offers",
    ]);
  });
});

describe("rejected-appendix overflow wording is numerically true", () => {
  const PLAIN: SearchQuery = { text: "wool sneakers", mustHaveAttributes: ["wool"] };
  const PLAIN_IQ: InterpretedQuery = {
    criteria: PLAIN,
    appliedProfileEntries: [],
    overriddenProfileEntries: [],
    unmatchedQueryWords: [],
  };

  it("a HIGHER-scoring sponsored overflow cites the sponsored de-prioritization verbatim — never a false 'score below'", () => {
    // 5 organic + 1 sponsored whose criteria score (cheapest, in stock, spec match)
    // EXCEEDS the last finalist's — it is excluded by the sponsored tier, not by score.
    const offers = [
      offer("q1", 9800, {}),
      offer("q2", 9900, {}),
      offer("q3", 10000, {}),
      offer("q4", 10100, {}),
      offer("q5", 10200, {}),
      offer("spon", 5000, { sponsored: true }),
    ];
    const results = rankOffers(offers, PLAIN, {});
    const sponsored = results.find((r) => r.offer.id === "spon")!;
    const lastFinalist = results[4]!;
    expect(sponsored.score).toBeGreaterThan(lastFinalist.score); // the falsehood trap is real
    const brief = composeBuyersBrief({
      searchId: "search_sponsored_overflow",
      results,
      interpretedQuery: PLAIN_IQ,
      storeStatuses: STATUSES,
    });
    const rejectedSponsored = brief.rejected.find((r) => r.offerId === "spon")!;
    expect(rejectedSponsored.eliminatedBy).toEqual([
      "sponsored listing: labeled and ranked below all non-sponsored offers",
    ]);
    for (const line of rejectedSponsored.eliminatedBy) {
      expect(line).not.toMatch(/score .* below/);
    }
  });

  it("an unknown-placement browser overflow is not falsely labeled as sponsored in the rejected appendix", () => {
    const unknownPlacement: Offer = {
      ...offer("observed", 5000, { store: "agent_browser", sponsored: true }),
      acquisition: {
        kind: "agent_observed",
        observedAt: "2026-08-16T10:00:00.000Z",
        receivedAt: "2026-08-16T10:01:00.000Z",
        placement: "unknown",
      },
    };
    const results = rankOffers(
      [
        offer("q1", 9800, {}),
        offer("q2", 9900, {}),
        offer("q3", 10000, {}),
        offer("q4", 10100, {}),
        offer("q5", 10200, {}),
        unknownPlacement,
      ],
      PLAIN,
      {},
    );
    const brief = composeBuyersBrief({
      searchId: "search_unknown_placement_overflow",
      results,
      interpretedQuery: PLAIN_IQ,
      storeStatuses: STATUSES,
    });

    expect(brief.rejected.find((row) => row.offerId === "observed")?.eliminatedBy).toEqual([
      "placement not confirmed: treated like sponsored and ranked below confirmed organic offers",
    ]);
  });

  it("a score TIE at the finalist cap uses tie wording, never a false 'below' score comparison", () => {
    // Six identically-priced, identically-specced organic offers: all scores equal;
    // the 6th is cut purely by the deterministic tie-break.
    const offers = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id) => offer(id, 9900, {}));
    const results = rankOffers(offers, PLAIN, {});
    expect(new Set(results.map((r) => r.score)).size).toBe(1); // genuine tie
    const brief = composeBuyersBrief({
      searchId: "search_tie",
      results,
      interpretedQuery: PLAIN_IQ,
      storeStatuses: STATUSES,
    });
    expect(brief.finalists).toHaveLength(5);
    const cut = brief.rejected.find((r) => r.offerId === "t6")!;
    expect(cut.eliminatedBy).toEqual([
      "outranked on your criteria: tied with the last finalist (score 75.00) and ranked below on the deterministic tie-break (price, then offer id)",
    ]);
  });

  it("a genuinely lower-scoring organic overflow keeps the exact numeric comparison", () => {
    const offers = [
      offer("q1", 9800, {}),
      offer("q2", 9900, {}),
      offer("q3", 10000, {}),
      offer("q4", 10100, {}),
      offer("q5", 10200, {}),
      offer("q6", 10300, {}),
    ];
    const results = rankOffers(offers, PLAIN, {});
    const brief = composeBuyersBrief({
      searchId: "search_overflow",
      results,
      interpretedQuery: PLAIN_IQ,
      storeStatuses: STATUSES,
    });
    const cut = brief.rejected.find((r) => r.offerId === "q6")!;
    const last = results[4]!;
    const q6 = results.find((r) => r.offer.id === "q6")!;
    expect(q6.score).toBeLessThan(last.score);
    expect(cut.eliminatedBy).toEqual([
      `outranked on your criteria: score ${q6.score.toFixed(2)} below the last finalist (${last.score.toFixed(2)})`,
    ]);
  });
});
