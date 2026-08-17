/**
 * The checkout-rail abstraction (spec §5): one internal interface, N rails.
 * Every rail REQUIRES a `VerifiedMandate` — the type only the mandate
 * verifier can produce — so no rail is reachable without passing the
 * invariant-#4 gate. Rails never throw; they resolve discriminated results.
 */
import { requiresNativeRevalidation, type Money, type Offer } from "@northcinder/protocol";
import { hasUnrepresentableShippingCurrency, offerTotal } from "../mandate/issue.js";
import { isVerifiedMandate, type VerifiedMandate } from "../mandate/verify.js";

export interface RailContext {
  /** Hard budget for the whole rail execution, in milliseconds. */
  timeoutMs: number;
  signal?: AbortSignal;
}

export type CheckoutErrorCode =
  | "no_rail"
  | "native_revalidation_required"
  | "unverified_mandate"
  | "offer_mismatch"
  | "merchant_mismatch"
  | "currency_mismatch"
  | "offer_total_mismatch"
  | "not_configured"
  | "merchant_unreachable"
  | "merchant_rejected"
  | "invalid_merchant_response"
  | "currency_mismatch_at_checkout"
  | "total_mismatch_at_checkout"
  | "payment_token_unavailable"
  | "internal";

export interface CheckoutError {
  code: CheckoutErrorCode;
  message: string;
  /** Which rail produced the error, when one was reached. */
  rail?: string;
  details?: Record<string, unknown>;
}

/** Auditable proof of what the rail actually did. */
export type RailEvidence =
  | {
      rail: "acp";
      merchantBaseUrl: string;
      checkoutSessionId: string;
      orderId: string;
      permalinkUrl?: string;
      /** The merchant-stated final total that the mandate cap was enforced against. */
      totalCharged: Money;
    }
  | {
      rail: "cart-permalink";
      /** The user opens this in their OWN session; their own stored payment method completes it. */
      cartUrl: string;
      variantId: string;
      quantity: number;
    };

export type RailResult =
  | {
      ok: true;
      /** "completed" = the rail finished the purchase; "handed_off" = the user's own session finishes it. */
      status: "completed" | "handed_off";
      evidence: RailEvidence;
    }
  | { ok: false; error: CheckoutError };

export interface CheckoutRail {
  readonly id: string;
  /** Pure capability check — no side effects, no network. */
  canHandle(offer: Offer): boolean;
  /** Unreachable without a VerifiedMandate (invariant #4, by construction). */
  execute(offer: Offer, verified: VerifiedMandate, ctx: RailContext): Promise<RailResult>;
}

export function checkoutError(
  code: CheckoutErrorCode,
  message: string,
  opts?: { rail?: string; details?: Record<string, unknown> },
): CheckoutError {
  return {
    code,
    message,
    ...(opts?.rail !== undefined ? { rail: opts.rail } : {}),
    ...(opts?.details !== undefined ? { details: opts.details } : {}),
  };
}

/**
 * Defense-in-depth for directly exported rails. Registry membership proves a
 * mandate was genuinely verified, while these checks bind the rail's current
 * offer argument to the exact offer snapshot that verification accepted.
 */
export function railExecutionRejection(
  offer: Offer,
  verified: VerifiedMandate,
  railId: string,
): CheckoutError | null {
  if (!isVerifiedMandate(verified)) {
    return checkoutError(
      "unverified_mandate",
      "mandate object was not produced by verifyMandate in this process — refusing checkout",
      { rail: railId },
    );
  }
  if (requiresNativeRevalidation(offer)) {
    return checkoutError(
      "native_revalidation_required",
      "this offer was reported by the buyer's browser agent and must be confirmed by a native store connection before checkout",
      { rail: railId, details: { productUrl: offer.product.url } },
    );
  }

  const constraints = verified.mandate.constraints;
  if (offer.id !== constraints.offerId) {
    return checkoutError(
      "offer_mismatch",
      `verified mandate authorizes offer ${constraints.offerId}, not ${offer.id}`,
      { rail: railId },
    );
  }
  if (offer.merchant.id !== constraints.merchantId) {
    return checkoutError(
      "merchant_mismatch",
      `verified mandate authorizes merchant ${constraints.merchantId}, not ${offer.merchant.id}`,
      { rail: railId },
    );
  }
  if (hasUnrepresentableShippingCurrency(offer)) {
    return checkoutError(
      "currency_mismatch",
      "offer price and shipping use different currencies — refusing checkout",
      { rail: railId },
    );
  }

  const currentTotal = offerTotal(offer);
  if (currentTotal.currency !== verified.approvedTotal.currency) {
    return checkoutError(
      "currency_mismatch",
      `verified offer total is in ${verified.approvedTotal.currency}, not ${currentTotal.currency}`,
      { rail: railId },
    );
  }
  if (currentTotal.amount !== verified.approvedTotal.amount) {
    return checkoutError(
      "offer_total_mismatch",
      `current offer total ${currentTotal.amount} ${currentTotal.currency} does not equal the verified total ${verified.approvedTotal.amount} ${verified.approvedTotal.currency}`,
      {
        rail: railId,
        details: {
          currentTotal: currentTotal.amount,
          verifiedTotal: verified.approvedTotal.amount,
          currency: currentTotal.currency,
        },
      },
    );
  }
  return null;
}
