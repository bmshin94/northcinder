import type {
  Offer,
  RankedResult,
  RankReason,
  SearchQuery,
  TrustSignal,
} from "../schemas/core.js";
import { decisionOfferKey } from "../schemas/decision.js";
import { trustKey } from "../trust/key.js";

/**
 * northcinder neutrality ranking — the auditable brand claim (spec §4 invariants 1 & 5).
 *
 * This module is deliberately part of the OPEN protocol package so the open
 * client can vendor it, diff it, and verify the deployed service against it:
 *
 *  - PURE + DETERMINISTIC: no clock, no randomness, no I/O. Same inputs →
 *    byte-identical output (ties broken by score, then price, then the
 *    collision-free store-scoped offer tuple).
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
  REQUIRED_ATTRIBUTE_MISSING: "required_attribute_missing",
  REQUIRED_PRICE_EXCEEDED: "required_price_exceeded",
  REQUIRED_DELIVERY_MISSED: "required_delivery_missed",
  REQUIRED_DELIVERY_UNKNOWN: "required_delivery_unknown",
  REQUIRED_ETHICS_MISSING: "required_ethics_missing",
  REQUIRED_AVAILABILITY_MISMATCH: "required_availability_mismatch",
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

/** Fixed points for explicit soft preferences; callers can name rules but cannot weight them. */
export const PREFERRED_CRITERION_POINTS = {
  attribute: 12,
  max_price: 10,
  delivery_by: 8,
  ethics: 6,
  availability: 4,
} as const;

interface Scored {
  offer: Offer;
  score: number;
  reasons: RankReason[];
  requiredFailures: number;
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
  let requiredFailures = 0;
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

  // --- explicit named hard requirements ---
  for (const criterion of criteria.criteria ?? []) {
    if (criterion.importance !== "required") continue;
    const audit = { criterionId: criterion.id, importance: criterion.importance } as const;
    switch (criterion.kind) {
      case "attribute": {
        const matches = offerHaystack(offer).includes(criterion.value.toLowerCase());
        reasons.push({
          criterion: "spec_match",
          detail: matches
            ? `meets required criterion "${criterion.label}": ${criterion.value}`
            : `missing required criterion "${criterion.label}": ${criterion.value}`,
          ...audit,
          ...(!matches ? { code: RANK_ELIMINATION_CODES.REQUIRED_ATTRIBUTE_MISSING } : {}),
        });
        if (!matches) requiredFailures++;
        break;
      }
      case "max_price": {
        const matches =
          offer.price.currency === criterion.value.currency && offer.price.amount <= criterion.value.amount;
        reasons.push({
          criterion: "price",
          detail: matches
            ? `meets required criterion "${criterion.label}": ${offer.price.amount} ${offer.price.currency}`
            : `fails required criterion "${criterion.label}": ${offer.price.amount} ${offer.price.currency} exceeds or cannot be compared with ${criterion.value.amount} ${criterion.value.currency}`,
          ...audit,
          ...(!matches ? { code: RANK_ELIMINATION_CODES.REQUIRED_PRICE_EXCEEDED } : {}),
        });
        if (!matches) requiredFailures++;
        break;
      }
      case "delivery_by": {
        const promised = offer.shipping?.deliveryBy;
        const matches = promised !== undefined && promised <= criterion.value;
        const code =
          promised === undefined
            ? RANK_ELIMINATION_CODES.REQUIRED_DELIVERY_UNKNOWN
            : !matches
              ? RANK_ELIMINATION_CODES.REQUIRED_DELIVERY_MISSED
              : undefined;
        reasons.push({
          criterion: "delivery",
          detail:
            promised === undefined
              ? `fails required criterion "${criterion.label}": delivery date is unknown`
              : matches
                ? `meets required criterion "${criterion.label}": ${promised}`
                : `fails required criterion "${criterion.label}": ${promised} is after ${criterion.value}`,
          ...audit,
          ...(code !== undefined ? { code } : {}),
        });
        if (!matches) requiredFailures++;
        break;
      }
      case "ethics": {
        const matches = offerHaystack(offer).includes(criterion.value.toLowerCase());
        reasons.push({
          criterion: "ethics",
          detail: matches
            ? `meets required criterion "${criterion.label}": ${criterion.value}`
            : `missing required criterion "${criterion.label}": ${criterion.value}`,
          ...audit,
          ...(!matches ? { code: RANK_ELIMINATION_CODES.REQUIRED_ETHICS_MISSING } : {}),
        });
        if (!matches) requiredFailures++;
        break;
      }
      case "availability": {
        const matches = offer.availability === criterion.value;
        reasons.push({
          criterion: "availability",
          detail: matches
            ? `meets required criterion "${criterion.label}": ${criterion.value}`
            : `fails required criterion "${criterion.label}": ${offer.availability}, requested ${criterion.value}`,
          ...audit,
          ...(!matches ? { code: RANK_ELIMINATION_CODES.REQUIRED_AVAILABILITY_MISMATCH } : {}),
        });
        if (!matches) requiredFailures++;
        break;
      }
    }
  }

