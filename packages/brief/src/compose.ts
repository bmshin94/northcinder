import {
  BuyersBriefSchema,
  decisionOfferKey,
  RANK_ELIMINATION_CODES,
  trustKey,
  type CandidateDecisionEvidence,
  type DecisionReadiness,
  type AppliedProfileEntry,
  type BriefFinalist,
  type BuyersBrief,
  type CoverageEntry,
  type InterpretedQuery,
  type ProvenanceCell,
  type RankedResult,
  type RankReason,
  type RejectedOffer,
  type SearchQuery,
  type StoreStatus,
  type Tradeoff,
  type TrustSignal,
} from "@northcinder/protocol";

/**
 * `composeBuyersBrief` — the buyer brief buyer's brief, composed by CODE (safety contract law:
 * never model-generated) as a PURE, DETERMINISTIC function of the ranked
 * results, the interpretation echo, the per-store statuses, and the trust
 * signals. No clock, no randomness, no I/O: same inputs → identical brief.
 *
 * Finalist selection inherits the neutrality ranking VERBATIM — the brief
 * never re-ranks. Finalists are the first ≤5 ranked results not eliminated
 * by a hard user criterion; everything else lands in the rejected appendix
 * with the criteria that eliminated it (or the outranking finalist scores).
 */

export const MAX_FINALISTS = 5;

export interface BuyersBriefInput {
  /** search_products searchId this brief belongs to. */
  searchId: string;
  /** The service's neutrality-ranked results, order preserved. */
  results: RankedResult[];
  /** The profile interpretation echo: post-merge criteria + applied profile entries. */
  interpretedQuery: InterpretedQuery;
  /** Per-store outcomes — one per REGISTERED store (successes and failures). */
  storeStatuses: StoreStatus[];
  /** Trust signals keyed by trustKey(merchant) (the ranking's own inputs). */
  trustSignals?: Record<string, TrustSignal> | undefined;
  /** Optional decision evidence; affects decision display only, never ranking. */
  evidence?: readonly CandidateDecisionEvidence[] | undefined;
  /** Optional research readiness; absence remains explicitly provisional. */
  decisionReadiness?: DecisionReadiness | undefined;
}

/** Deterministic money formatting for human-facing lines (minor units → major). */
export function formatMoney(m: { amount: number; currency: string }): string {
  return `${(m.amount / 100).toFixed(2)} ${m.currency}`;
}

/**
 * Hard-criterion eliminations, derived from the OPEN ranking's own STRUCTURED
 * reason vocabulary: rank.ts attaches a stable `RANK_ELIMINATION_CODES`
 * value to `RankReason.code` for every reason that represents a hard
 * elimination, so this keys off that code rather than pattern-matching
 * `detail`'s human-auditable prose — a `detail` wording change in rank.ts can
 * no longer silently break elimination detection here. `flagged_merchant` has
 * no ranking-competing counterpart (it is never a "soft" reason), so it stays
 * keyed on `criterion` alone, same as before.
 */
export function eliminatingCriteria(result: RankedResult): string[] {
  const out: string[] = [];
  for (const r of result.reasons) {
    if (r.criterion === "flagged_merchant") out.push(`flagged merchant: ${r.detail}`);
    else if (r.code === RANK_ELIMINATION_CODES.OVER_BUDGET) out.push(`over budget: ${r.detail}`);
    else if (r.code === RANK_ELIMINATION_CODES.SPEC_MISSING) out.push(`missing must-have attributes: ${r.detail}`);
    else if (r.code === RANK_ELIMINATION_CODES.DELIVERY_MISSED) out.push(`misses delivery deadline: ${r.detail}`);
    else if (r.code === RANK_ELIMINATION_CODES.OUT_OF_STOCK) out.push("out of stock");
    else if (r.code === RANK_ELIMINATION_CODES.REQUIRED_ATTRIBUTE_MISSING) out.push(`required attribute missing: ${r.detail}`);
    else if (r.code === RANK_ELIMINATION_CODES.REQUIRED_PRICE_EXCEEDED) out.push(`required price exceeded: ${r.detail}`);
    else if (r.code === RANK_ELIMINATION_CODES.REQUIRED_DELIVERY_MISSED) out.push(`required delivery missed: ${r.detail}`);
    else if (r.code === RANK_ELIMINATION_CODES.REQUIRED_DELIVERY_UNKNOWN) out.push(`required delivery unknown: ${r.detail}`);
    else if (r.code === RANK_ELIMINATION_CODES.REQUIRED_ETHICS_MISSING) out.push(`required ethics missing: ${r.detail}`);
    else if (r.code === RANK_ELIMINATION_CODES.REQUIRED_AVAILABILITY_MISMATCH) out.push(`required availability mismatch: ${r.detail}`);
  }
  return out;
}

