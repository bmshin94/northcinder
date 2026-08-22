import {
  DecisionReadinessSchema,
  RANK_ELIMINATION_CODES,
  decisionOfferKey,
  type CandidateDecisionEvidence,
  type DecisionReadiness,
  type EvidenceConflict,
  type InterpretedQuery,
  type RankedResult,
  type ResearchChecklistReceipt,
  type SourcedClaim,
} from "@northcinder/protocol";

const LEGACY_ELIMINATION_CODES = new Set<string>(Object.values(RANK_ELIMINATION_CODES));

function offerKey(result: RankedResult): string {
  return decisionOfferKey(result.offer.sourceStore, result.offer.id);
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isEliminated(result: RankedResult): boolean {
  return result.reasons.some(
    (reason) =>
      reason.criterion === "flagged_merchant" ||
      (reason.code !== undefined &&
        (LEGACY_ELIMINATION_CODES.has(reason.code) || reason.importance === "required")),
  );
}

function exactClaimSatisfiesLane(
  claim: SourcedClaim,
  lane: "product" | "seller",
  productSubjectIdentity?: string,
): boolean {
  return (
    claim.lane === lane &&
    (lane !== "product" || claim.subjectIdentity === productSubjectIdentity) &&
    claim.sourceRelationship !== "commercial" &&
    claim.sourceUse !== "commercial_claim" &&
    claim.sourceUse !== "context_only"
  );
}

function conflictDescription(conflict: EvidenceConflict): string {
  return typeof conflict === "string" ? conflict : conflict.description;
}

function receiptGaps(
  lane: "product" | "seller",
  receipt: ResearchChecklistReceipt | undefined,
  requiredIds: readonly string[],
): { gaps: string[]; remaining: string[] } {
  if (receipt === undefined) {
    return { gaps: [`missing_${lane}_receipt`], remaining: [...requiredIds] };
  }
  const considered = new Set(receipt.checklistItemIds);
  const missing = requiredIds.filter((id) => !considered.has(id));
  const remaining = stableUnique([...missing, ...receipt.openChecklistItemIds]);
  const gaps: string[] = [];
  if (missing.length > 0) gaps.push(`${lane}_checklist_incomplete`);
  if (receipt.openChecklistItemIds.length > 0) gaps.push(`${lane}_checklist_open`);
  if (receipt.provisional) gaps.push(`${lane}_research_provisional`);
  return { gaps, remaining };
}

function hasCompleteLandedCost(result: RankedResult, evidence: CandidateDecisionEvidence | undefined): boolean {
  const landedCost = evidence?.landedCost ?? result.offer.landedCost;
  if (landedCost === undefined || landedCost.completeness !== "complete" || landedCost.unknownComponents.length > 0) {
    return false;
  }
  const itemPrices = landedCost.components.filter((component) => component.kind === "item_price");
  return (
    itemPrices.length === 1 &&
    itemPrices[0]!.amount.amount === result.offer.price.amount &&
    itemPrices[0]!.amount.currency === result.offer.price.currency
  );
}

function assessQualifyingOffer(input: {
  result: RankedResult;
  evidence: CandidateDecisionEvidence | undefined;
  productChecklistIds: readonly string[];
  sellerChecklistIds: readonly string[];
  candidateSetThin: boolean;
}) {
  const { result, evidence, productChecklistIds, sellerChecklistIds, candidateSetThin } = input;
  const claims = evidence?.claims ?? [];
  const allConflicts = stableUnique(claims.flatMap((claim) => claim.conflicts.map(conflictDescription)));
  const allUnknowns = stableUnique(claims.flatMap((claim) => claim.unknowns));
  const productReceipt = receiptGaps("product", evidence?.productReceipt, productChecklistIds);
  const sellerReceipt = receiptGaps("seller", evidence?.sellerReceipt, sellerChecklistIds);
  const gaps: string[] = [];
  const effectiveProductIdentity = evidence?.productIdentity ?? result.offer.product.identity;
  const productIdentityMismatch =
    effectiveProductIdentity !== undefined &&
    claims.some(
      (claim) => claim.lane === "product" && claim.subjectIdentity !== effectiveProductIdentity.canonical,
    );

  if (candidateSetThin) gaps.push("candidate_set_thin");
  if (effectiveProductIdentity === undefined) gaps.push("missing_product_identity");
  if (productIdentityMismatch) gaps.push("product_identity_mismatch");
  if (evidence?.sellerIdentity === undefined) gaps.push("missing_seller_identity");
  if (!hasCompleteLandedCost(result, evidence)) gaps.push("landed_cost_incomplete");
  if ((evidence?.returnPolicy ?? result.offer.returnPolicy) === undefined) gaps.push("missing_return_policy");
  if ((evidence?.warranty ?? result.offer.warranty) === undefined) gaps.push("missing_warranty");
  if (!claims.some((claim) => exactClaimSatisfiesLane(claim, "product", effectiveProductIdentity?.canonical))) {
    gaps.push("missing_product_claim");
  }
  if (!claims.some((claim) => exactClaimSatisfiesLane(claim, "seller"))) gaps.push("missing_seller_claim");
  gaps.push(...productReceipt.gaps, ...sellerReceipt.gaps);
  if (allConflicts.length > 0) gaps.push("evidence_conflict");
  if (allUnknowns.length > 0) gaps.push("evidence_unknown");

  return {
    offerKey: offerKey(result),
    status: gaps.length === 0 ? "ready" as const : "provisional" as const,
    gaps: stableUnique(gaps),
    conflicts: allConflicts.slice(0, 16),
    totalConflictCount: allConflicts.length,
    conflictsTruncated: allConflicts.length > 16,
    unknowns: allUnknowns.slice(0, 16),
    totalUnknownCount: allUnknowns.length,
    unknownsTruncated: allUnknowns.length > 16,
    remainingChecklistItemIds: stableUnique([...productReceipt.remaining, ...sellerReceipt.remaining]),
  };
}

export function assessDecisionReadiness(input: {
  results: RankedResult[];
  evidence: readonly CandidateDecisionEvidence[];
  productChecklistIds: readonly string[];
  sellerChecklistIds: readonly string[];
}): DecisionReadiness {
  const results = [
    ...new Map(input.results.map((result) => [offerKey(result), result] as const)).values(),
  ];
  if (results.length === 0) {
    return DecisionReadinessSchema.parse({
      status: "insufficient",
      reasons: ["candidate_set_empty"],
      qualifyingOfferKeys: [],
      offers: [],
    });
  }

  const evidenceByOffer = new Map<string, CandidateDecisionEvidence>(
    input.evidence.map(
      (candidate) => [decisionOfferKey(candidate.sourceStore, candidate.offerId), candidate] as const,
    ),
  );
  const qualifying = results.filter((result) => !isEliminated(result));
  const candidateSetThin = qualifying.length === 1;
  const offers = results.map((result) => {
    if (isEliminated(result)) {
      return {
        offerKey: offerKey(result),
        status: "eliminated" as const,
        gaps: ["hard_requirement_eliminated"],
        conflicts: [],
        totalConflictCount: 0,
        conflictsTruncated: false,
        unknowns: [],
        totalUnknownCount: 0,
        unknownsTruncated: false,
        remainingChecklistItemIds: [],
      };
    }
    return assessQualifyingOffer({
      result,
      evidence: evidenceByOffer.get(offerKey(result)),
      productChecklistIds: input.productChecklistIds,
      sellerChecklistIds: input.sellerChecklistIds,
      candidateSetThin,
    });
  });
  const qualifyingOfferKeys = qualifying.map(offerKey);

  if (qualifying.length === 0) {
    return DecisionReadinessSchema.parse({
      status: "insufficient",
      reasons: ["no_qualifying_candidates"],
      qualifyingOfferKeys,
      offers,
    });
  }

  const top = offers.find((offer) => offer.offerKey === qualifyingOfferKeys[0])!;
  const ready = qualifying.length >= 2 && top.status === "ready";
  const reasons = ready
    ? []
    : stableUnique([
        ...(candidateSetThin ? ["candidate_set_thin"] : []),
        ...top.gaps.filter((gap) => gap !== "candidate_set_thin"),
      ]);
  return DecisionReadinessSchema.parse({
    status: ready ? "ready" : "provisional",
    reasons,
    qualifyingOfferKeys,
    offers,
  });
}

export function redactEphemeralBuyerContext(interpreted: InterpretedQuery): InterpretedQuery {
  const { buyerContext: _buyerContext, ...criteria } = interpreted.criteria;
  return {
    ...interpreted,
    criteria,
  };
}
