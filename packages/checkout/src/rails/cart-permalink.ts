/**
 * Own-session rail (spec §5, the "non-cooperative / user's own account"
 * path): build a Shopify cart permalink — https://<shop>/cart/<variant>:<qty>
 * — and HAND IT OFF to the user's own browser session, where THEIR stored
 * payment method completes the purchase. This rail never transmits payment
 * data and never completes a purchase itself; the mandate gate still applies
 * (the type system requires a VerifiedMandate to reach it), and the order
 * record cites the mandate that authorized the handoff.
 *
 * Price honesty on this rail (approval four-tuple contract): the user SEES THE
 * FINAL TOTAL — including any tax — at the merchant's own checkout page
 * before paying, in their own browser session. No charge can happen at a
 * number the user hasn't seen; the approval tuple states this explicitly
 * ("your payment method at merchant checkout").
 */
import { requiresNativeRevalidation, type Offer } from "@northcinder/protocol";
import { checkoutError, railExecutionRejection, type CheckoutRail, type RailResult } from "./rail.js";

export const CART_PERMALINK_RAIL_ID = "cart-permalink";

/**
 * Offer attribute carrying the Shopify variant gid
 * (gid://shopify/ProductVariant/<numeric id>). Written by
 * @northcinder/adapter-shopify; the literal must stay in sync with it.
 */
export const SHOPIFY_VARIANT_ATTRIBUTE = "shopify:variantGid";

const VARIANT_GID_PATTERN = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/;

/** Numeric variant id from the offer's variant-gid attribute, or null. */
export function extractVariantId(offer: Offer): string | null {
  const gid = offer.product.attributes[SHOPIFY_VARIANT_ATTRIBUTE];
  if (gid === undefined) return null;
  const match = gid.match(VARIANT_GID_PATTERN);
  return match ? match[1]! : null;
}

/** Shopify cart permalink for the offer, or null when it cannot be built. */
export function buildCartPermalink(offer: Offer, quantity = 1): string | null {
  const variantId = extractVariantId(offer);
  if (variantId === null) return null;
  return `https://${offer.merchant.domain}/cart/${variantId}:${quantity}`;
}

export function createCartPermalinkRail(): CheckoutRail {
  return {
    id: CART_PERMALINK_RAIL_ID,

    canHandle(offer) {
      return (
        !requiresNativeRevalidation(offer) &&
        offer.sourceStore === "shopify" &&
        extractVariantId(offer) !== null
      );
    },

    async execute(offer, verified, _ctx): Promise<RailResult> {
      const rejection = railExecutionRejection(offer, verified, CART_PERMALINK_RAIL_ID);
      if (rejection !== null) return { ok: false, error: rejection };
      const variantId = extractVariantId(offer);
      const cartUrl = buildCartPermalink(offer);
      if (variantId === null || cartUrl === null) {
        return {
          ok: false,
          error: checkoutError(
            "not_configured",
            `offer ${offer.id} carries no usable Shopify variant gid ("${SHOPIFY_VARIANT_ATTRIBUTE}" attribute)`,
            { rail: CART_PERMALINK_RAIL_ID },
          ),
        };
      }
      return {
        ok: true,
        status: "handed_off",
        evidence: { rail: "cart-permalink", cartUrl, variantId, quantity: 1 },
      };
    },
  };
}