/**
 * whyThis: the ranking reasons rephrased against the USER's criteria —
 * a deterministic template per criterion, with "(from your profile)" when the
 * criterion was merged in from a profile profile default. Amounts stay in the
 * ranking vocabulary's raw minor units so whyThis is verbatim-traceable to
 * `reasons[]`. `sponsored_deprioritization` is excluded: the badge carries it.
 */
export function whyThisLines(
  reasons: RankReason[],
  criteria: SearchQuery,
  appliedProfileEntries: AppliedProfileEntry[],
): string[] {
  const fromProfile = (field: string): string =>
    appliedProfileEntries.some((e) => e.appliedTo === field) ? " (from your profile)" : "";
  const lines: string[] = [];
  for (const r of reasons) {
    switch (r.criterion) {
      case "price": {
        // The budget echo attaches ONLY to budget-relevant price reasons
        // (the ranking's "exceeds budget" details); the base cheapest/above-
        // cheapest line is a plain price statement. Budget is money-formatted
        // for the human ("≤ 120.00 USD"), the detail stays verbatim.
        const budgetRelevant = criteria.maxPrice !== undefined && r.code === RANK_ELIMINATION_CODES.OVER_BUDGET;
        lines.push(
          budgetRelevant
            ? `your budget${fromProfile("maxPrice")} (≤ ${formatMoney(criteria.maxPrice!)}): ${r.detail}`
            : `price: ${r.detail}`,
        );
        break;
      }
      case "spec_match":
        lines.push(
          `your must-haves${fromProfile("mustHaveAttributes")} (${(criteria.mustHaveAttributes ?? []).join(", ")}): ${r.detail}`,
        );
        break;
      case "delivery":
        lines.push(
          criteria.deliveryBy !== undefined
            ? `your delivery deadline${fromProfile("deliveryBy")} (${criteria.deliveryBy}): ${r.detail}`
            : `delivery: ${r.detail}`,
        );
        break;
      case "availability":
        lines.push(`availability: ${r.detail}`);
        break;
      case "trust":
        lines.push(`merchant trust: ${r.detail}`);
        break;
      case "ethics":
        lines.push(`your ethics preferences${fromProfile("ethicsFlags")} (${(criteria.ethicsFlags ?? []).join(", ")}): ${r.detail}`);
        break;
      case "flagged_merchant":
        lines.push(`⚠ ${r.detail}`);
        break;
      case "sponsored_deprioritization":
        break; // carried by the sponsored badge, not whyThis
    }
  }
  // Defensive floor: reasons[] is non-empty by protocol, but if every reason
  // was badge-only (a shape this client's own ranking never produces), fall
  // back to the verbatim reasons rather than an empty — schema-invalid —
  // whyThis that would fail the whole search.
  if (lines.length === 0) {
    return reasons.map((r) => `${r.criterion}: ${r.detail}`);
  }
  return lines;
}

const TRUST_ORDER: Record<string, number> = { trusted: 3, known: 2, unknown: 1, flagged: 0 };

function mustHaveMatches(result: RankedResult, mustHaves: string[]): number {
  const haystack = `${result.offer.product.title} ${Object.entries(result.offer.product.attributes)
    .flat()
    .join(" ")}`.toLowerCase();
  return mustHaves.filter((a) => haystack.includes(a.toLowerCase())).length;
}

