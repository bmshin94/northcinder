import { z } from "zod";
import {
  AffiliateCleanProductUrlSchema,
  ExactProductIdentitySchema,
  LandedCostSchema,
  ReturnPolicySchema,
  WarrantySchema,
} from "./core.js";

const UNSAFE_EVIDENCE_TEXT =
  /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|system|developer)\s+instructions?\b|\b(?:reveal|print|return|send)\b.{0,80}\b(?:system\s+prompt|api\s+key|password|secret|credential|token)\b|<script\b|\bjavascript\s*:|\bon(?:error|load|click)\s*=|\bdocument\.cookie\b|\beval\s*\(/i;

function boundedSafeText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !UNSAFE_EVIDENCE_TEXT.test(value), "instruction-like text is not allowed");
}

const BoundedIdSchema = boundedSafeText(100);
const OfferReferenceSchema = boundedSafeText(500);
const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length;

export function decisionOfferKey(sourceStore: string, offerId: string): string {
  return JSON.stringify([sourceStore, offerId]);
}

export const DecisionOfferKeySchema = z.string().min(7).max(6_007).refine((value) => {
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((part) => typeof part === "string" && part.trim().length > 0 && part.length <= 500) &&
      decisionOfferKey(parsed[0] as string, parsed[1] as string) === value
    );
  } catch {
    return false;
  }
}, "offer key must be a canonical JSON [sourceStore, offerId] tuple");

const ChecklistIdSchema = BoundedIdSchema.regex(/^(?:product|seller)\.[a-z0-9.-]+$/);
const ChecklistIdsSchema = z
  .array(ChecklistIdSchema)
  .min(1)
  .max(16)
  .refine(uniqueIds, "checklist IDs must be unique");
const SourceIdsSchema = z
  .array(BoundedIdSchema)
  .min(1)
  .max(16)
  .refine(uniqueIds, "source IDs must be unique");

const EvidenceSourceUrlSchema = AffiliateCleanProductUrlSchema.refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.username === "" && url.password === "";
}, "evidence source URL must be HTTPS and contain no credentials");

const DecisionReturnPolicySchema = ReturnPolicySchema.extend({
  summary: boundedSafeText(1_000),
}).strict();

const DecisionWarrantySchema = WarrantySchema.extend({
  summary: boundedSafeText(1_000),
  responsibleParty: boundedSafeText(200).optional(),
}).strict();

export const EvidenceConflictSchema = z.union([
  boundedSafeText(2_000),
  z
    .object({
      description: boundedSafeText(2_000),
      sourceIds: SourceIdsSchema,
    })
    .strict(),
]);
export type EvidenceConflict = z.infer<typeof EvidenceConflictSchema>;

export const SourcedClaimSchema = z
  .object({
    lane: z.enum(["product", "seller"]),
    checklistIds: ChecklistIdsSchema,
    subjectIdentity: boundedSafeText(2_000),
    sellerIdentity: boundedSafeText(2_000).optional(),
    claim: boundedSafeText(2_000),
    sourceIds: SourceIdsSchema,
    sourceRelationship: z.enum(["primary", "independent", "owner", "commercial", "unknown"]),
    sourceUse: z.enum(["subject_evidence", "counterevidence", "commercial_claim", "context_only"]),
    sourceUrl: EvidenceSourceUrlSchema,
    sourceType: boundedSafeText(200),
    observedAt: z.iso.datetime(),
    confidence: z.enum(["high", "medium", "low", "unverified"]),
    conflicts: z.array(EvidenceConflictSchema).max(16),
    unknowns: z
      .array(boundedSafeText(2_000))
      .max(16)
      .refine(uniqueIds, "unknowns must be unique"),
  })
  .strict()
  .superRefine((claim, context) => {
    const prefix = `${claim.lane}.`;
    if (claim.checklistIds.some((id) => !id.startsWith(prefix))) {
      context.addIssue({
        code: "custom",
        path: ["checklistIds"],
        message: `${claim.lane} claims require ${prefix} checklist IDs`,
      });
    }
    if (claim.lane === "product" && claim.sellerIdentity !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["sellerIdentity"],
        message: "sellerIdentity is seller-lane only",
      });
    }
    if (claim.lane === "seller" && claim.sellerIdentity !== claim.subjectIdentity) {
      context.addIssue({
        code: "custom",
        path: ["sellerIdentity"],
        message: "seller claims require sellerIdentity to equal subjectIdentity",
      });
    }
    if (claim.sourceRelationship === "commercial" && claim.sourceUse !== "commercial_claim") {
      context.addIssue({
        code: "custom",
        path: ["sourceUse"],
        message: "commercial sources must remain commercial_claim",
      });
    }
  });
export type SourcedClaim = z.infer<typeof SourcedClaimSchema>;

export const ResearchChecklistReceiptSchema = z
  .object({
    checklistItemIds: ChecklistIdsSchema,
    openChecklistItemIds: z
      .array(ChecklistIdSchema)
      .max(16)
      .refine(uniqueIds, "open checklist IDs must be unique"),
    provisional: z.boolean(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const considered = new Set(receipt.checklistItemIds);
    if (receipt.openChecklistItemIds.some((id) => !considered.has(id))) {
      context.addIssue({
        code: "custom",
        path: ["openChecklistItemIds"],
        message: "open checklist IDs must be a subset of considered checklist IDs",
      });
    }
    if (!receipt.provisional && receipt.openChecklistItemIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["provisional"],
        message: "a completed receipt cannot retain open checklist IDs",
      });
    }
  });
export type ResearchChecklistReceipt = z.infer<typeof ResearchChecklistReceiptSchema>;

