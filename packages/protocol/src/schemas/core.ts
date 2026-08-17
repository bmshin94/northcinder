import { z } from "zod";

/**
 * Money is ALWAYS integer minor units (cents, pence, …) + an ISO-4217 code.
 * Floats never represent money anywhere in the protocol.
 */
export const MoneySchema = z.object({
  amount: z.int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/, "ISO-4217 uppercase 3-letter currency code"),
});
export type Money = z.infer<typeof MoneySchema>;

/**
 * Merchant identity — who the buyer would actually be transacting with.
 *
 * `id` and `domain` forbid the `#` character: it is the reserved delimiter in
 * `trustKey` (see trust/key.ts), so allowing it would let a hostile merchant
 * craft `{id: "ebay.com#seller-1", domain: "ebay.com#seller-1"}` whose key
 * collides with the legitimate sub-merchant `{id: "seller-1", domain:
 * "ebay.com"}` and poison its trust signal. `#` is never valid in a hostname
 * and is not a legitimate merchant-id character in this system; rejecting it
 * at the schema boundary (every offer is OfferSchema-parsed at the adapter
 * edge) is what makes trustKey collision-safe by construction.
 */
export const MerchantSchema = z.object({
  /** Stable identifier; for web merchants, conventionally the domain. */
  id: z.string().min(1).regex(/^[^#]+$/, "merchant id must not contain '#' (trustKey delimiter)"),
  name: z.string().min(1),
  /** Bare hostname of the storefront (no scheme, no path). */
  domain: z.string().min(1).regex(/^[^#]+$/, "merchant domain must not contain '#' (trustKey delimiter)"),
  /** Optional platform hint, e.g. "shopify", "ebay", "etsy", "amazon". */
  platform: z.string().min(1).optional(),
});
export type Merchant = z.infer<typeof MerchantSchema>;

export const AvailabilitySchema = z.enum(["in_stock", "out_of_stock", "preorder", "unknown"]);
export type Availability = z.infer<typeof AvailabilitySchema>;

export const ShippingEstimateSchema = z.object({
  /** Shipping cost if known; omit when the store doesn't expose it pre-checkout. */
  cost: MoneySchema.optional(),
  /** Estimated delivery window in days from order. */
  estimatedDays: z
    .object({ min: z.int().nonnegative(), max: z.int().nonnegative() })
    .refine((d) => d.max >= d.min, { message: "max must be >= min" })
    .optional(),
  /** Concrete promised delivery date (ISO 8601 date) if the store states one. */
  deliveryBy: z.iso.date().optional(),
});
export type ShippingEstimate = z.infer<typeof ShippingEstimateSchema>;

const FORBIDDEN_AFFILIATE_QUERY_KEYS = new Set([
  "aff",
  "affid",
  "aff_id",
  "affiliate",
  "affiliate_id",
  "ascsubtag",
  "campid",
  "clickid",
  "customid",
  "irclickid",
  "mkcid",
  "mkevt",
  "mkrid",
  "ref",
  "ref_",
  "siteid",
  "tag",
]);

/**
 * Buyer-facing offer URLs may retain functional parameters (for example a
 * product variant), but never affiliate or campaign attribution. This lives
 * in the shared Offer boundary so every adapter, service response, and MCP
 * consumer gets the same fail-closed rule.
 */
export const AffiliateCleanProductUrlSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return [...url.searchParams.keys()].every((rawKey) => {
      const key = rawKey.toLowerCase();
      return !key.startsWith("utm_") && !FORBIDDEN_AFFILIATE_QUERY_KEYS.has(key);
    });
  } catch {
    return false;
  }
}, "product URL must not contain affiliate or campaign-tracking parameters");

export const ProductSchema = z.object({
  /** Store-scoped product identifier. */
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  /** Canonical product page URL in the source store. */
  url: AffiliateCleanProductUrlSchema,
  imageUrl: z.url().optional(),
  brand: z.string().min(1).optional(),
  /** Normalized spec attributes used for must-have matching (e.g. storage: "128GB"). */
  attributes: z.record(z.string(), z.string()).default({}),
});
export type Product = z.infer<typeof ProductSchema>;

/**
 * An Offer is a purchasable listing of a Product by a Merchant, with provenance.
 *
 * `sponsored` is deliberately REQUIRED with no default (spec §4 invariant 1):
 * an offer cannot exist in this protocol without declaring whether anyone paid
 * for its placement. Adapters that "forget" the field fail schema validation.
 */
export const AgentObservedAcquisitionSchema = z
  .object({
    kind: z.literal("agent_observed"),
    observedAt: z.iso.datetime(),
    receivedAt: z.iso.datetime(),
    placement: z.enum(["organic", "sponsored", "unknown"]),
  })
  .strict();
export type AgentObservedAcquisition = z.infer<typeof AgentObservedAcquisitionSchema>;

export const OfferSchema = z.object({
  /** Store-scoped offer identifier (stable enough to re-fetch via getOffer). */
  id: z.string().min(1),
  product: ProductSchema,
  price: MoneySchema,
  merchant: MerchantSchema,
  availability: AvailabilitySchema,
  shipping: ShippingEstimateSchema.optional(),
  /** Provenance: the adapter/store id this offer came from (matches AdapterManifest.id). */
  sourceStore: z.string().min(1),
  /** MANDATORY paid-placement declaration. Never defaulted. */
  sponsored: z.boolean(),
  /**
   * When this offer's data was fetched from the store (ISO 8601 datetime).
   * Optional for backward compatibility: adapters may stamp it themselves;
   * the service orchestrator stamps any offer that arrives without one.
   * Feeds the buyer's-brief per-cell provenance (buyer brief).
   */
  fetchedAt: z.iso.datetime().optional(),
  /** Item condition, where marketplaces distinguish it. */
  condition: z.enum(["new", "used", "refurbished"]).optional(),
  /**
   * Present only when the buyer's MCP host reported facts from its own
   * browser. This marks input provenance; it does not independently verify
   * the page or make the offer eligible for checkout.
   */
  acquisition: AgentObservedAcquisitionSchema.optional(),
}).superRefine((offer, context) => {
  const isBrowserSource = offer.sourceStore === "agent_browser";
  const isAgentObserved = offer.acquisition?.kind === "agent_observed";
  if (isBrowserSource && !isAgentObserved) {
    context.addIssue({
      code: "custom",
      path: ["acquisition"],
      message: "agent_browser offers require agent_observed acquisition provenance",
    });
  }
  if (isAgentObserved && !isBrowserSource) {
    context.addIssue({
      code: "custom",
      path: ["sourceStore"],
      message: "agent_observed acquisition provenance requires sourceStore agent_browser",
    });
  }
});
export type Offer = z.infer<typeof OfferSchema>;

/**
 * Browser-sourced offers are comparison inputs, never native checkout or
 * watch facts. `sourceStore` is retained as a fail-closed provenance signal
 * for legacy or malformed data that omits the additive acquisition record.
 */
export function requiresNativeRevalidation(
  offer: Pick<Offer, "sourceStore" | "acquisition">,
): boolean {
  return offer.sourceStore === "agent_browser" || offer.acquisition?.kind === "agent_observed";
}

const BrowserProductUrlSchema = AffiliateCleanProductUrlSchema.refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.username === "" && url.password === "";
}, "browser observation URL must be HTTPS and must not contain credentials");