  // --- explicit named soft preferences: fixed code-owned points only ---
  for (const criterion of criteria.criteria ?? []) {
    if (criterion.importance !== "preferred") continue;
    const audit = { criterionId: criterion.id, importance: criterion.importance } as const;
    switch (criterion.kind) {
      case "attribute": {
        const matches = offerHaystack(offer).includes(criterion.value.toLowerCase());
        if (matches) score += PREFERRED_CRITERION_POINTS.attribute;
        reasons.push({
          criterion: "spec_match",
          detail: `${matches ? "matches" : "does not match"} preferred criterion "${criterion.label}": ${criterion.value}`,
          ...audit,
        });
        break;
      }
      case "max_price": {
        const matches =
          offer.price.currency === criterion.value.currency && offer.price.amount <= criterion.value.amount;
        if (matches) score += PREFERRED_CRITERION_POINTS.max_price;
        reasons.push({
          criterion: "price",
          detail: `${matches ? "matches" : "does not match"} preferred criterion "${criterion.label}": ${offer.price.amount} ${offer.price.currency} versus ${criterion.value.amount} ${criterion.value.currency}`,
          ...audit,
        });
        break;
      }
      case "delivery_by": {
        const promised = offer.shipping?.deliveryBy;
        const matches = promised !== undefined && promised <= criterion.value;
        if (matches) score += PREFERRED_CRITERION_POINTS.delivery_by;
        reasons.push({
          criterion: "delivery",
          detail:
            promised === undefined
              ? `does not match preferred criterion "${criterion.label}": delivery date is unknown`
              : `${matches ? "matches" : "does not match"} preferred criterion "${criterion.label}": ${promised} versus ${criterion.value}`,
          ...audit,
        });
        break;
      }
      case "ethics": {
        const matches = offerHaystack(offer).includes(criterion.value.toLowerCase());
        if (matches) score += PREFERRED_CRITERION_POINTS.ethics;
        reasons.push({
          criterion: "ethics",
          detail: `${matches ? "matches" : "does not match"} preferred criterion "${criterion.label}": ${criterion.value}`,
          ...audit,
        });
        break;
      }
      case "availability": {
        const matches = offer.availability === criterion.value;
        if (matches) score += PREFERRED_CRITERION_POINTS.availability;
        reasons.push({
          criterion: "availability",
          detail: `${matches ? "matches" : "does not match"} preferred criterion "${criterion.label}": ${offer.availability}, requested ${criterion.value}`,
          ...audit,
        });
        break;
      }
    }
  }

  // --- explicit named tie breakers: reasons only, never score inputs ---
  for (const criterion of criteria.criteria ?? []) {
    if (criterion.importance !== "tie_breaker") continue;
    const audit = { criterionId: criterion.id, importance: criterion.importance } as const;
    switch (criterion.kind) {
      case "attribute": {
        const matches = offerHaystack(offer).includes(criterion.value.toLowerCase());
        reasons.push({
          criterion: "spec_match",
          detail: `${matches ? "matches" : "does not match"} tie-break criterion "${criterion.label}": ${criterion.value}`,
          ...audit,
        });
        break;
      }
      case "max_price":
        reasons.push({
          criterion: "price",
          detail: `tie-break criterion "${criterion.label}": price ${offer.price.amount} ${offer.price.currency}`,
          ...audit,
        });
        break;
      case "delivery_by":
        reasons.push({
          criterion: "delivery",
          detail: `tie-break criterion "${criterion.label}": delivery ${offer.shipping?.deliveryBy ?? "unknown"}`,
          ...audit,
        });
        break;
      case "ethics": {
        const matches = offerHaystack(offer).includes(criterion.value.toLowerCase());
        reasons.push({
          criterion: "ethics",
          detail: `${matches ? "matches" : "does not match"} tie-break criterion "${criterion.label}": ${criterion.value}`,
          ...audit,
        });
        break;
      }
      case "availability": {
        const matches = offer.availability === criterion.value;
        reasons.push({
          criterion: "availability",
          detail: `${matches ? "matches" : "does not match"} tie-break criterion "${criterion.label}": ${offer.availability}, requested ${criterion.value}`,
          ...audit,
        });
        break;
      }
    }
  }

