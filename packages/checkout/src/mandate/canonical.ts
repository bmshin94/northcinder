/**
 * Canonical mandate signing payload (AP2-shaped, MVP): a deterministic,
 * order-fixed JSON array under a versioned domain tag. Signing an ARRAY with
 * an explicit field order (instead of an object) removes any key-ordering
 * ambiguity between signer and verifier.
 *
 * Covers the brief's required set {offer id, merchant, max amount+currency,
 * expiry, nonce} plus id, intent, and issuedAt — tampering with ANY of these
 * after signing invalidates the signature.
 */

export const MANDATE_SIGNING_DOMAIN = "northcinder.purchase-mandate.v1";
/** Kept only to verify mandates created under the immediately previous identity. */
export const BRIER_MANDATE_SIGNING_DOMAIN = "brier.purchase-mandate.v1";
/** Kept only to verify mandates created under the earlier identity. */
export const THENAGAIN_MANDATE_SIGNING_DOMAIN = "thenagain.purchase-mandate.v1";
/** Kept only to verify mandates created under the original working identity. */
export const LEGACY_MANDATE_SIGNING_DOMAIN = "emptor.purchase-mandate.v1";

export interface MandateSigningFields {
  id: string;
  intent: string;
  offerId: string;
  merchantId: string;
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
    fields.id,
    fields.intent,
    fields.offerId,
    fields.merchantId,
    fields.maxAmountMinor,
    fields.currency,
    fields.issuedAt,
    fields.expiresAt,
    fields.nonce,
  ]);
  return new TextEncoder().encode(canonical);
}
