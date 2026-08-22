import { z } from "zod";
import {
  AvailabilitySchema,
  BuyersBriefSchema,
  DecisionCriterionSchema,
  ExactProductIdentitySchema,
  FreshnessSchema,
  LandedCostSchema,
  LandedCostComponentKindSchema,
  MoneySchema,
  TrustLevelSchema,
  decisionOfferKey,
  type BuyersBrief,
  type DecisionReadiness,
  type InterpretedQuery,
  type PurchaseOutcome,
} from "@northcinder/protocol";
import { forEachLineFromEnd } from "./bounded-tail-reader.js";

const DISPLAY_TEXT_MAX = 2_000;
const OFFER_REFERENCE_MAX = 500;
const MERCHANT_NAME_MAX = 200;
const DecisionTextSchema = z.string().min(1).max(DISPLAY_TEXT_MAX);
const DecisionIdentifierSchema = z.string().min(1).max(200);
const DecisionOfferReferenceSchema = z.string().min(1).max(OFFER_REFERENCE_MAX);
const DecisionMerchantIdentifierSchema = z.string().min(1).max(OFFER_REFERENCE_MAX);
const DecisionUrlSchema = z.string().url().max(DISPLAY_TEXT_MAX);
const DecisionProjectionWarningSchema = z.string().min(1).max(200);

const ProjectionWarning = {
  requestText: "Request text was shortened for the local Decisions display.",
  criteriaValue: "Criteria values were shortened for the local Decisions display.",
  criteriaEntries: "Some criteria values were omitted from the local Decisions display.",
  coverageStore: "Coverage store names were shortened for the local Decisions display.",
  coverageDetail: "Coverage details were shortened for the local Decisions display.",
  coverageEntries: "Some coverage entries were omitted from the local Decisions display.",
  candidateTitle: "Candidate titles were shortened for the local Decisions display.",
  candidateUrl: "Candidate product links were omitted because they exceeded the local Decisions display bound.",
  candidateImageUrl: "Candidate image links were omitted because they exceeded the local Decisions display bound.",
  merchantId: "Merchant identifiers were shortened for the local Decisions display.",
  merchantName: "Merchant names were shortened for the local Decisions display.",
  candidateText: "Candidate decision details were shortened for the local Decisions display.",
  candidateEntries: "Some candidate decision details were omitted from the local Decisions display.",
  tradeoffDetail: "Candidate tradeoff details were shortened for the local Decisions display.",
  profileEffect: "Some profile effects were shortened or omitted from the local decision record.",
} as const;

function boundedText(value: string, maximum: number, warning: string, warnings: Set<string>): string {
  if (value.length <= maximum) return value;
  warnings.add(warning);
  return `${value.slice(0, maximum - 1)}…`;
}

function boundedValues(
  values: readonly string[],
  maximumItems: number,
  maximumText: number,
  textWarning: string,
  entriesWarning: string,
  warnings: Set<string>,
): string[] {
  if (values.length > maximumItems) warnings.add(entriesWarning);
  return values.slice(0, maximumItems).map((value) => boundedText(value, maximumText, textWarning, warnings));
}

function boundedUrl(value: string | undefined, warning: string, warnings: Set<string>): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= DISPLAY_TEXT_MAX) return value;
  warnings.add(warning);
  return undefined;
}

/** Audit-safe subset of the live search query; buyerContext is intentionally absent. */
const BoundedCriteriaSchema = z
  .object({
    text: DecisionTextSchema,
    maxPrice: MoneySchema.optional(),
    mustHaveAttributes: z.array(z.string().min(1).max(500)).max(32).optional(),
    deliveryBy: z.iso.date().optional(),
    ethicsFlags: z.array(z.string().min(1).max(500)).max(16).optional(),
    maxResults: z.int().positive().max(100).optional(),
    criteria: z.array(DecisionCriterionSchema).max(16).optional(),
  })
  .strict();

const BoundedCoverageSchema = z
  .array(
    z
      .object({
        store: DecisionOfferReferenceSchema,
        status: z.enum(["searched", "blocked", "not_configured", "error"]),
        offerCount: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        detail: DecisionTextSchema.optional(),
      })
      .strict(),
  )
  .max(100);

const BoundedTradeoffSchema = z
  .object({
    dimension: z.enum(["price", "delivery", "trust", "spec"]),
    detail: DecisionTextSchema,
  })
  .strict();

