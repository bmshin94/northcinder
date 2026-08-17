import { z } from "zod";
import { MerchantSchema, RankedResultSchema, SearchQuerySchema, TrustSignalSchema } from "./core.js";
import { StoreErrorSchema } from "./errors.js";

/**
 * Client↔service HTTP wire schemas (the open half of the protocol, spec §2).
 * The service validates every request body against these; the open client can
 * validate every response against them. Endpoints (service service integration):
 *
 *   POST /v1/search  SearchRankRequest  → SearchRankResponse
 *   POST /v1/trust   TrustRequest       → TrustResponse
 *
 * Auth: `Authorization: Bearer <per-client key>`; failures return the
 * structured `ServiceError` shape from ./errors.js.
 */

/**
 * Per-store outcome of an aggregation fan-out. Partial failure is a normal
 * response state: one store failing never fails the search (reliability
 * backbone), and the failure is REPORTED, never hidden.
 */
export const StoreStatusSchema = z.discriminatedUnion("ok", [
  z.object({
    store: z.string().min(1),
    ok: z.literal(true),
    offerCount: z.int().nonnegative(),
    durationMs: z.int().nonnegative(),
  }),
  z.object({
    store: z.string().min(1),
    ok: z.literal(false),
    error: StoreErrorSchema,
    durationMs: z.int().nonnegative(),
  }),
]);
export type StoreStatus = z.infer<typeof StoreStatusSchema>;

export const SearchRankRequestSchema = z.object({
  query: SearchQuerySchema,
  /** Untrusted per-item inputs; the service reports individual rejections. */
  browserObservations: z.array(z.unknown()).max(50).optional(),
}).strict();
export type SearchRankRequest = z.infer<typeof SearchRankRequestSchema>;

export const BrowserObservationReportSchema = z
  .object({
    submitted: z.int().nonnegative(),
    accepted: z.int().nonnegative(),
    rejected: z.array(
      z
        .object({
          index: z.int().nonnegative(),
          code: z.enum(["invalid_observation", "unsafe_content"]),
          message: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.accepted + report.rejected.length !== report.submitted) {
      context.addIssue({
        code: "custom",
        path: ["rejected"],
        message: "accepted plus rejected must equal submitted",
      });
    }
    if (new Set(report.rejected.map((rejection) => rejection.index)).size !== report.rejected.length) {
      context.addIssue({
        code: "custom",
        path: ["rejected"],
        message: "rejected indexes must be unique",
      });
    }
    if (report.rejected.some((rejection) => rejection.index >= report.submitted)) {
      context.addIssue({
        code: "custom",
        path: ["rejected"],
        message: "rejected indexes must identify submitted items",
      });
    }
  });
export type BrowserObservationReport = z.infer<typeof BrowserObservationReportSchema>;

export const SearchRankResponseSchema = z.object({
  /** Neutrality-ranked offers across all responding stores. */
  results: z.array(RankedResultSchema),
  /** One entry per registered store — successes and failures alike. */
  storeStatuses: z.array(StoreStatusSchema),
  /** Registered fan-out stores; clients independently check this coverage. */
  registeredStores: z.array(z.string().min(1)).optional(),
  /**
   * The trust signals the service's ranking consumed, keyed by `trustKey(merchant)` (see `trust/key.ts` — collision-safe)
   * (client-side ranking verification). Together with the offers embedded in
   * `results`, these are ALL the inputs `rankOffers` takes — so any client
   * can deterministically recompute the ranking with the open implementation
   * and catch a boosted re-order (see `verifySearchRanking`).
   *
   * Optional for backward compatibility with legacy services; when absent,
   * client-side verification reports `"not_applicable"`, never a fake green.
   */
  trustSignals: z.record(z.string(), TrustSignalSchema).optional(),
  /** Present when buyer-agent browser observations were submitted. */
  browserObservationReport: BrowserObservationReportSchema.optional(),
});
export type SearchRankResponse = z.infer<typeof SearchRankResponseSchema>;

export const TrustRequestSchema = z.object({
  merchant: MerchantSchema,
}).strict();
export type TrustRequest = z.infer<typeof TrustRequestSchema>;

export const TrustResponseSchema = TrustSignalSchema;
export type TrustResponse = z.infer<typeof TrustResponseSchema>;