/**
 * Computed deltas of ONE finalist vs the OTHER finalists, on the four brief
 * dimensions (price / delivery / trust / spec). A tradeoff is emitted only
 * when an actual difference exists — equal finalists produce no line.
 */
export function computeTradeoffs(
  self: RankedResult,
  finalists: RankedResult[],
  criteria: SearchQuery,
  trustSignals?: Record<string, TrustSignal> | undefined,
): Tradeoff[] {
  if (finalists.length < 2) return [];
  const out: Tradeoff[] = [];

  // --- price: vs the cheapest same-currency finalist ---
  const currencyGroup = finalists.filter((f) => f.offer.price.currency === self.offer.price.currency);
  if (currencyGroup.length >= 2) {
    const min = Math.min(...currencyGroup.map((f) => f.offer.price.amount));
    const max = Math.max(...currencyGroup.map((f) => f.offer.price.amount));
    if (self.offer.price.amount === min && max > min) {
      out.push({ dimension: "price", detail: `cheapest finalist at ${formatMoney(self.offer.price)}` });
    } else if (self.offer.price.amount > min) {
      out.push({
        dimension: "price",
        detail: `${formatMoney({ amount: self.offer.price.amount - min, currency: self.offer.price.currency })} more than the cheapest finalist (${formatMoney({ amount: min, currency: self.offer.price.currency })})`,
      });
    }
  }

  // --- delivery: vs the earliest promised delivery among finalists ---
  const dated = finalists.filter((f) => f.offer.shipping?.deliveryBy !== undefined);
  const selfDate = self.offer.shipping?.deliveryBy;
  if (selfDate !== undefined && dated.length >= 2) {
    const earliest = dated.map((f) => f.offer.shipping!.deliveryBy!).sort()[0]!;
    if (selfDate === earliest && dated.some((f) => f.offer.shipping!.deliveryBy! > earliest)) {
      out.push({ dimension: "delivery", detail: `earliest promised delivery (${selfDate})` });
    } else if (selfDate > earliest) {
      const days = Math.round((Date.parse(selfDate) - Date.parse(earliest)) / 86_400_000);
      out.push({
        dimension: "delivery",
        detail: `promised delivery ${selfDate}, ${days} day(s) after the earliest finalist (${earliest})`,
      });
    }
  } else if (selfDate === undefined && dated.length > 0) {
    out.push({
      dimension: "delivery",
      detail: `no promised delivery date — ${dated.length} other finalist(s) promise one`,
    });
  }

  // --- trust: vs the best merchant trust level among finalists ---
  const levelOf = (f: RankedResult) => trustSignals?.[trustKey(f.offer.merchant)]?.level;
  const withSignal = finalists.filter((f) => levelOf(f) !== undefined);
  const selfLevel = levelOf(self);
  if (selfLevel !== undefined && withSignal.length >= 2) {
    const best = Math.max(...withSignal.map((f) => TRUST_ORDER[levelOf(f)!]!));
    const selfRank = TRUST_ORDER[selfLevel]!;
    if (selfRank < best) {
      const bestLevel = withSignal
        .map((f) => levelOf(f)!)
        .sort((a, b) => TRUST_ORDER[b]! - TRUST_ORDER[a]!)[0]!;
      out.push({ dimension: "trust", detail: `merchant trust ${selfLevel} — below the best finalist (${bestLevel})` });
    } else if (selfRank === best && withSignal.some((f) => TRUST_ORDER[levelOf(f)!]! < best)) {
      out.push({ dimension: "trust", detail: `highest merchant trust among finalists (${selfLevel})` });
    }
  } else if (selfLevel === undefined && withSignal.length > 0) {
    out.push({
      dimension: "trust",
      detail: `no trust signal for this merchant — ${withSignal.length} other finalist(s) have one`,
    });
  }

  // --- spec: matched must-have fraction vs the best finalist ---
  const mustHaves = criteria.mustHaveAttributes ?? [];
  if (mustHaves.length > 0) {
    const selfMatched = mustHaveMatches(self, mustHaves);
    const best = Math.max(...finalists.map((f) => mustHaveMatches(f, mustHaves)));
    if (selfMatched < best) {
      out.push({
        dimension: "spec",
        detail: `matches ${selfMatched}/${mustHaves.length} must-haves — the best finalist matches ${best}/${mustHaves.length}`,
      });
    }
  }

  return out;
}

