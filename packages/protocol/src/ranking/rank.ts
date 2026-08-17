import type {
  Offer,
  RankedResult,
  RankReason,
  SearchQuery,
  TrustSignal,
} from "../schemas/core.js";
import { trustKey } from "../trust/key.js";

/**
 * northcinder neutrality ranking — the auditable brand claim (spec §4 invariants 1 & 5).
 *
 * This module is deliberately part of the OPEN protocol package so the open
 * client can vendor it, diff it, and verify the deployed service against it:
 *
 *  - PURE + DETERMINISTIC: no clock, no randomness, no I/O. Same inputs →
 *    byte-identical output (ties broken by score, then price, then offer id).
 *  - Scores derive ONLY from the user's criteria: price, spec match, delivery,
 *    availability, merchant trust, ethics preferences. There is no input a
 *    seller can pay to influence.
 *  - `sponsored` NEVER contributes positively. Sponsored offers are ranked in
 *    a strictly lower tier than every non-sponsored offer, always labeled, and
 *    always carry a `sponsored_deprioritization` reason. Consequence (tested
 *    property): setting `sponsored: true` on any offer can never raise its rank.
 */

/** Extra (non-paid) inputs the ranking may consult. All optional. */
export interface RankingInputs {
  /**
   * Merchant trust signals keyed by `trustKey(merchant)` (trust/key.ts) —
   * the collision-safe canonical key, NOT the bare `merchant.id` because bare
   * ids collide across stores. The service's `/v1/search`
   * trustSignals map and both re-verifiers use the same key in lockstep.
   */
  trust?: Record<string, TrustSignal>;
}

/** Exact reason text attached to every sponsored offer. */
export const SPONSORED_DEPRIORITIZATION_DETAIL =
  "sponsored listing: labeled and ranked below all non-sponsored offers";

/**
 * Stable machine-readable codes for the reasons that represent a
 * HARD-CRITERION elimination — i.e. the ones `@northcinder/brief` used to detect
 * by pattern-matching `detail`'s prose ("exceeds budget", "missing:", etc).
 * rank.ts attaches the matching code to `RankReason.code` alongside the
 * human-auditable `detail`; a wording change to `detail` alone can no longer
 * silently break elimination detection downstream.
 */
export const RANK_ELIMINATION_CODES = {
  OVER_BUDGET: "over_budget",
  SPEC_MISSING: "spec_missing",
  DELIVERY_MISSED: "delivery_missed",
  OUT_OF_STOCK: "out_of_stock",
} as const;
export type RankEliminationCode = (typeof RANK_ELIMINATION_CODES)[keyof typeof RANK_ELIMINATION_CODES];

/** Criteria-only score weights. Documented so audits can reproduce scores. */
export const RANK_WEIGHTS = {
  priceBest: 40, // linear within a currency group: cheapest = 40, priciest = 0
  overBudgetPenalty: 25,
  specMatchFull: 30, // scaled by matched fraction
  specMissPenaltyEach: 10,
  deliveryMeets: 10,
  deliveryMissesPenalty: 15,
  inStock: 5,
  preorderPenalty: 5,
  outOfStockPenalty: 20,
  trustTrusted: 10,
  trustKnown: 5,
  flaggedPenalty: 40,
  ethicsMatchFull: 8, // scaled by matched fraction
} as const;

interface Scored {
  offer: Offer;
  score: number;
  reasons: RankReason[];
}

function offerHaystack(offer: Offer): string {
  return `${offer.product.title} ${Object.entries(offer.product.attributes).flat().join(" ")}`.toLowerCase();
}

function priceComponent(offer: Offer, all: Offer[]): { score: number; reasons: RankReason[] } {
  const group = all
    .filter((o) => o.price.currency === offer.price.currency)
    .map((o) => o.price.amount)
    .sort((a, b) => a - b);
  const min = group[0]!;
  const max = group[group.length - 1]!;
  const cur = offer.price.currency;
  const amount = offer.price.amount;

  const score =
    max === min ? RANK_WEIGHTS.priceBest : (RANK_WEIGHTS.priceBest * (max - amount)) / (max - min);

  let detail: string;
  if (amount === min) {
    const nextBest = group.find((a) => a > amount);
    detail =
      nextBest === undefined
        ? `lowest price: ${amount} ${cur}`
        : `lowest price: ${amount} ${cur}, ${nextBest - amount} ${cur} cheaper than the next offer`;
  } else {
    detail = `price: ${amount} ${cur}, ${amount - min} ${cur} above the cheapest offer`;
  }
  return { score, reasons: [{ criterion: "price", detail }] };
}