const BoundedProfileEffectSchema = z
  .object({
    id: z.string().min(1).max(200),
    origin: z.enum(["stated", "inferred"]),
    kind: z.string().min(1).max(100),
    appliedTo: z.string().min(1).max(200),
    detail: DecisionTextSchema,
  })
  .strict();

const BoundedProfileEffectsSchema = z
  .object({
    applied: z.array(BoundedProfileEffectSchema).max(64),
    overridden: z.array(BoundedProfileEffectSchema.extend({ overriddenBy: DecisionTextSchema })).max(64),
  })
  .strict();

const PersistedLandedCostSchema = z
  .object({
    knownTotal: MoneySchema,
    unknownComponents: z.array(LandedCostComponentKindSchema).max(5),
    completeness: z.enum(["complete", "partial"]),
  })
  .strict();

const PersistedDecisionCandidateSchema = z
  .object({
    role: z.enum(["top_fit", "lower_risk", "budget_or_different"]),
    roleReason: z.string().trim().min(1).max(2_000),
    rank: z.int().positive(),
    sourceStore: DecisionOfferReferenceSchema,
    offerId: DecisionOfferReferenceSchema,
    title: DecisionTextSchema,
    url: DecisionUrlSchema.optional(),
    imageUrl: DecisionUrlSchema.optional(),
    productIdentity: ExactProductIdentitySchema.optional(),
    merchant: z.object({
      id: DecisionMerchantIdentifierSchema,
      name: z.string().min(1).max(MERCHANT_NAME_MAX),
    }).strict(),
    price: MoneySchema,
    availability: AvailabilitySchema,
    deliveryBy: z.iso.date().optional(),
    trustLevel: TrustLevelSchema.optional(),
    sponsored: z.boolean(),
    landedCost: z.union([PersistedLandedCostSchema, LandedCostSchema]).optional(),
    sellerState: TrustLevelSchema,
    freshness: FreshnessSchema,
    verificationState: z.enum(["agent_observed", "merchant_verified"]),
    decisionStatus: z.enum(["eliminated", "provisional", "ready"]),
    importantUnknowns: z.array(DecisionTextSchema).max(12),
    decisiveDownside: DecisionTextSchema,
    whyThis: z.array(DecisionTextSchema).min(1).max(50),
    tradeoffs: z.array(BoundedTradeoffSchema).max(20),
  })
  .strict();

export const PersistedDecisionStateSchema = z
  .object({
    searchId: DecisionIdentifierSchema,
    request: DecisionTextSchema,
    criteria: BoundedCriteriaSchema,
    candidates: z.array(PersistedDecisionCandidateSchema).max(3),
    coverage: BoundedCoverageSchema,
    unresolvedResearchQuestions: BuyersBriefSchema.shape.unresolvedResearchQuestions,
    readiness: z.object({
      status: z.enum(["insufficient", "provisional", "ready"]),
      reasons: z.array(z.string().trim().min(1).max(100)).max(50),
    }).strict(),
    projectionWarnings: z.array(DecisionProjectionWarningSchema).max(20).default([]),
    chosenOffer: z.object({
      sourceStore: DecisionOfferReferenceSchema,
      offerId: DecisionOfferReferenceSchema,
    }).strict().nullable(),
    outcome: z.enum(["kept", "returned", "cancelled", "failed"]).nullable(),
    profileEffects: BoundedProfileEffectsSchema.default({ applied: [], overridden: [] }),
  })
  .strict();

export type PersistedDecisionState = z.infer<typeof PersistedDecisionStateSchema>;

/**
 * Redacts a live brief into the small, display-only restart seam. It deliberately
 * projects role-selected finalists instead of carrying the brief's rejected rows,
 * raw ranking reasons, provenance, acquisition data, or submitted claim corpus.
 */