/** Honest coverage: one entry per registered store, from the service's own statuses. */
export function coverageFromStatuses(storeStatuses: StoreStatus[]): CoverageEntry[] {
  return storeStatuses.map((s) =>
    s.ok
      ? {
          store: s.store,
          status: "searched" as const,
          offerCount: s.offerCount,
          ...(s.sourceStatuses?.some((source) => !source.ok)
            ? { detail: `partial: ${s.sourceStatuses.filter((source) => !source.ok).length} configured source failed` }
            : {}),
        }
      : {
          store: s.store,
          status:
            s.error.code === "blocked"
              ? ("blocked" as const)
              : s.error.code === "not_configured"
                ? ("not_configured" as const)
                : ("error" as const),
          offerCount: 0,
          detail: `${s.error.code}: ${s.error.message}`,
        },
  );
}

function provenanceFor(
  result: RankedResult,
  trust: TrustSignal | undefined,
): Record<string, ProvenanceCell> {
  const offer = result.offer;
  const offerCell: ProvenanceCell = {
    source: offer.product.url,
    ...(offer.fetchedAt !== undefined ? { fetchedAt: offer.fetchedAt } : {}),
  };
  return {
    title: offerCell,
    price: offerCell,
    availability: offerCell,
    ...(offer.shipping?.deliveryBy !== undefined ? { delivery: offerCell } : {}),
    ...(trust !== undefined
      ? { trust: { source: `trust-signal:${trust.evidence[0]?.source ?? "unrecorded"}` } }
      : {}),
  };
}

/**
 * Overflow (past the finalist cap) elimination wording — must be numerically
 * TRUE (this is the honesty artifact):
 *  - a sponsored offer can carry a HIGHER criteria score than the last
 *    finalist and still rank below the whole organic tier; its exclusion is
 *    the sponsored de-prioritization, cited verbatim from its own reason —
 *    never a false "score below" claim;
 *  - a score TIE at the cap is cut by the deterministic tie-break and says
 *    so; "below" wording is reserved for strictly lower scores.
 */
function overflowElimination(result: RankedResult, lowestFinalistScore: number): string {
  if (result.offer.acquisition?.placement === "unknown") {
    return "placement not confirmed: treated like sponsored and ranked below confirmed organic offers";
  }
  const sponsoredReason = result.reasons.find((r) => r.criterion === "sponsored_deprioritization");
  if (sponsoredReason !== undefined) return sponsoredReason.detail;
  if (result.score < lowestFinalistScore) {
    return `outranked on your criteria: score ${result.score.toFixed(2)} below the last finalist (${lowestFinalistScore.toFixed(2)})`;
  }
  return `outranked on your criteria: tied with the last finalist (score ${result.score.toFixed(2)}) and ranked below on the deterministic tie-break (price, then store-scoped offer tuple)`;
}

const NEUTRAL_DOWNSIDE = "No decisive downside established from current evidence.";

function firstUnique(values: readonly string[], max: number): string[] {
  return [...new Set(values)].slice(0, max);
}

function gapDescription(gap: string): string {
  const descriptions: Record<string, string> = {
    "product.identity": "Exact product identity still needs confirmation.",
    "product.primary-facts": "Primary product facts still need confirmation.",
    "seller.identity": "Seller identity still needs confirmation.",
    "seller.policies": "Seller policies still need confirmation.",
  };
  return descriptions[gap] ?? `Research still needed: ${gap}`;
}

function latestTimestamp(values: readonly (string | undefined)[]): { status: "known"; observedAt: string } | { status: "unknown" } {
  const valid = values.filter((value): value is string => value !== undefined && Number.isFinite(Date.parse(value)));
  if (valid.length === 0) return { status: "unknown" };
  return { status: "known", observedAt: valid.reduce((latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest)) };
}

