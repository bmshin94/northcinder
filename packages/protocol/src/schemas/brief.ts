import { z } from "zod";
import {
  AgentObservedAcquisitionSchema,
  AvailabilitySchema,
  ExactProductIdentitySchema,
  LandedCostSchema,
  MoneySchema,
  RankReasonSchema,
  SearchQuerySchema,
  TrustLevelSchema,
} from "./core.js";

/**
 * The buyer's brief (buyer brief): a deterministic decision artifact composed by CODE
 * from ranked results — never model-generated (safety contract law). It answers, honestly:
 * which few offers are worth the buyer's attention (finalists), WHY each one
 * given the USER's criteria, what each finalist gives up vs the others
 * (tradeoffs), where every data cell came from (provenance), what was rejected
 * and by which criteria, and which registered stores actually answered
 * (coverage — silent skipping forbidden).
 */

/** Honest per-store coverage status. Derived from the service's StoreStatus. */
export const CoverageStatusSchema = z.enum(["searched", "blocked", "not_configured", "error"]);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

/**
 * One entry per REGISTERED store — successes, blocks, and misconfigurations
 * alike. A store that was skipped or failed appears here saying so; it is
 * never silently absent.
 */
export const CoverageEntrySchema = z.object({
  store: z.string().min(1),
  status: CoverageStatusSchema,
  /** Offers this store contributed (0 for any non-searched status). */
  offerCount: z.int().nonnegative(),
  /** The store's own error message, for non-searched statuses. */
  detail: z.string().min(1).optional(),
});
export type CoverageEntry = z.infer<typeof CoverageEntrySchema>;

/**
 * Provenance for one data cell of a finalist row: where the value came from
 * (the offer's source URL, or a trust-signal source) and when it was fetched
 * (the offer's `fetchedAt` stamp, when the store adapter recorded one).
 */
export const ProvenanceCellSchema = z.object({
  source: z.string().min(1),
  fetchedAt: z.iso.datetime().optional(),
});
export type ProvenanceCell = z.infer<typeof ProvenanceCellSchema>;

export const TradeoffDimensionSchema = z.enum(["price", "delivery", "trust", "spec"]);
export type TradeoffDimension = z.infer<typeof TradeoffDimensionSchema>;

/** A computed delta vs the OTHER finalists — never prose invented by a model. */
export const TradeoffSchema = z.object({
  dimension: TradeoffDimensionSchema,
  detail: z.string().min(1),
});
export type Tradeoff = z.infer<typeof TradeoffSchema>;

export const DecisionCandidateRoleSchema = z.enum(["top_fit", "lower_risk", "budget_or_different"]);
export type DecisionCandidateRole = z.infer<typeof DecisionCandidateRoleSchema>;

export const FreshnessSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("known"), observedAt: z.iso.datetime() }).strict(),
  z.object({ status: z.literal("unknown") }).strict(),
]);
export type Freshness = z.infer<typeof FreshnessSchema>;

const BriefDisplayTextSchema = z.string().trim().min(1).max(2_000);

export const BriefFinalistSchema = z.object({
  /** 1-based position, inherited verbatim from the neutrality ranking. */
  rank: z.int().positive(),
  offerId: z.string().min(1),
  sourceStore: z.string().min(1),
  title: z.string().min(1),
  /** Canonical product page URL (also the provenance source for offer cells). */
  url: z.url(),
  merchant: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  price: MoneySchema,
  availability: AvailabilitySchema,
  /** Promised delivery date, when the store states one. */
  deliveryBy: z.iso.date().optional(),
  /** Merchant trust level, when a trust signal was available. */
  trustLevel: TrustLevelSchema.optional(),
  /** Paid placement badge — always carried, never re-ranked upward. */
  sponsored: z.boolean(),
  /** Product image supplied by the source, when available. */
  imageUrl: z.url().optional(),
  /** Exact identity, where either a candidate submission or source supplied it. */
  productIdentity: ExactProductIdentitySchema.optional(),
  /** Effective candidate-submission cost before the offer's optional cost fact. */
  landedCost: LandedCostSchema.optional(),
  /** Explicit trust display state; no signal remains unknown rather than implied. */
  sellerState: TrustLevelSchema,
  /** Latest valid offer/evidence observation, or an explicit unknown. */
  freshness: FreshnessSchema,
  verificationState: z.enum(["agent_observed", "merchant_verified"]),
  decisionStatus: z.enum(["eliminated", "provisional", "ready"]),
  /** Bounded current readiness unknowns and stable gap descriptions. */
  importantUnknowns: z.array(BriefDisplayTextSchema).max(12),
  /** The single highest-priority downside supported by current evidence. */
  decisiveDownside: BriefDisplayTextSchema,
  /** Original ranking reasons, retained for structured expansion only. */
  rawReasons: z.array(RankReasonSchema).min(1).max(50),
  /** Browser-agent provenance when this row was reported rather than independently verified. */
  acquisition: AgentObservedAcquisitionSchema.optional(),
  /** Why THIS offer, phrased against the USER's criteria — derived deterministically from reasons[]. */
  whyThis: z.array(z.string().min(1)).min(1),
  /** Computed deltas vs the other finalists (price/delivery/trust/spec). */
  tradeoffs: z.array(TradeoffSchema),
  /** Per-cell provenance, keyed by cell name (title, price, availability, delivery, trust). */
  provenance: z.record(z.string(), ProvenanceCellSchema),
});
export type BriefFinalist = z.infer<typeof BriefFinalistSchema>;