const BrowserShippingEstimateSchema = z
  .object({
    cost: MoneySchema.strict().optional(),
    estimatedDays: z
      .object({ min: z.int().nonnegative(), max: z.int().nonnegative() })
      .strict()
      .refine((days) => days.max >= days.min, { message: "max must be >= min" })
      .optional(),
    deliveryBy: z.iso.date().optional(),
  })
  .strict();

/**
 * Comparison facts reported by a browser tool owned by the buyer's MCP host.
 * This is deliberately not an Offer: the caller cannot choose identifiers,
 * merchant trust, ranking inputs, scores, reasons, or checkout capability.
 */
export const BrowserObservationSchema = z
  .object({
    productUrl: BrowserProductUrlSchema,
    title: z.string().trim().min(1).max(500),
    price: MoneySchema.strict(),
    availability: AvailabilitySchema,
    merchantName: z.string().trim().min(1).max(200),
    brand: z.string().trim().min(1).max(200).optional(),
    attributes: z
      .record(z.string().trim().min(1).max(100), z.string().trim().max(500))
      .refine((attributes) => Object.keys(attributes).length <= 32, "at most 32 attributes are allowed")
      .optional(),
    condition: z.enum(["new", "used", "refurbished"]).optional(),
    shipping: BrowserShippingEstimateSchema.optional(),
    placement: z.enum(["organic", "sponsored", "unknown"]),
    observedAt: z.iso.datetime(),
  })
  .strict();
export type BrowserObservation = z.infer<typeof BrowserObservationSchema>;

