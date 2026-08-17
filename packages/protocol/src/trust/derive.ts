import type { TrustLevel } from "../schemas/core.js";

/**
 * northcinder trust derivation — the OPEN half of the trust corpus (spec §4
 * invariant 4). Like `rankOffers`, this is deliberately part of the open
 * protocol package: a buyer-run engine adapts locally configured signal data
 * and curation, never a secret formula. `deriveTrustLevel` is pure and
 * deterministic (no clock, no randomness, no I/O), doc-generated into
 * docs/TRUST.md with a drift test.
 *
 * §4 invariants encoded here:
 *  1. Absence of history is NEVER negative evidence — a missing/young/unranked
 *     measurement can prevent `known`, never produce `flagged`; `unknown` is
 *     the floor for no-history.
 *  2. `flagged` requires deny-grade evidence (deny seed or curated fraud
 *     list). Automated heuristics alone never flag.
 *  6. No seller-controlled input appears in these inputs at all: every field
 *     is either locally curated or attacker-cost-asymmetric (aged domains
 *     cost real money; popularity ranks cost real traffic).
 */

/**
 * Named thresholds with rationale (doc-generated — change one and the
 * TRUST.md drift test fails until you regenerate).
 */
export const TRUST_THRESHOLDS = {
  /**
   * 3 years (365 × 3). Domain age is the single most predictive fake-shop
   * signal in the research corpus (0.9167 accuracy alone), and buying an
   * aged domain costs an attacker ≥ $1k — cost asymmetry, not seller input.
   */
  knownMinDomainAgeDays: 1095,
  /**
   * Tranco top-1M. Sustained real-traffic popularity is expensive to fake at
   * list scale; combined with age it clears "this store actually exists".
   */
  knownMaxPopularityRank: 1_000_000,
} as const;

/**
 * MEASUREMENTS + curation hits, not raw provider output: the buyer-run engine
 * adapts its probes (RDAP, Tranco, seed lists, …) into these fields. Every
 * absent optional field means "signal unavailable" — which, per invariant 1,
 * can only ever hold a merchant at `unknown`, never push it lower.
 */
export interface TrustDerivationInputs {
  /** Local deployer allow-seed hit (curated) → `trusted`. */
  allowHit?: boolean;
  /** Local deployer deny-seed hit (curated) → `flagged`. Deny beats allow. */
  denyHit?: boolean;
  /** Hit on a curated external fraud list we may lawfully cite → `flagged`. */
  curatedFraudHit?: boolean;
  /** Storefront domain on an established platform (verifiable, domain-matched). */
  platformHit?: boolean;
  /** Measured domain age in days (e.g. RDAP registration event). */
  domainAgeDays?: number;
  /** Measured popularity rank (e.g. Tranco), 1 = most popular. */
  popularityRank?: number;
}

/** Stable machine codes for WHY a level was derived (mirrors RANK_ELIMINATION_CODES). */
export const TRUST_DERIVATION_CODES = {
  DENY_LISTED: "deny_listed",
  CURATED_FRAUD_LISTED: "curated_fraud_listed",
  ALLOW_LISTED: "allow_listed",
  PLATFORM_HOSTED: "platform_hosted",
  ESTABLISHED_DOMAIN: "established_domain",
  NO_POSITIVE_HISTORY: "no_positive_history",
} as const;
export type TrustDerivationCode =
  (typeof TRUST_DERIVATION_CODES)[keyof typeof TRUST_DERIVATION_CODES];

export interface TrustDerivationReason {
  code: TrustDerivationCode;
  detail: string;
}

export interface TrustDerivation {
  level: TrustLevel;
  /** Non-empty by construction: even `unknown` says why it is unknown. */
  reasons: TrustDerivationReason[];
}

/**
 * Pure level derivation. Rule table (first match wins):
 *   1. deny-seed or curated-fraud hit          → flagged
 *   2. allow-seed hit                          → trusted
 *   3. platform heuristic OR
 *      (age ≥ knownMinDomainAgeDays AND
 *       rank ≤ knownMaxPopularityRank)         → known
 *   4. otherwise                               → unknown
 */
export function deriveTrustLevel(inputs: TrustDerivationInputs): TrustDerivation {
  if (inputs.denyHit === true) {
    return {
      level: "flagged",
      reasons: [
        { code: TRUST_DERIVATION_CODES.DENY_LISTED, detail: "merchant is on the locally configured deny seed list" },
      ],
    };
  }
  if (inputs.curatedFraudHit === true) {
    return {
      level: "flagged",
      reasons: [
        {
          code: TRUST_DERIVATION_CODES.CURATED_FRAUD_LISTED,
          detail: "merchant is listed on a curated external fraud list",
        },
      ],
    };
  }
  if (inputs.allowHit === true) {
    return {
      level: "trusted",
      reasons: [
        { code: TRUST_DERIVATION_CODES.ALLOW_LISTED, detail: "merchant is on the locally configured allow seed list" },
      ],
    };
  }

  const reasons: TrustDerivationReason[] = [];
  if (inputs.platformHit === true) {
    reasons.push({
      code: TRUST_DERIVATION_CODES.PLATFORM_HOSTED,
      detail: "storefront hosted on an established platform domain",
    });
  }
  // Measurements must be FINITE and in a sane range before they can clear the
  // "established" bar. A garbage probe result (NaN / Infinity / negative age /
  // rank < 1) must never silently grant "known" trust — it degrades to
  // "signal unavailable" (treated as absent), preserving the unknown floor.
  const validAge =
    inputs.domainAgeDays !== undefined && Number.isFinite(inputs.domainAgeDays) && inputs.domainAgeDays >= 0;
  const validRank =
    inputs.popularityRank !== undefined && Number.isFinite(inputs.popularityRank) && inputs.popularityRank >= 1;
  const established =
    validAge &&
    inputs.domainAgeDays! >= TRUST_THRESHOLDS.knownMinDomainAgeDays &&
    validRank &&
    inputs.popularityRank! <= TRUST_THRESHOLDS.knownMaxPopularityRank;
  if (established) {
    reasons.push({
      code: TRUST_DERIVATION_CODES.ESTABLISHED_DOMAIN,
      detail: `domain age ${inputs.domainAgeDays} days ≥ ${TRUST_THRESHOLDS.knownMinDomainAgeDays} and popularity rank ${inputs.popularityRank} ≤ ${TRUST_THRESHOLDS.knownMaxPopularityRank}`,
    });
  }
  if (reasons.length > 0) return { level: "known", reasons };

  // Invariant 1: no positive history is the FLOOR, never a downgrade.
  return {
    level: "unknown",
    reasons: [
      {
        code: TRUST_DERIVATION_CODES.NO_POSITIVE_HISTORY,
        detail:
          "no curated hit and measured signals do not clear the established-domain bar — absence of history is never negative evidence",
      },
    ],
  };
}