export function projectDecisionState(input: {
  brief: BuyersBrief;
  decisionReadiness: DecisionReadiness;
  interpreted?: InterpretedQuery;
  chosenOffer?: { sourceStore: string; offerId: string } | null;
  outcome?: "kept" | "returned" | "cancelled" | "failed" | null;
}): PersistedDecisionState {
  const warnings = new Set<string>();
  const { buyerContext: _buyerContext, ...criteria } = input.brief.query;
  const boundedCriteria = {
    ...criteria,
    text: boundedText(criteria.text, DISPLAY_TEXT_MAX, ProjectionWarning.requestText, warnings),
    ...(criteria.mustHaveAttributes !== undefined
      ? {
          mustHaveAttributes: boundedValues(
            criteria.mustHaveAttributes,
            32,
            500,
            ProjectionWarning.criteriaValue,
            ProjectionWarning.criteriaEntries,
            warnings,
          ),
        }
      : {}),
    ...(criteria.ethicsFlags !== undefined
      ? {
          ethicsFlags: boundedValues(
            criteria.ethicsFlags,
            16,
            500,
            ProjectionWarning.criteriaValue,
            ProjectionWarning.criteriaEntries,
            warnings,
          ),
        }
      : {}),
  };
  const finalistsByOffer = new Map(
    input.brief.finalists.map((finalist) => [decisionOfferKey(finalist.sourceStore, finalist.offerId), finalist] as const),
  );
  const candidates = input.brief.decisionSummary.flatMap((summary) => {
    const finalist = finalistsByOffer.get(decisionOfferKey(summary.sourceStore, summary.offerId));
    if (finalist === undefined) return [];
    const url = boundedUrl(finalist.url, ProjectionWarning.candidateUrl, warnings);
    const imageUrl = boundedUrl(finalist.imageUrl, ProjectionWarning.candidateImageUrl, warnings);
    if (finalist.tradeoffs.length > 20) warnings.add(ProjectionWarning.candidateEntries);
    return [{
      role: summary.role,
      roleReason: boundedText(summary.roleReason, DISPLAY_TEXT_MAX, ProjectionWarning.candidateText, warnings),
      rank: finalist.rank,
      sourceStore: finalist.sourceStore,
      offerId: finalist.offerId,
      title: boundedText(finalist.title, DISPLAY_TEXT_MAX, ProjectionWarning.candidateTitle, warnings),
      ...(url !== undefined ? { url } : {}),
      ...(imageUrl !== undefined ? { imageUrl } : {}),
      ...(finalist.productIdentity !== undefined ? { productIdentity: finalist.productIdentity } : {}),
      merchant: {
        id: boundedText(finalist.merchant.id, OFFER_REFERENCE_MAX, ProjectionWarning.merchantId, warnings),
        name: boundedText(finalist.merchant.name, MERCHANT_NAME_MAX, ProjectionWarning.merchantName, warnings),
      },
      price: finalist.price,
      availability: finalist.availability,
      ...(finalist.deliveryBy !== undefined ? { deliveryBy: finalist.deliveryBy } : {}),
      ...(finalist.trustLevel !== undefined ? { trustLevel: finalist.trustLevel } : {}),
      sponsored: finalist.sponsored,
      ...(finalist.landedCost !== undefined
        ? {
            landedCost: {
              knownTotal: finalist.landedCost.knownTotal,
              unknownComponents: finalist.landedCost.unknownComponents,
              completeness: finalist.landedCost.completeness,
            },
          }
        : {}),
      sellerState: finalist.sellerState,
      freshness: finalist.freshness,
      verificationState: finalist.verificationState,
      decisionStatus: finalist.decisionStatus,
      importantUnknowns: boundedValues(
        finalist.importantUnknowns,
        12,
        DISPLAY_TEXT_MAX,
        ProjectionWarning.candidateText,
        ProjectionWarning.candidateEntries,
        warnings,
      ),
      decisiveDownside: boundedText(
        finalist.decisiveDownside,
        DISPLAY_TEXT_MAX,
        ProjectionWarning.candidateText,
        warnings,
      ),
      whyThis: boundedValues(
        finalist.whyThis,
        50,
        DISPLAY_TEXT_MAX,
        ProjectionWarning.candidateText,
        ProjectionWarning.candidateEntries,
        warnings,
      ),
      tradeoffs: finalist.tradeoffs.slice(0, 20).map((tradeoff) => ({
        dimension: tradeoff.dimension,
        detail: boundedText(tradeoff.detail, DISPLAY_TEXT_MAX, ProjectionWarning.tradeoffDetail, warnings),
      })),
    }];
  });
  if (input.brief.coverage.length > 100) warnings.add(ProjectionWarning.coverageEntries);
  const coverage = input.brief.coverage.slice(0, 100).map((entry) => ({
    store: boundedText(entry.store, OFFER_REFERENCE_MAX, ProjectionWarning.coverageStore, warnings),
    status: entry.status,
    offerCount: entry.offerCount,
    ...(entry.detail !== undefined
      ? { detail: boundedText(entry.detail, DISPLAY_TEXT_MAX, ProjectionWarning.coverageDetail, warnings) }
      : {}),
  }));
  if (
    (input.interpreted?.appliedProfileEntries.length ?? 0) > 64 ||
    (input.interpreted?.overriddenProfileEntries.length ?? 0) > 64
  ) {
    warnings.add(ProjectionWarning.profileEffect);
  }
  const profileEffects = {
    applied: (input.interpreted?.appliedProfileEntries ?? []).slice(0, 64).map((entry) => ({
      id: boundedText(entry.id, 200, ProjectionWarning.profileEffect, warnings),
      origin: entry.origin,
      kind: boundedText(entry.kind, 100, ProjectionWarning.profileEffect, warnings),
      appliedTo: boundedText(entry.appliedTo, 200, ProjectionWarning.profileEffect, warnings),
      detail: boundedText(entry.detail, DISPLAY_TEXT_MAX, ProjectionWarning.profileEffect, warnings),
    })),
    overridden: (input.interpreted?.overriddenProfileEntries ?? []).slice(0, 64).map((entry) => ({
      id: boundedText(entry.id, 200, ProjectionWarning.profileEffect, warnings),
      origin: entry.origin,
      kind: boundedText(entry.kind, 100, ProjectionWarning.profileEffect, warnings),
      appliedTo: boundedText(entry.appliedTo, 200, ProjectionWarning.profileEffect, warnings),
      detail: boundedText(entry.detail, DISPLAY_TEXT_MAX, ProjectionWarning.profileEffect, warnings),
      overriddenBy: boundedText(entry.overriddenBy, DISPLAY_TEXT_MAX, ProjectionWarning.profileEffect, warnings),
    })),
  };
  return PersistedDecisionStateSchema.parse({
    searchId: input.brief.searchId,
    request: boundedText(input.brief.query.text, DISPLAY_TEXT_MAX, ProjectionWarning.requestText, warnings),
    criteria: boundedCriteria,
    candidates,
    coverage,
    unresolvedResearchQuestions: input.brief.unresolvedResearchQuestions,
    readiness: {
      status: input.decisionReadiness.status,
      reasons: input.decisionReadiness.reasons,
    },
    projectionWarnings: [...warnings],
    chosenOffer: input.chosenOffer ?? null,
    outcome: input.outcome ?? null,
    profileEffects,
  });
}

