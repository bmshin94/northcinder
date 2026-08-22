import type { Offer, PurchaseMandate, SearchQuery } from "../schemas/core.js";
import type { StoreError } from "../schemas/errors.js";
import type { AdapterManifest } from "./manifest.js";
import { z } from "zod";
import { StoreErrorCodeSchema, type StoreErrorCode } from "../schemas/errors.js";

/**
 * Per-call execution context. Adapters MUST honor `timeoutMs`: any call that
 * cannot finish inside the budget resolves with a structured `timeout` /
 * `unavailable` StoreError instead of hanging or throwing (graceful
 * degradation — one store failing never fails the search).
 */
export interface AdapterContext {
  /** Hard budget for the whole call, in milliseconds. */
  timeoutMs: number;
  /** Optional cooperative cancellation. */
  signal?: AbortSignal;
}

/**
 * Adapter results are a discriminated union — adapters never reject across
 * the SDK boundary. `ok: false` carries a structured StoreError.
 */
export type AdapterResult<T> = { ok: true } & T | { ok: false; error: StoreError };

const CHILD_SOURCE_ERROR_MESSAGES = {
  timeout: "source request timed out",
  unavailable: "source is unavailable",
  not_configured: "source is not configured",
  blocked: "source access was blocked",
  not_found: "source item was not found",
  invalid_response: "source returned an invalid response",
  rate_limited: "source rate limit reached",
  permission_denied: "source access was denied",
  internal: "source failed internally",
} satisfies Record<StoreErrorCode, string>;

const CHILD_SOURCE_HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Already-normalized concrete DNS hostname for one source that was actually attempted. */
export const ChildSourceHostnameSchema = z.string().min(1).max(253).refine(
  (source) => source.split(".").every((label) => CHILD_SOURCE_HOST_LABEL.test(label)),
  "source must be a normalized concrete hostname",
);

/** Strict, bounded outcome for an actually attempted configured child source. */
export const ChildSourceErrorSchema = z.object({
  code: StoreErrorCodeSchema,
  message: z.string().min(1).max(64),
  store: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().finite().optional(),
}).strict().superRefine((error, context) => {
  if (error.message !== CHILD_SOURCE_ERROR_MESSAGES[error.code]) {
    context.addIssue({ code: "custom", path: ["message"], message: "child source message must be the fixed buyer-safe value for its code" });
  }
});
export type ChildSourceError = z.infer<typeof ChildSourceErrorSchema>;

/** Drop provider text and arbitrary top-level details at the child-source boundary. */
export function toChildSourceError(error: StoreError): ChildSourceError {
  return {
    store: error.store,
    code: error.code,
    message: CHILD_SOURCE_ERROR_MESSAGES[error.code],
    retryable: error.retryable,
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
  };
}

export const SourceStatusSchema = z.discriminatedUnion("ok", [
  z.object({ source: ChildSourceHostnameSchema, ok: z.literal(true), offerCount: z.int().nonnegative() }).strict(),
  z.object({ source: ChildSourceHostnameSchema, ok: z.literal(false), error: ChildSourceErrorSchema }).strict(),
]);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export type AdapterSearchResult = AdapterResult<{ offers: Offer[]; sourceStatuses?: SourceStatus[] }>;
export type AdapterOfferResult = AdapterResult<{ offer: Offer }>;

/**
 * Optional checkout capability (checkout integration wires the rails). An adapter that
 * declares `capabilities.checkout: true` must implement it; the mandate
 * parameter makes the hard gate structural — there is no mandate-less entry.
 */
export interface AdapterCheckout {
  /**
   * Initiate checkout for an offer under a signed purchase mandate.
   * Verification of the mandate happens in the checkout orchestrator BEFORE
   * any rail is invoked; adapters still receive it for auditability.
   */
  beginCheckout(
    offerId: string,
    mandate: PurchaseMandate,
    ctx: AdapterContext,
  ): Promise<AdapterResult<{ checkoutUrl: string }>>;
}

/**
 * The store adapter contract. Every store plugin implements this and must
 * pass the conformance harness (`runConformanceSuite`) in its own test run.
 */
export interface StoreAdapter {
  readonly manifest: AdapterManifest;
  search(query: SearchQuery, ctx: AdapterContext): Promise<AdapterSearchResult>;
  getOffer(offerId: string, ctx: AdapterContext): Promise<AdapterOfferResult>;
  /** Present iff `manifest.capabilities.checkout` is true. */
  checkout?: AdapterCheckout;
}