function effectiveEvidence(result: RankedResult, evidence: Map<string, CandidateDecisionEvidence>) {
  const candidate = evidence.get(decisionOfferKey(result.offer.sourceStore, result.offer.id));
  const offer = result.offer;
  return {
    candidate,
    productIdentity: candidate?.productIdentity ?? offer.product.identity,
    landedCost: candidate?.landedCost ?? offer.landedCost,
    returnPolicy: candidate?.returnPolicy ?? offer.returnPolicy,
    warranty: candidate?.warranty ?? offer.warranty,
  };
}

function readinessFor(result: RankedResult, decisionReadiness: DecisionReadiness | undefined) {
  return decisionReadiness?.offers.find(
    (readiness) => readiness.offerKey === decisionOfferKey(result.offer.sourceStore, result.offer.id),
  );
}

function sellerState(result: RankedResult, trustSignals: Record<string, TrustSignal> | undefined) {
  return trustSignals?.[trustKey(result.offer.merchant)]?.level ?? "unknown";
}

function verificationState(result: RankedResult): "agent_observed" | "merchant_verified" {
  return result.offer.acquisition?.kind === "agent_observed" ? "agent_observed" : "merchant_verified";
}

function importantUnknowns(
  readiness: ReturnType<typeof readinessFor>,
  hasProductIdentity: boolean,
  hasLandedCost: boolean,
): string[] {
  const missingFacts = [
    ...(hasProductIdentity ? [] : ["Exact product identity is not confirmed."]),
    ...(hasLandedCost ? [] : ["Landed cost is not confirmed."]),
  ];
  if (readiness === undefined) return firstUnique([...missingFacts, "Research readiness is unknown."], 12);
  return firstUnique([...missingFacts, ...readiness.unknowns, ...readiness.gaps.map(gapDescription)], 12);
}

function decisiveDownside(
  result: RankedResult,
  state: string,
  verification: "agent_observed" | "merchant_verified",
  readiness: ReturnType<typeof readinessFor>,
  landedCost: ReturnType<typeof effectiveEvidence>["landedCost"],
  tradeoffs: Tradeoff[],
): string {
  if (result.offer.sponsored || result.offer.acquisition?.placement === "unknown") {
    return "Paid or unknown placement requires extra caution.";
  }
  if (verification === "agent_observed") return "Agent-observed facts require native revalidation.";
  if (state === "flagged") return "Seller trust is flagged.";
  if (state === "unknown") return "Seller trust is unknown.";
  if (readiness?.conflicts[0] !== undefined) return readiness.conflicts[0];
  if (readiness?.unknowns[0] !== undefined) return readiness.unknowns[0];
  if (landedCost === undefined) return "Landed cost is not confirmed.";
  if (landedCost.completeness === "partial") return "Landed cost is incomplete.";
  if (result.offer.shipping?.deliveryBy === undefined) return "Promised delivery is not stated.";
  const adverse = tradeoffs.find((tradeoff) => /(?:more than|after the earliest|no promised|lower merchant|missing)/i.test(tradeoff.detail));
  return adverse?.detail ?? NEUTRAL_DOWNSIDE;
}

type RoleProjection = {
  role: "top_fit" | "lower_risk" | "budget_or_different";
  sourceStore: string;
  offerId: string;
  roleReason: string;
};

type RoleCandidate = {
  finalist: BriefFinalist;
  risk: readonly number[];
};

