import { z } from "zod";
import { MoneySchema, SearchQuerySchema } from "./core.js";

/**
 * The user-owned preference profile (spec: the unclaimed differentiator).
 * These are the OPEN contract shapes; the local store lives in
 * `@northcinder/profile`, the user-verifiable editor is the local UI dashboard.
 *
 * EVERY entry carries the attribution trio — `origin`, `source`, `createdAt` —
 * with NO defaults: an entry cannot exist without declaring whether the user
 * stated it or the system inferred it, and from which interaction. Inferred
 * entries are the trust hazard (arXiv:2602.01450): they must be visibly
 * distinct wherever shown, and deletable in one call.
 */
export const ProfileOriginSchema = z.enum(["stated", "inferred"]);
export type ProfileOrigin = z.infer<typeof ProfileOriginSchema>;

const BoundedPreferenceTextSchema = z.string().trim().min(1).max(500);

export const PreferenceScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("subject"), value: BoundedPreferenceTextSchema }).strict(),
  z.object({ kind: z.literal("category"), value: BoundedPreferenceTextSchema }).strict(),
  z.object({ kind: z.literal("project"), value: BoundedPreferenceTextSchema }).strict(),
]);
export type PreferenceScope = z.infer<typeof PreferenceScopeSchema>;

export const PreferenceReasonSchema = z.enum([
  "fit",
  "style",
  "evidence",
  "price",
  "delivery",
  "wrong_recipient",
  "duplicate_ownership",
]);
export type PreferenceReason = z.infer<typeof PreferenceReasonSchema>;

/** Attribution fields present on every profile entry. Never defaulted. */
const entryBase = {
  id: z.string().min(1),
  origin: ProfileOriginSchema,
  /** Which interaction created this entry (e.g. "update_profile …", "record_feedback:not_interested …"). */
  source: z.string().min(1),
  createdAt: z.iso.datetime(),
  scope: PreferenceScopeSchema.optional(),
  expiresAt: z.iso.datetime().optional(),
};

/** A size the user takes, per category (e.g. category "sneakers", value "EU 43"). */
export const SizeEntrySchema = z.object({
  ...entryBase,
  kind: z.literal("size"),
  category: z.string().min(1),
  value: z.string().min(1),
});
export type SizeEntry = z.infer<typeof SizeEntrySchema>;

/** A default budget ceiling, per category. Merged as maxPrice when the query has none. */
export const BudgetEntrySchema = z.object({
  ...entryBase,
  kind: z.literal("budget"),
  category: z.string().min(1),
  maxPrice: MoneySchema,
});
export type BudgetEntry = z.infer<typeof BudgetEntrySchema>;

/** Brand allow/deny. NOT merged into search criteria (SearchQuery has no brand field); exposed via get_profile. */
export const BrandEntrySchema = z.object({
  ...entryBase,
  kind: z.literal("brand"),
  brand: z.string().min(1),
  stance: z.enum(["allow", "deny"]),
});
export type BrandEntry = z.infer<typeof BrandEntrySchema>;

/** A standing buyer-ethics flag (e.g. "fair-trade"), unioned into every search's ethicsFlags. */
export const EthicsEntrySchema = z.object({
  ...entryBase,
  kind: z.literal("ethics"),
  flag: z.string().min(1),
});
export type EthicsEntry = z.infer<typeof EthicsEntrySchema>;

/** Default delivery expectation: latest acceptable delivery, in days from search time. */
export const DeliveryEntrySchema = z.object({
  ...entryBase,
  kind: z.literal("delivery"),
  maxDays: z.int().positive(),
});
export type DeliveryEntry = z.infer<typeof DeliveryEntrySchema>;

/** Notification preference (consumed by watches — watches NOTIFY, they never auto-buy). */
export const NotificationEntrySchema = z.object({
  ...entryBase,
  kind: z.literal("notification"),
  event: z.string().min(1),
  enabled: z.boolean(),
});
export type NotificationEntry = z.infer<typeof NotificationEntrySchema>;

