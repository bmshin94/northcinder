/**
 * Mandate issuance: one explicit, per-purchase, signed authorization
 * (spec §4 invariant 4). Issued CLIENT-side with the user's local keypair.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Money, Offer, PurchaseMandate } from "@northcinder/protocol";
import { PurchaseMandateSchema } from "@northcinder/protocol";
import { canonicalMandatePayload, PURCHASE_QUANTITY, purchaseOfferDigest } from "./canonical.js";
import type { MandateKeypair } from "./keystore.js";

export const DEFAULT_MANDATE_TTL_MS = 15 * 60_000;

/**
 * True iff the offer carries a shipping cost in a currency DIFFERENT from
 * the price — a Money can't be summed across currencies, so `offerTotal`
 * below can only ever report price + shipping when they match. Callers that
 * gate mandate/authorization CREATION (the only place a silently-understated
 * total matters — display-only formatting of an already-created,
 * already-refused-if-mismatched authorization never hits this) must check
 * this FIRST and refuse rather than let offerTotal quietly drop the
 * shipping cost.
 */
export function hasUnrepresentableShippingCurrency(offer: Offer): boolean {
  const shipping = offer.shipping?.cost;
  return shipping !== undefined && shipping.currency !== offer.price.currency;
}

/**
 * Offer price + shipping cost (same currency), in minor units. When the
 * offer's shipping is in a DIFFERENT currency than the price, the shipping
 * amount cannot be summed into a single Money and is (necessarily) left out
 * of this total — callers that create a mandate/authorization from this
 * total MUST check `hasUnrepresentableShippingCurrency` first and refuse,
 * rather than silently authorizing less than the offer's real total.
 */
export function offerTotal(offer: Offer): Money {
  const shipping = offer.shipping?.cost;
  const amount =
    offer.price.amount + (shipping && shipping.currency === offer.price.currency ? shipping.amount : 0);
  return { amount, currency: offer.price.currency };
}

export interface IssueMandateOptions {
  keypair: MandateKeypair;
  offer: Offer;
  /** Human-readable statement of what the user authorized. */
  intent: string;
  /** Hard spending ceiling; defaults to the offer's price + known shipping. */
  maxAmount?: Money;
  /** Validity window from issuance (default 15 minutes). */
  ttlMs?: number;
  /**
   * Caller-supplied single-use nonce (>=16 chars, schema-enforced). Used by
   * the payload-bound approval flow: the order fingerprint displayed with the
   * out-of-band code at REQUEST time commits to this nonce, so the mandate
   * signed at APPROVAL time is the exact one the human saw fingerprinted.
   * Defaults to a fresh random nonce.
   */
  nonce?: string;
  now?: () => Date;
}

export function issueMandate(options: IssueMandateOptions): PurchaseMandate {
  const now = (options.now ?? (() => new Date()))();
  const maxAmount = options.maxAmount ?? offerTotal(options.offer);
  const id = `mandate_${randomUUID()}`;
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + (options.ttlMs ?? DEFAULT_MANDATE_TTL_MS)).toISOString();
  const nonce = options.nonce ?? randomBytes(18).toString("base64url"); // 24 chars, >=16 required by schema
  const offerDigest = purchaseOfferDigest(options.offer);

  const signature = options.keypair.sign(
    canonicalMandatePayload({
      version: 2,
      id,
      intent: options.intent,
      offerId: options.offer.id,
      merchantId: options.offer.merchant.id,
      offerDigest,
      quantity: PURCHASE_QUANTITY,
      maxAmountMinor: maxAmount.amount,
      currency: maxAmount.currency,
      issuedAt,
      expiresAt,
      nonce,
    }),
  );

  return PurchaseMandateSchema.parse({
    version: 2,
    id,
    intent: options.intent,
    constraints: {
      offerId: options.offer.id,
      merchantId: options.offer.merchant.id,
      offerDigest,
      quantity: PURCHASE_QUANTITY,
      maxAmount,
    },
    issuedAt,
    expiresAt,
    nonce,
    signature: {
      algorithm: "ed25519",
      publicKey: options.keypair.publicKeyB64,
      value: signature,
    },
  });
}