/** Rejected appendix row: what was considered and which criteria eliminated it. */
export const RejectedOfferSchema = z.object({
  offerId: z.string().min(1),
  sourceStore: z.string().min(1),
  title: z.string().min(1),
  /** The eliminating criteria, verbatim-derived from the ranking reasons. */
  eliminatedBy: z.array(z.string().min(1)).min(1),
});
export type RejectedOffer = z.infer<typeof RejectedOfferSchema>;

export const BuyersBriefSchema = z.object({
  /** The search this brief was composed from (search_products searchId). */
  searchId: z.string().min(1),
  /** The exact post-merge criteria the ranking used (interpretedQuery.criteria). */
  query: SearchQuerySchema,
  /** ≤5 finalists, ranking order preserved. Fewer if fewer qualify — NEVER padded. */
  finalists: z.array(BriefFinalistSchema).max(5),
  /** Everything considered but not a finalist, with the eliminating criteria. */
  rejected: z.array(RejectedOfferSchema),
  /** One entry per registered store. Silent skipping forbidden. */
  coverage: z.array(CoverageEntrySchema),
  /** Total ranked offers the brief was composed from (finalists + rejected). */
  offersConsidered: z.int().nonnegative(),
  /** At most three role-labelled finalist references, never a re-ranking. */
  decisionSummary: z
    .array(
      z.object({
        role: DecisionCandidateRoleSchema,
        sourceStore: z.string().min(1),
        offerId: z.string().min(1),
        roleReason: BriefDisplayTextSchema,
      }),
    )
    .max(3),
  /** Bounded buyer-facing research prompts derived from current summary evidence. */
  unresolvedResearchQuestions: z
    .array(BriefDisplayTextSchema)
    .max(12)
    .refine((questions) => new Set(questions).size === questions.length, "research questions must be unique"),
}).superRefine((brief, context) => {
  const finalistKeys = new Set(brief.finalists.map((finalist) => JSON.stringify([finalist.sourceStore, finalist.offerId])));
  const roles = new Set<string>();
  const summaryOffers = new Set<string>();
  for (const [index, summary] of brief.decisionSummary.entries()) {
    const key = JSON.stringify([summary.sourceStore, summary.offerId]);
    if (!finalistKeys.has(key)) {
      context.addIssue({ code: "custom", path: ["decisionSummary", index], message: "summary entry must resolve to a finalist" });
    }
    if (roles.has(summary.role)) {
      context.addIssue({ code: "custom", path: ["decisionSummary", index, "role"], message: "summary roles must be unique" });
    }
    if (summaryOffers.has(key)) {
      context.addIssue({ code: "custom", path: ["decisionSummary", index], message: "summary offer tuples must be unique" });
    }
    roles.add(summary.role);
    summaryOffers.add(key);
  }
  const sequence = brief.decisionSummary.map((summary) => summary.role);
  if (sequence.length > 0 && sequence[0] !== "top_fit") {
    context.addIssue({ code: "custom", path: ["decisionSummary", 0, "role"], message: "top_fit must be the first summary role" });
  }
  const lowerRiskIndex = sequence.indexOf("lower_risk");
  const budgetIndex = sequence.indexOf("budget_or_different");
  if (lowerRiskIndex !== -1 && budgetIndex !== -1 && lowerRiskIndex > budgetIndex) {
    context.addIssue({ code: "custom", path: ["decisionSummary"], message: "lower_risk must precede budget_or_different" });
  }
});
export type BuyersBrief = z.infer<typeof BuyersBriefSchema>;