export const ProfileEntrySchema = z.discriminatedUnion("kind", [
  SizeEntrySchema,
  BudgetEntrySchema,
  BrandEntrySchema,
  EthicsEntrySchema,
  DeliveryEntrySchema,
  NotificationEntrySchema,
]);
export type ProfileEntry = z.infer<typeof ProfileEntrySchema>;

const inputOmit = { id: true, origin: true, source: true, createdAt: true } as const;

/**
 * What a CALLER may supply when creating an entry: the preference content
 * only. The attribution trio (id, origin, source, createdAt) is assigned by
 * the store — a caller can never smuggle in its own origin.
 */
export const ProfileEntryInputSchema = z.discriminatedUnion("kind", [
  SizeEntrySchema.omit(inputOmit),
  BudgetEntrySchema.omit(inputOmit),
  BrandEntrySchema.omit(inputOmit),
  EthicsEntrySchema.omit(inputOmit),
  DeliveryEntrySchema.omit(inputOmit),
  NotificationEntrySchema.omit(inputOmit),
]);
export type ProfileEntryInput = z.infer<typeof ProfileEntryInputSchema>;

export const BrandPreferenceProposalSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("brand"),
    brand: BoundedPreferenceTextSchema,
    stance: z.enum(["allow", "deny"]),
    reason: PreferenceReasonSchema,
    scope: PreferenceScopeSchema.optional(),
    evidenceKeys: z.array(z.string().trim().min(1).max(1_000)).min(1).max(32).refine(
      (keys) => new Set(keys).size === keys.length,
      "evidence keys must be unique",
    ),
    source: BoundedPreferenceTextSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type BrandPreferenceProposal = z.infer<typeof BrandPreferenceProposalSchema>;

export const BrandPreferenceProposalInputSchema = z
  .object({
    brand: BoundedPreferenceTextSchema,
    stance: z.enum(["allow", "deny"]),
    reason: PreferenceReasonSchema,
    scope: PreferenceScopeSchema.optional(),
    evidenceKey: z.string().trim().min(1).max(1_000),
    source: BoundedPreferenceTextSchema,
  })
  .strict();
export type BrandPreferenceProposalInput = z.infer<typeof BrandPreferenceProposalInputSchema>;

/** A profile entry that was merged into (or overridden out of) a search's criteria — cited by exact id + origin. */
export const AppliedProfileEntrySchema = z.object({
  id: z.string().min(1),
  origin: ProfileOriginSchema,
  kind: z.string().min(1),
  /** Which SearchQuery field the entry filled (e.g. "maxPrice", "mustHaveAttributes"). */
  appliedTo: z.string().min(1),
  /** Human-auditable specifics: the exact value the entry contributed. */
  detail: z.string().min(1),
});
export type AppliedProfileEntry = z.infer<typeof AppliedProfileEntrySchema>;

export const OverriddenProfileEntrySchema = AppliedProfileEntrySchema.extend({
  /** What beat it — always a per-query criterion (per-query > profile defaults). */
  overriddenBy: z.string().min(1),
});
export type OverriddenProfileEntry = z.infer<typeof OverriddenProfileEntrySchema>;

/**
 * The interpretation echo (search_products output): "here's how I read that",
 * so the human can correct a wrong reading instead of silently getting wrong
 * results. `criteria` is the EXACT post-merge structured query the ranking
 * used; applied/overridden entries are cited by id + origin; words of the
 * free-text query that map to no structured criterion are listed so the user
 * can see what was only fuzzy-matched.
 */
export const InterpretedQuerySchema = z.object({
  criteria: SearchQuerySchema,
  appliedProfileEntries: z.array(AppliedProfileEntrySchema),
  overriddenProfileEntries: z.array(OverriddenProfileEntrySchema),
  unmatchedQueryWords: z.array(z.string().min(1)),
});
export type InterpretedQuery = z.infer<typeof InterpretedQuerySchema>;
