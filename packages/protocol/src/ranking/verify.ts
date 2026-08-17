import type { RankedResult, SearchQuery, TrustSignal } from "../schemas/core.js";
import { rankOffers } from "./rank.js";

/**
 * Client-side re-rank verification (client-side ranking verification).
 *
 * "Deterministic and auditable" is only worth anything if the USER'S OWN
 * MACHINE can check it: this module re-runs the open `rankOffers` over the
 * offers + trust signals a service returned and compares the service's order,
 * scores, and reasons against the recomputation. A service that boosts a
 * result (pay-for-rank), inflates a score, or rewrites a reason diverges from
 * the open implementation and is flagged with the exact divergence.
 *
 * Pure and deterministic like rank.ts itself: no clock, no randomness, no I/O.
 */

/** One position where the service's response diverges from the recomputation. */
export interface RankingDivergence {
  kind: "order_mismatch" | "score_mismatch" | "reasons_mismatch";
  /** 1-based position in the returned ranking. */
  position: number;
  expected: { offerKey: string; score: number };
  actual: { offerKey: string; score: number };
}

export type RankingVerification =
  | { verified: true; comparedOffers: number }
  | {
      verified: false;
      divergences: RankingDivergence[];
      /** Offer keys (`sourceStore:offerId`) in recomputed (correct) order. */
      expectedOrder: string[];
      /** Offer keys in the order the service actually returned. */
      actualOrder: string[];
    }
  | { verified: "not_applicable"; reason: string };

/** Offers are only unique within a store's catalog — key by store + id. */
function offerKey(r: RankedResult): string {
  return `${r.offer.sourceStore}:${r.offer.id}`;
}

/**
 * Recompute the open ranking over a service response's own inputs and diff it
 * against what the service returned.
 *
 * `not_applicable` (never a fake green) when there is nothing to verify or
 * when the service did not return the trust signals its ranking consumed
 * (pre-extension service) — without them the recomputation would not be
 * deterministic.
 */
export function verifySearchRanking(
  response: { results: RankedResult[]; trustSignals?: Record<string, TrustSignal> | undefined },
  query: SearchQuery,
): RankingVerification {
  if (response.results.length === 0) {
    return { verified: "not_applicable", reason: "no results to verify" };
  }
  if (response.trustSignals === undefined) {
    return {
      verified: "not_applicable",
      reason:
        "service response did not include trustSignals — the ranking inputs cannot be deterministically recomputed (older service)",
    };
  }

  const expected = rankOffers(
    response.results.map((r) => r.offer),
    query,
    { trust: response.trustSignals },
  );

  const divergences: RankingDivergence[] = [];
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i]!;
    const got = response.results[i]!;
    const base = {
      position: i + 1,
      expected: { offerKey: offerKey(want), score: want.score },
      actual: { offerKey: offerKey(got), score: got.score },
    };
    if (offerKey(want) !== offerKey(got)) {
      divergences.push({ kind: "order_mismatch", ...base });
    } else if (want.score !== got.score) {
      divergences.push({ kind: "score_mismatch", ...base });
    } else if (JSON.stringify(want.reasons) !== JSON.stringify(got.reasons)) {
      divergences.push({ kind: "reasons_mismatch", ...base });
    }
  }

  if (divergences.length === 0) {
    return { verified: true, comparedOffers: expected.length };
  }
  return {
    verified: false,
    divergences,
    expectedOrder: expected.map(offerKey),
    actualOrder: response.results.map(offerKey),
  };
}
