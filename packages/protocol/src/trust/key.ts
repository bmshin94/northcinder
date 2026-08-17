import type { Merchant } from "../schemas/core.js";

/**
 * Canonical trust-map key (trust-corpus spec §5.1) — prevents a trust-keying
 * collision: the `/v1/search` trust map used to be keyed by bare
 * `merchant.id`, so two different stores with a colliding merchant id shared
 * one trust signal in the ranking output.
 *
 * The key is anchored in the merchant's VERIFIABLE identity, the domain:
 *
 *  - `merchant.domain` when `id === domain` — domain-anchored stores
 *    (Shopify/WooCommerce hosts and every adapter that follows the
 *    "id is conventionally the domain" convention in MerchantSchema).
 *  - `${domain}#${id}` otherwise — sub-merchants on a shared platform domain
 *    (e.g. marketplace sellers on ebay.com), where the domain alone would
 *    collapse every seller into one signal.
 *
 * COLLISION-SAFE BY CONSTRUCTION: `#` is the reserved delimiter, and
 * `MerchantSchema` (schemas/core.ts) rejects `#` in both `id` and `domain`.
 * Every offer entering the ranking pipeline is OfferSchema-parsed at the
 * adapter boundary, so no `#`-bearing merchant can reach this function — a
 * hostile `{id:"ebay.com#seller-1"}` cannot collide with the real
 * `{id:"seller-1", domain:"ebay.com"}` because the former never validates.
 *
 * Used in LOCKSTEP by `RankingInputs.trust`, the `rankOffers` lookup, the
 * `/v1/search` trustSignals map, the client's re-rank verification and the
 * remote bridge's re-verification (monorepo, pre-publish; no compat shim).
 * `TrustSignal.merchantId` is unchanged — it stays the merchant's identity;
 * only how trust MAPS are keyed changes.
 */
export function trustKey(merchant: Pick<Merchant, "id" | "domain">): string {
  return merchant.id === merchant.domain ? merchant.domain : `${merchant.domain}#${merchant.id}`;
}
