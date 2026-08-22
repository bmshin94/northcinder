import { createHash } from "node:crypto";
import type { Offer } from "@northcinder/protocol";

/**
 * Canonical mandate signing payload: a deterministic,
 * order-fixed JSON array under a versioned domain tag. Signing an ARRAY with
 * an explicit field order (instead of an object) removes any key-ordering
 * ambiguity between signer and verifier.
 *
 * Covers the brief's required set {offer id, merchant, max amount+currency,
 * expiry, nonce} plus id, intent, and issuedAt — tampering with ANY of these
 * after signing invalidates the signature.
 */

export const MANDATE_SIGNING_DOMAIN = "northcinder.purchase-mandate.v2";
export const OFFER_DIGEST_DOMAIN = "northcinder.purchase-offer.v1";
export const PURCHASE_QUANTITY = 1 as const;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedText(value: string): string {
  return value.normalize("NFC");
}

/**
 * Digest every offer field that can change what, where, or how the buyer buys.
 * Arrays make field order explicit. Map-like facts are sorted so insertion
 * order cannot change the digest, while their names and values stay exact.
 */
export function purchaseOfferDigest(offer: Offer): string {
  const attributes = Object.entries(offer.product.attributes)
    .map(([key, value]) => [normalizedText(key), normalizedText(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      compareStrings(leftKey, rightKey) || compareStrings(leftValue, rightValue));
  const identifiers = (offer.product.identity?.identifiers ?? [])
    .map((identifier) => [identifier.scheme, normalizedText(identifier.value)] as const)
    .sort(([leftScheme, leftValue], [rightScheme, rightValue]) =>
      compareStrings(leftScheme, rightScheme) || compareStrings(leftValue, rightValue));
  const landedCostComponents = (offer.landedCost?.components ?? [])
    .map((component) => [
      component.kind,
      component.amount.amount,
      component.amount.currency,
      component.sourceUrl ?? null,
      component.observedAt ?? null,
    ] as const)
    .sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)));

  const canonical = JSON.stringify([
    OFFER_DIGEST_DOMAIN,
    PURCHASE_QUANTITY,
    offer.sourceStore,
    offer.id,
    offer.product.id,
    normalizedText(offer.product.title),
    offer.product.url,
    offer.product.brand === undefined ? null : normalizedText(offer.product.brand),
    offer.product.identity === undefined
      ? null
      : [
          normalizedText(offer.product.identity.canonical),
          normalizedText(offer.product.identity.variant),
          offer.product.identity.model === undefined ? null : normalizedText(offer.product.identity.model),
          offer.product.identity.generation === undefined
            ? null
            : normalizedText(offer.product.identity.generation),
          identifiers,
        ],
    attributes,
    offer.merchant.id,
    normalizedText(offer.merchant.name),
    offer.merchant.domain,
    offer.merchant.platform ?? null,
    [offer.price.amount, offer.price.currency],
    offer.shipping === undefined
      ? null
      : [
          offer.shipping.cost === undefined
            ? null
            : [offer.shipping.cost.amount, offer.shipping.cost.currency],
          offer.shipping.estimatedDays === undefined
            ? null
            : [offer.shipping.estimatedDays.min, offer.shipping.estimatedDays.max],
          offer.shipping.deliveryBy ?? null,
        ],
    offer.landedCost === undefined
      ? null
      : [
          landedCostComponents,
          [offer.landedCost.knownTotal.amount, offer.landedCost.knownTotal.currency],
          [...offer.landedCost.unknownComponents].sort(compareStrings),
          offer.landedCost.completeness,
        ],
    offer.condition ?? null,
    offer.acquisition === undefined
      ? ["native", null]
      : [
          offer.acquisition.kind,
          offer.acquisition.observedAt,
          offer.acquisition.receivedAt,
          offer.acquisition.placement,
        ],
  ]);

  return createHash("sha256").update(canonical).digest("hex");
}

export interface MandateSigningFields {
  version: 2;
  id: string;
  intent: string;
  offerId: string;
  merchantId: string;
  offerDigest: string;
  quantity: 1;
  /** Spending ceiling in integer minor units. */
  maxAmountMinor: number;
  /** ISO-4217 currency of the ceiling. */
  currency: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export function canonicalMandatePayload(fields: MandateSigningFields, domain = MANDATE_SIGNING_DOMAIN): Uint8Array {
  const canonical = JSON.stringify([
    domain,
    fields.version,
    fields.id,
    fields.intent,
    fields.offerId,
    fields.merchantId,
    fields.offerDigest,
    fields.quantity,
    fields.maxAmountMinor,
    fields.currency,
    fields.issuedAt,
    fields.expiresAt,
    fields.nonce,
  ]);
  return new TextEncoder().encode(canonical);
}