function compareRisk(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function materialDifference(top: BriefFinalist, candidate: BriefFinalist): boolean {
  return (
    top.verificationState !== candidate.verificationState ||
    top.sellerState !== candidate.sellerState ||
    top.sourceStore !== candidate.sourceStore ||
    top.productIdentity?.canonical !== candidate.productIdentity?.canonical ||
    top.productIdentity?.variant !== candidate.productIdentity?.variant ||
    top.deliveryBy !== candidate.deliveryBy ||
    top.price.amount !== candidate.price.amount ||
    top.price.currency !== candidate.price.currency
  );
}

function decisionSummary(finalists: BriefFinalist[], readiness: DecisionReadiness | undefined): RoleProjection[] {
  const top = finalists[0];
  if (top === undefined) return [];
  const candidates: RoleCandidate[] = finalists.map((finalist) => {
    const row = readiness?.offers.find((offer) => offer.offerKey === decisionOfferKey(finalist.sourceStore, finalist.offerId));
    const placementRisk = finalist.sponsored || finalist.acquisition?.placement === "unknown" ? 1 : 0;
    const verificationRisk = finalist.verificationState === "merchant_verified" ? 0 : 1;
    const sellerRisk: Record<BriefFinalist["sellerState"], number> = { trusted: 0, known: 1, unknown: 2, flagged: 3 };
    const decisionRisk: Record<BriefFinalist["decisionStatus"], number> = { ready: 0, provisional: 1, eliminated: 2 };
    const evidenceGaps = row === undefined ? 1 : row.gaps.length + row.totalConflictCount + row.totalUnknownCount;
    return { finalist, risk: [placementRisk, verificationRisk, sellerRisk[finalist.sellerState], decisionRisk[finalist.decisionStatus], evidenceGaps, finalist.rank] };
  });
  const topCandidate = candidates[0]!;
  const summary: RoleProjection[] = [{ role: "top_fit", sourceStore: top.sourceStore, offerId: top.offerId, roleReason: "First qualifying finalist in the neutrality ranking." }];
  const safer = candidates.slice(1).filter((candidate) => compareRisk(candidate.risk, topCandidate.risk) < 0).sort((left, right) => compareRisk(left.risk, right.risk))[0];
  if (safer !== undefined) {
    summary.push({ role: "lower_risk", sourceStore: safer.finalist.sourceStore, offerId: safer.finalist.offerId, roleReason: "Has a lower evidence-risk tuple than the top fit." });
  }
  const used = new Set(summary.map((entry) => decisionOfferKey(entry.sourceStore, entry.offerId)));
  const remaining = finalists.filter((finalist) => !used.has(decisionOfferKey(finalist.sourceStore, finalist.offerId)));
  const cheaper = remaining
    .filter((finalist) => finalist.price.currency === top.price.currency && finalist.price.amount < top.price.amount)
    .sort((left, right) => left.price.amount - right.price.amount || left.rank - right.rank)[0];
  const different = cheaper ?? remaining.find((finalist) => materialDifference(top, finalist));
  if (different !== undefined) {
    summary.push({
      role: "budget_or_different",
      sourceStore: different.sourceStore,
      offerId: different.offerId,
      roleReason: cheaper === undefined ? "A distinct remaining finalist for comparison." : "Cheaper same-currency remaining finalist.",
    });
  }
  return summary;
}

function unresolvedQuestions(summary: RoleProjection[], finalists: BriefFinalist[], readiness: DecisionReadiness | undefined): string[] {
  const questions: string[] = [];
  for (const entry of summary) {
    const finalist = finalists.find((row) => row.sourceStore === entry.sourceStore && row.offerId === entry.offerId);
    if (finalist === undefined) continue;
    const row = readiness?.offers.find((offer) => offer.offerKey === decisionOfferKey(finalist.sourceStore, finalist.offerId));
    for (const gap of row?.gaps ?? []) questions.push(`For ${finalist.title}: resolve ${gap}.`);
    for (const conflict of row?.conflicts ?? []) questions.push(`For ${finalist.title}: resolve conflicting evidence: ${conflict}`);
    for (const unknown of row?.unknowns ?? []) questions.push(`For ${finalist.title}: clarify ${unknown}`);
    for (const checklist of row?.remainingChecklistItemIds ?? []) questions.push(`For ${finalist.title}: complete ${checklist}.`);
    if (row === undefined) questions.push(`For ${finalist.title}: establish current research readiness.`);
  }
  return firstUnique(questions, 12);
}

export function composeBuyersBrief(input: BuyersBriefInput): BuyersBrief {
  const { searchId, results, interpretedQuery, storeStatuses, trustSignals, decisionReadiness } = input;
  const criteria = interpretedQuery.criteria;
  const evidence = new Map((input.evidence ?? []).map((candidate) => [decisionOfferKey(candidate.sourceStore, candidate.offerId), candidate]));

  const qualified: RankedResult[] = [];
  const rejected: RejectedOffer[] = [];
  const overflow: RankedResult[] = [];

  for (const result of results) {
    const eliminated = eliminatingCriteria(result);
    if (eliminated.length > 0) {
      rejected.push({
        offerId: result.offer.id,
        sourceStore: result.offer.sourceStore,
        title: result.offer.product.title,
        eliminatedBy: eliminated,
      });
    } else if (qualified.length < MAX_FINALISTS) {
      qualified.push(result); // ranking order preserved — the brief never re-ranks
    } else {
      overflow.push(result);
    }
  }

  const lowestFinalistScore = qualified.length > 0 ? qualified[qualified.length - 1]!.score : 0;
  for (const result of overflow) {
    rejected.push({
      offerId: result.offer.id,
      sourceStore: result.offer.sourceStore,
      title: result.offer.product.title,
      eliminatedBy: [overflowElimination(result, lowestFinalistScore)],
    });
  }

  const finalists: BriefFinalist[] = qualified.map((result, i) => {
    const offer = result.offer;
    const trust = trustSignals?.[trustKey(offer.merchant)];
    const effective = effectiveEvidence(result, evidence);
    const readiness = readinessFor(result, decisionReadiness);
    const state = sellerState(result, trustSignals);
    const verification = verificationState(result);
    const tradeoffs = computeTradeoffs(result, qualified, criteria, trustSignals);
    return {
      rank: i + 1,
      offerId: offer.id,
      sourceStore: offer.sourceStore,
      title: offer.product.title,
      url: offer.product.url,
      ...(offer.product.imageUrl !== undefined ? { imageUrl: offer.product.imageUrl } : {}),
      merchant: { id: offer.merchant.id, name: offer.merchant.name },
      price: offer.price,
      availability: offer.availability,
      ...(offer.shipping?.deliveryBy !== undefined ? { deliveryBy: offer.shipping.deliveryBy } : {}),
      ...(trust !== undefined ? { trustLevel: trust.level } : {}),
      sponsored: offer.sponsored,
      ...(effective.productIdentity !== undefined ? { productIdentity: effective.productIdentity } : {}),
      ...(effective.landedCost !== undefined ? { landedCost: effective.landedCost } : {}),
      sellerState: state,
      freshness: latestTimestamp([
        offer.fetchedAt,
        offer.acquisition?.observedAt,
        effective.landedCost?.components.map((component) => component.observedAt).filter((value) => value !== undefined).sort().at(-1),
        effective.returnPolicy?.observedAt,
        effective.warranty?.observedAt,
        ...effective.candidate?.claims.map((claim) => claim.observedAt) ?? [],
      ]),
      verificationState: verification,
      decisionStatus: readiness?.status ?? "provisional",
      importantUnknowns: importantUnknowns(readiness, effective.productIdentity !== undefined, effective.landedCost !== undefined),
      decisiveDownside: decisiveDownside(result, state, verification, readiness, effective.landedCost, tradeoffs),
      rawReasons: result.reasons.slice(0, 50),
      ...(offer.acquisition !== undefined ? { acquisition: offer.acquisition } : {}),
      whyThis: whyThisLines(result.reasons, criteria, interpretedQuery.appliedProfileEntries),
      tradeoffs,
      provenance: provenanceFor(result, trust),
    };
  });

  // Parse on the way out: construction-guaranteed invariants (≤5 finalists,
  // non-empty whyThis, coverage vocabulary) hold for every composed brief.
  const summary = decisionSummary(finalists, decisionReadiness);
  return BuyersBriefSchema.parse({
    searchId,
    query: criteria,
    finalists,
    rejected,
    coverage: coverageFromStatuses(storeStatuses),
    offersConsidered: results.length,
    decisionSummary: summary,
    unresolvedResearchQuestions: unresolvedQuestions(summary, finalists, decisionReadiness),
  });
}