  // --- sponsored: labeling + de-prioritization ONLY, never a score input ---
  if (offer.sponsored) {
    reasons.push({
      criterion: "sponsored_deprioritization",
      detail: SPONSORED_DEPRIORITIZATION_DETAIL,
    });
  }

  return { offer, score, reasons, requiredFailures };
}

function compareTieBreakers(a: Offer, b: Offer, criteria: SearchQuery): number {
  for (const criterion of criteria.criteria ?? []) {
    if (criterion.importance !== "tie_breaker") continue;
    switch (criterion.kind) {
      case "attribute":
      case "ethics": {
        const aMatches = offerHaystack(a).includes(criterion.value.toLowerCase());
        const bMatches = offerHaystack(b).includes(criterion.value.toLowerCase());
        if (aMatches !== bMatches) return aMatches ? -1 : 1;
        break;
      }
      case "max_price": {
        const aComparable = a.price.currency === criterion.value.currency;
        const bComparable = b.price.currency === criterion.value.currency;
        if (aComparable !== bComparable) return aComparable ? -1 : 1;
        if (aComparable && a.price.amount !== b.price.amount) return a.price.amount - b.price.amount;
        break;
      }
      case "delivery_by": {
        const aDelivery = a.shipping?.deliveryBy;
        const bDelivery = b.shipping?.deliveryBy;
        if (aDelivery === undefined && bDelivery !== undefined) return 1;
        if (aDelivery !== undefined && bDelivery === undefined) return -1;
        if (aDelivery !== undefined && bDelivery !== undefined && aDelivery !== bDelivery) {
          return aDelivery < bDelivery ? -1 : 1;
        }
        break;
      }
      case "availability": {
        const aMatches = a.availability === criterion.value;
        const bMatches = b.availability === criterion.value;
        if (aMatches !== bMatches) return aMatches ? -1 : 1;
        break;
      }
    }
  }
  return 0;
}

/**
 * Deterministic neutrality ranking: `(offers, criteria) → RankedResult[]`.
 *
 * Ordering: non-sponsored tier strictly above sponsored tier (the brand
 * promise — primary); within it, candidates meeting every named requirement
 * precede eliminated candidates, then buyable offers precede out-of-stock
 * ones. Main fixed score follows. Named tie breakers compare typed facts only
 * when those scores are equal, before the legacy price and collision-free
 * store-scoped offer-tuple total-order fallbacks.
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
    const eliminatedA = a.requiredFailures > 0 ? 1 : 0;
    const eliminatedB = b.requiredFailures > 0 ? 1 : 0;
    if (eliminatedA !== eliminatedB) return eliminatedA - eliminatedB;
    const oosA = a.offer.availability === "out_of_stock" ? 1 : 0;
    const oosB = b.offer.availability === "out_of_stock" ? 1 : 0;
    if (oosA !== oosB) return oosA - oosB;
    if (a.score !== b.score) return b.score - a.score;
    const explicitTie = compareTieBreakers(a.offer, b.offer, criteria);
    if (explicitTie !== 0) return explicitTie;
    if (a.offer.price.amount !== b.offer.price.amount) return a.offer.price.amount - b.offer.price.amount;
    const keyA = decisionOfferKey(a.offer.sourceStore, a.offer.id);
    const keyB = decisionOfferKey(b.offer.sourceStore, b.offer.id);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
  return scored.map(({ offer, score, reasons }) => ({ offer, score, reasons }));
}
