import type { Offer, PurchaseMandate, SearchQuery } from "../schemas/core.js";
import type { StoreError } from "../schemas/errors.js";
import type { AdapterManifest } from "./manifest.js";

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

export type AdapterSearchResult = AdapterResult<{ offers: Offer[] }>;
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
