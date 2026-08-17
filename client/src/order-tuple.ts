/**
 * approval "sign what you see": the FOUR-TUPLE the human approves and the order
 * fingerprint that binds the confirmation code to it.
 *
 * The four-tuple (merchant + merchant-of-record, exact item incl. variant,
 * all-in total with an honest UNKNOWN-tax statement, payment context per
 * rail) is rendered by ONE function and shown verbatim on every trusted
 * buyer-local channel: the 0600 code file, the approval page, and the optional
 * low-level stderr banner. There is deliberately no second renderer to drift.
 *
 * The order fingerprint is a short display-binding hash over the canonical
 * tuple (same canonicalization discipline as the mandate signing payload:
 * a domain-tagged, order-fixed JSON array — see
 * packages/checkout/src/mandate/canonical.ts). It is displayed WITH the
 * code so the human can cross-check that what they approve is what will be
 * signed; it is NOT a secret and NEVER substitutes for the code.
 */
import { createHash } from "node:crypto";
import type { Money, Offer } from "@northcinder/protocol";
import { offerTotal } from "@northcinder/checkout";
import { BRAND_NAME } from "./brand.js";

/** Which checkout rail would execute this purchase — decides the payment-context copy. */
export type PaymentContext = "acp" | "cart-permalink" | "none";

export const ORDER_FINGERPRINT_DOMAIN = "northcinder.order-fingerprint.v2";

/**
 * Attribute key carrying the purchase-relevant Shopify variant identity
 * (must stay in sync with @northcinder/checkout's cart-permalink rail).
 */
export const VARIANT_ATTRIBUTE = "shopify:variantGid";

export interface OrderFingerprintFields {
  merchantId: string;
  offerId: string;
  /**
   * The underlying product identity — what the ACP rail actually purchases
   * (line_items are keyed by product.id, NOT offer.id), so it must be bound.
   */
  productId: string;
  /**
   * The purchase-relevant variant identity (the cart-permalink rail buys by
   * the Shopify variant gid). Empty string when the offer has none.
   */
  variantKey: string;
  /** The all-in approved total (price + known shipping) in minor units. */
  totalMinor: number;
  /** ISO-4217 currency of the total. */
  currency: string;
  /** The single-use nonce the mandate will be signed with. */
  nonce: string;
}

/**
 * Short (4 hex chars) display-binding hash over the canonical order tuple.
 * Deterministic; every field is load-bearing. Recomputed at approval time —
 * any tuple mutation after issuance changes the fingerprint and voids the
 * approval.
 */
export function orderFingerprint(fields: OrderFingerprintFields): string {
  const canonical = JSON.stringify([
    ORDER_FINGERPRINT_DOMAIN,
    fields.merchantId,
    fields.offerId,
    fields.productId,
    fields.variantKey,
    fields.totalMinor,
    fields.currency,
    fields.nonce,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 4).toUpperCase();
}

export function formatMoney(m: Money): string {
  return `${(m.amount / 100).toFixed(2)} ${m.currency}`;
}

/**
 * Human-readable variant descriptor from the offer's normalized attributes:
 * plain attributes verbatim, plus the numeric Shopify variant id when the
 * adapter recorded one. Null when the offer carries no variant information.
 */
export function variantLabel(offer: Offer): string | null {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(offer.product.attributes)) {
    if (!key.includes(":")) parts.push(`${key}: ${value}`);
  }
  const gid = offer.product.attributes[VARIANT_ATTRIBUTE];
  const variantId = gid?.match(/^gid:\/\/shopify\/ProductVariant\/(\d+)$/)?.[1];
  if (variantId !== undefined) parts.push(`shopify variant ${variantId}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

const PAYMENT_LINES: Record<PaymentContext, string> = {
  acp: `delegated token via ACP — ${BRAND_NAME} sends only an opaque delegated payment token; no card data exists in this flow`,
  "cart-permalink":
    "your payment method at merchant checkout — your own browser session and stored payment method complete the purchase",
  none: "no automated checkout rail is configured for this merchant — checkout will be refused",
};

/**
 * The four tuple lines, verbatim, label-aligned. Used unchanged by every
 * trusted channel (banner, code file, local UI approval page).
 */
export function renderOrderTuple(offer: Offer, paymentContext: PaymentContext): string[] {
  const total = offerTotal(offer);
  const shipping = offer.shipping?.cost;
  const variant = variantLabel(offer);
  const breakdown =
    shipping !== undefined
      ? `price ${formatMoney(offer.price)} + shipping ${formatMoney(shipping)}`
      : `price ${formatMoney(offer.price)}; shipping UNKNOWN`;
  // Honest, rail-specific tax statement — no drip pricing: either the exact
  // amount is enforced (ACP, zero tolerance) or the user is told exactly
  // where they WILL see the final number (their own merchant checkout).
  // ACP wording is precise about WHAT is enforced: the merchant's quoted
  // pre-payment total is checked (zero tolerance) BEFORE payment; the amount
  // the merchant then reports charging is recorded in the audit trail.
  const taxNote =
    paymentContext === "acp"
      ? "tax UNKNOWN at authorization — checkout is REFUSED unless the merchant's pre-payment total equals this amount exactly"
      : "tax UNKNOWN — you will see the final total, including any tax, at merchant checkout before paying";
  return [
    `Merchant:  ${offer.merchant.name} (${offer.merchant.id}) — merchant of record: ${offer.merchant.name} is the party that charges you`,
    `Item:      ${offer.product.title}${variant !== null ? ` — variant: ${variant}` : " — no variant specified"}`,
    `Total:     ${formatMoney(total)} all-in (${breakdown}; ${taxNote})`,
    `Payment:   ${PAYMENT_LINES[paymentContext]}`,
  ];
}