/** Preserves the bounded decision record and changes only its confirmed lifecycle outcome. */
export function withDecisionOutcome(state: PersistedDecisionState, outcome: PurchaseOutcome): PersistedDecisionState {
  return PersistedDecisionStateSchema.parse({ ...state, outcome: outcome.state });
}

/** Reads the restart-safe state embedded in existing audit events, newest first. */
export function readDecisionStates(
  auditPath: string,
  options: { limit?: number; chunkSize?: number } = {},
): { states: PersistedDecisionState[]; invalidRecords: number } {
  const requestedLimit = options.limit ?? 20;
  const limit = Math.min(50, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 20));
  const states: PersistedDecisionState[] = [];
  const handledSearchIds = new Set<string>();
  let invalidRecords = 0;
  forEachLineFromEnd(auditPath, (line) => {
    if (states.length >= limit) return false;
    if (line.trim().length === 0) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof event !== "object" || event === null || Array.isArray(event)) return;
    const record = event as Record<string, unknown>;
    if (!("decisionState" in record)) return;
    const statedSearchId = typeof record.searchId === "string"
      ? record.searchId
      : typeof record.decisionState === "object" && record.decisionState !== null && !Array.isArray(record.decisionState) && typeof (record.decisionState as Record<string, unknown>).searchId === "string"
        ? (record.decisionState as Record<string, unknown>).searchId as string
        : undefined;
    if (statedSearchId === undefined || handledSearchIds.has(statedSearchId)) return;
    handledSearchIds.add(statedSearchId);
    const parsed = PersistedDecisionStateSchema.safeParse(record.decisionState);
    if (!parsed.success || parsed.data.searchId !== statedSearchId) {
      invalidRecords += 1;
      return;
    }
    states.push(parsed.data);
  }, options.chunkSize);
  return { states, invalidRecords };
}