function receiptUsesPrefix(
  receipt: ResearchChecklistReceipt | undefined,
  prefix: "product." | "seller.",
): boolean {
  return (
    receipt === undefined ||
    [...receipt.checklistItemIds, ...receipt.openChecklistItemIds].every((id) => id.startsWith(prefix))
  );
}

export const CandidateDecisionEvidenceSchema = z
  .object({
    sourceStore: OfferReferenceSchema,
    offerId: OfferReferenceSchema,
    productIdentity: ExactProductIdentitySchema.optional(),
    sellerIdentity: boundedSafeText(2_000).optional(),
    landedCost: LandedCostSchema.optional(),
    returnPolicy: DecisionReturnPolicySchema.optional(),
    warranty: DecisionWarrantySchema.optional(),
    claims: z.array(SourcedClaimSchema).max(50),
    productReceipt: ResearchChecklistReceiptSchema.optional(),
    sellerReceipt: ResearchChecklistReceiptSchema.optional(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (!receiptUsesPrefix(candidate.productReceipt, "product.")) {
      context.addIssue({ code: "custom", path: ["productReceipt"], message: "product receipt IDs must use product.*" });
    }
    if (!receiptUsesPrefix(candidate.sellerReceipt, "seller.")) {
      context.addIssue({ code: "custom", path: ["sellerReceipt"], message: "seller receipt IDs must use seller.*" });
    }

    const productSubjects = new Set(
      candidate.claims.filter((claim) => claim.lane === "product").map((claim) => claim.subjectIdentity),
    );
    if (productSubjects.size > 1) {
      context.addIssue({
        code: "custom",
        path: ["claims"],
        message: "product claims in one candidate must share one exact subject identity",
      });
    }
    if (
      candidate.productIdentity !== undefined &&
      candidate.claims.some(
        (claim) => claim.lane === "product" && claim.subjectIdentity !== candidate.productIdentity!.canonical,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["claims"],
        message: "product claim subject must equal the candidate exact product identity",
      });
    }
    const sellerClaims = candidate.claims.filter((claim) => claim.lane === "seller");
    if (
      sellerClaims.length > 0 &&
      (candidate.sellerIdentity === undefined ||
        sellerClaims.some((claim) => claim.sellerIdentity !== candidate.sellerIdentity))
    ) {
      context.addIssue({
        code: "custom",
        path: ["sellerIdentity"],
        message: "candidate seller identity must exactly bind every seller claim",
      });
    }

    const sourceRelationships = new Map<string, string>();
    for (const claim of candidate.claims) {
      for (const sourceId of claim.sourceIds) {
        const relationship = sourceRelationships.get(sourceId);
        if (relationship !== undefined && relationship !== claim.sourceRelationship) {
          context.addIssue({
            code: "custom",
            path: ["claims"],
            message: `source ${sourceId} cannot cross relationship lanes`,
          });
          return;
        }
        sourceRelationships.set(sourceId, claim.sourceRelationship);
      }
    }
  });
export type CandidateDecisionEvidence = z.infer<typeof CandidateDecisionEvidenceSchema>;

export const DecisionEvidenceSubmissionSchema = z
  .array(CandidateDecisionEvidenceSchema)
  .min(1)
  .max(20)
  .refine(
    (candidates) =>
      new Set(candidates.map((candidate) => decisionOfferKey(candidate.sourceStore, candidate.offerId))).size ===
      candidates.length,
    "candidate evidence offer keys must be unique",
  );
export type DecisionEvidenceSubmission = z.infer<typeof DecisionEvidenceSubmissionSchema>;

const ReadinessStatusSchema = z.enum(["insufficient", "provisional", "ready"]);
const ReadinessCodeSchema = z.string().trim().min(1).max(100);

export const OfferDecisionReadinessSchema = z
  .object({
    offerKey: DecisionOfferKeySchema,
    status: z.enum(["eliminated", "provisional", "ready"]),
    gaps: z.array(ReadinessCodeSchema).max(50),
    conflicts: z.array(boundedSafeText(2_000)).max(16),
    totalConflictCount: z.int().nonnegative().max(800),
    conflictsTruncated: z.boolean(),
    unknowns: z.array(boundedSafeText(2_000)).max(16),
    totalUnknownCount: z.int().nonnegative().max(800),
    unknownsTruncated: z.boolean(),
    remainingChecklistItemIds: z.array(ChecklistIdSchema).max(32),
  })
  .strict()
  .superRefine((readiness, context) => {
    const summaries = [
      {
        displayed: readiness.conflicts.length,
        total: readiness.totalConflictCount,
        truncated: readiness.conflictsTruncated,
        path: "conflicts",
      },
      {
        displayed: readiness.unknowns.length,
        total: readiness.totalUnknownCount,
        truncated: readiness.unknownsTruncated,
        path: "unknowns",
      },
    ];
    for (const summary of summaries) {
      const shouldBeTruncated = summary.total > summary.displayed;
      if (summary.total < summary.displayed || summary.truncated !== shouldBeTruncated) {
        context.addIssue({
          code: "custom",
          path: [summary.path],
          message: "displayed evidence summaries must report exact totals and truncation",
        });
      }
      if (summary.truncated && summary.displayed !== 16) {
        context.addIssue({
          code: "custom",
          path: [summary.path],
          message: "truncated evidence summaries must retain the first sixteen entries",
        });
      }
    }
  });
export type OfferDecisionReadiness = z.infer<typeof OfferDecisionReadinessSchema>;

export const DecisionReadinessSchema = z
  .object({
    status: ReadinessStatusSchema,
    reasons: z.array(ReadinessCodeSchema).max(50),
    qualifyingOfferKeys: z.array(DecisionOfferKeySchema).max(1_000),
    offers: z.array(OfferDecisionReadinessSchema).max(1_000),
  })
  .strict();
export type DecisionReadiness = z.infer<typeof DecisionReadinessSchema>;