function scoreOffer(offer: Offer, criteria: SearchQuery, all: Offer[], inputs: RankingInputs): Scored {
  let score = 0;
  const reasons: RankReason[] = [];

  // --- price (always present; guarantees non-empty reasons) ---
  const price = priceComponent(offer, all);
  score += price.score;
  reasons.push(...price.reasons);

  // --- budget ceiling ---
  if (
    criteria.maxPrice !== undefined &&
    criteria.maxPrice.currency === offer.price.currency &&
    offer.price.amount > criteria.maxPrice.amount
  ) {
    score -= RANK_WEIGHTS.overBudgetPenalty;
    reasons.push({
      criterion: "price",
      detail: `price ${offer.price.amount} ${offer.price.currency} exceeds budget ${criteria.maxPrice.amount} ${criteria.maxPrice.currency}`,
      code: RANK_ELIMINATION_CODES.OVER_BUDGET,
    });
  }

  // --- spec match (must-have attributes) ---
  const mustHaves = criteria.mustHaveAttributes ?? [];
  if (mustHaves.length > 0) {
    const haystack = offerHaystack(offer);
    const matched = mustHaves.filter((a) => haystack.includes(a.toLowerCase()));
    const missing = mustHaves.filter((a) => !haystack.includes(a.toLowerCase()));
    score += (RANK_WEIGHTS.specMatchFull * matched.length) / mustHaves.length;
    score -= RANK_WEIGHTS.specMissPenaltyEach * missing.length;
    const base = `matches ${matched.length}/${mustHaves.length} required attributes`;
    reasons.push({
      criterion: "spec_match",
      detail:
        missing.length === 0
          ? `${base}: ${matched.join(", ")}`
          : `${base}; missing: ${missing.join(", ")}`,
      ...(missing.length > 0 ? { code: RANK_ELIMINATION_CODES.SPEC_MISSING } : {}),
    });
  }

  // --- delivery deadline ---
  if (criteria.deliveryBy !== undefined) {
    const promised = offer.shipping?.deliveryBy;
    if (promised !== undefined) {
      // ISO dates compare correctly as strings.
      if (promised <= criteria.deliveryBy) {
        score += RANK_WEIGHTS.deliveryMeets;
        reasons.push({
          criterion: "delivery",
          detail: `promised delivery ${promised} meets requested ${criteria.deliveryBy}`,
        });
      } else {
        score -= RANK_WEIGHTS.deliveryMissesPenalty;
        reasons.push({
          criterion: "delivery",
          detail: `promised delivery ${promised} misses requested ${criteria.deliveryBy}`,
          code: RANK_ELIMINATION_CODES.DELIVERY_MISSED,
        });
      }
    } else {
      reasons.push({
        criterion: "delivery",
        detail: `no promised delivery date to compare against requested ${criteria.deliveryBy}`,
      });
    }
  }

  // --- availability ---
  switch (offer.availability) {
    case "in_stock":
      score += RANK_WEIGHTS.inStock;
      reasons.push({ criterion: "availability", detail: "in stock" });
      break;
    case "out_of_stock":
      score -= RANK_WEIGHTS.outOfStockPenalty;
      reasons.push({
        criterion: "availability",
        detail: "out of stock — ranked below every buyable offer",
        code: RANK_ELIMINATION_CODES.OUT_OF_STOCK,
      });
      break;
    case "preorder":
      score -= RANK_WEIGHTS.preorderPenalty;
      reasons.push({ criterion: "availability", detail: "preorder only" });
      break;
    case "unknown":
      break;
  }

  // --- merchant trust ---
  const trust = inputs.trust?.[trustKey(offer.merchant)];
  if (trust !== undefined) {
    const evidenceDetail = trust.evidence[0]?.detail ?? "no evidence recorded";
    if (trust.level === "flagged") {
      score -= RANK_WEIGHTS.flaggedPenalty;
      reasons.push({
        criterion: "flagged_merchant",
        detail: `merchant "${offer.merchant.id}" is flagged: ${evidenceDetail}`,
      });
    } else {
      if (trust.level === "trusted") score += RANK_WEIGHTS.trustTrusted;
      if (trust.level === "known") score += RANK_WEIGHTS.trustKnown;
      reasons.push({
        criterion: "trust",
        detail: `merchant "${offer.merchant.id}" trust level: ${trust.level} (${evidenceDetail})`,
      });
    }
  }

  // --- ethics preferences ---
  const ethics = criteria.ethicsFlags ?? [];
  if (ethics.length > 0) {
    const haystack = offerHaystack(offer);
    const matched = ethics.filter((f) => haystack.includes(f.toLowerCase()));
    if (matched.length > 0) {
      score += (RANK_WEIGHTS.ethicsMatchFull * matched.length) / ethics.length;
      reasons.push({
        criterion: "ethics",
        detail: `matches ethics preferences: ${matched.join(", ")}`,
      });
    }
  }

  // --- sponsored: labeling + de-prioritization ONLY, never a score input ---
  if (offer.sponsored) {
    reasons.push({
      criterion: "sponsored_deprioritization",
      detail: SPONSORED_DEPRIORITIZATION_DETAIL,
    });
  }

  return { offer, score, reasons };
}

/**
 * Deterministic neutrality ranking: `(offers, criteria) → RankedResult[]`.
 *
 * Ordering: non-sponsored tier strictly above sponsored tier (the brand
 * promise — primary); within it, buyable offers strictly above out-of-stock
 * ones (a buyer cannot buy what isn't there — secondary); within a tier by
 * criteria score (desc), then price (asc), then offer id (asc) — a total,
 * input-order-independent order.
 */
export function rankOffers(
  offers: Offer[],
  criteria: SearchQuery,
  inputs: RankingInputs = {},
): RankedResult[] {
  const scored = offers.map((o) => scoreOffer(o, criteria, offers, inputs));
  scored.sort((a, b) => {
    const tierA = a.offer.sponsored ? 1 : 0;
    const tierB = b.offer.sponsored ? 1 : 0;
    if (tierA !== tierB) return tierA - tierB;
    const oosA = a.offer.availability === "out_of_stock" ? 1 : 0;
    const oosB = b.offer.availability === "out_of_stock" ? 1 : 0;
    if (oosA !== oosB) return oosA - oosB;
    if (a.score !== b.score) return b.score - a.score;
    if (a.offer.price.amount !== b.offer.price.amount) return a.offer.price.amount - b.offer.price.amount;
    return a.offer.id < b.offer.id ? -1 : a.offer.id > b.offer.id ? 1 : 0;
  });
  return scored.map(({ offer, score, reasons }) => ({ offer, score, reasons }));
}