/** Free text + the structured criteria ranking is allowed to optimize for. */
export const SearchQuerySchema = z.object({
  text: z.string().min(1),
  maxPrice: MoneySchema.optional(),
  /** Attributes the product must have (matched against Product.attributes/title). */
  mustHaveAttributes: z.array(z.string().min(1)).optional(),
  /** Latest acceptable delivery date (ISO 8601 date). */
  deliveryBy: z.iso.date().optional(),
  /** Buyer ethics preferences, freeform tags (e.g. "fair-trade", "no-fur"). */
  ethicsFlags: z.array(z.string().min(1)).optional(),
  /** Soft cap on results per store; adapters may return fewer. */
  maxResults: z.int().positive().max(100).optional(),
}).strict();
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/** The machine-readable vocabulary of ranking criteria (spec §4 invariant 5). */
export const RankCriterionSchema = z.enum([
  "price",
  "spec_match",
  "delivery",
  "availability",
  "trust",
  "ethics",
  "sponsored_deprioritization",
  "flagged_merchant",
]);
export type RankCriterion = z.infer<typeof RankCriterionSchema>;

export const RankReasonSchema = z.object({
  criterion: RankCriterionSchema,
  /** Human-auditable specifics: exact price advantage, matched attribute, etc. */
  detail: z.string().min(1),
  /**
   * Optional stable machine-readable elimination code (see
   * `RANK_ELIMINATION_CODES` in `ranking/rank.ts`): attached by rank.ts to a
   * reason that represents a hard-criterion elimination, so a downstream
   * consumer (e.g. `@northcinder/brief`) can key off this code instead of pattern-
   * matching `detail`'s prose. Absent on every non-eliminating reason.
   */
  code: z.string().optional(),
});
export type RankReason = z.infer<typeof RankReasonSchema>;

/**
 * A ranked recommendation. `reasons` is non-empty by construction — every
 * recommendation states why (spec §4 invariant 5).
 */
export const RankedResultSchema = z.object({
  offer: OfferSchema,
  /** Deterministic criteria-fit score; higher is better. Must be finite. */
  score: z.number().refine(Number.isFinite, { message: "score must be finite" }),
  reasons: z.array(RankReasonSchema).min(1),
});
export type RankedResult = z.infer<typeof RankedResultSchema>;

export const TrustLevelSchema = z.enum(["trusted", "known", "unknown", "flagged"]);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

export const TrustEvidenceSchema = z.object({
  /** Where the judgment came from (e.g. "seed-list", "rdap", "tranco", "buyer-outcomes"). */
  source: z.string().min(1),
  detail: z.string().min(1),
  /**
   * When this evidence was measured (ISO 8601 datetime). Optional/additive:
   * curated seed lines have no fetch moment; probe-measured lines stamp it so
   * the user can judge staleness (trust-corpus spec §5.1).
   */
  fetchedAt: z.iso.datetime().optional(),
  /** Re-check pointer: the URL where the user can independently verify the fact. */
  url: z.url().optional(),
});
export type TrustEvidence = z.infer<typeof TrustEvidenceSchema>;

/**
 * Merchant trust signal (spec §4 invariant 6). Evidence is non-empty by
 * construction: even "unknown" must say why it is unknown.
 */
export const TrustSignalSchema = z.object({
  merchantId: z.string().min(1),
  level: TrustLevelSchema,
  evidence: z.array(TrustEvidenceSchema).min(1),
});
export type TrustSignal = z.infer<typeof TrustSignalSchema>;

/**
 * AP2-shaped purchase mandate (spec §4 invariant 4): explicit, per-purchase,
 * cryptographically signed user intent. Verification/issuance is checkout integration;
 * this schema is the wire shape both sides agree on.
 */
export const PurchaseMandateSchema = z
  .object({
    id: z.string().min(1),
    /** Human-readable statement of what the user authorized. */
    intent: z.string().min(1),
    constraints: z.object({
      /** The specific offer being authorized. */
      offerId: z.string().min(1),
      /** The merchant the purchase must go to. */
      merchantId: z.string().min(1),
      /** Hard spending ceiling including shipping, in minor units. */
      maxAmount: MoneySchema,
    }),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    /** Single-use replay protection; ≥16 chars of entropy. */
    nonce: z.string().min(16),
    signature: z.object({
      algorithm: z.literal("ed25519"),
      /** Base64-encoded public key of the user's local mandate keypair. */
      publicKey: z.base64(),
      /** Base64-encoded signature over the canonical mandate payload. */
      value: z.base64(),
    }),
  })
  .refine((m) => Date.parse(m.expiresAt) > Date.parse(m.issuedAt), {
    message: "expiresAt must be after issuedAt",
    path: ["expiresAt"],
  });
export type PurchaseMandate = z.infer<typeof PurchaseMandateSchema>;
