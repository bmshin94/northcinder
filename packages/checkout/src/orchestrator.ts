/**
 * Checkout orchestrator: the single entry point for completing a purchase.
 *
 * Ordering (invariant #4 made structural):
 *   0. Reject agent-observed offers before any checkout rail sees them.
 *   1. Rail selection by offer capability — PURE, no side effects, so an
 *      offer no rail can handle never burns the mandate's single-use nonce.
 *   2. Mandate verification — the hard gate; consumes the nonce on success.
 *   3. Rail execution — only reachable with the VerifiedMandate produced in
 *      step 2 (enforced by the type system, not just this function's order).
 *
 * A mandate authorizes exactly ONE checkout ATTEMPT: if the rail fails after
 * verification, the nonce stays consumed and the user must re-authorize —
 * failing safe (never double-spending authority) over failing convenient.
 */
import { randomUUID } from "node:crypto";
import { requiresNativeRevalidation, type Offer, type PurchaseMandate } from "@northcinder/protocol";
import type { NonceLedger } from "./mandate/nonce-ledger.js";
import { isVerifiedMandate, verifyMandate, type MandateRejection } from "./mandate/verify.js";
import { checkoutError, type CheckoutError, type CheckoutRail, type RailContext, type RailEvidence } from "./rails/rail.js";

/** Durable record of an authorized checkout, citing the mandate that gated it. */
export interface OrderRecord {
  orderId: string;
  createdAt: string;
  offerId: string;
  merchantId: string;
  /** Canonical merchant domain paired with merchantId to avoid local-history collisions. */
  merchantDomain: string;
  railId: string;
  /** "completed" = purchase made by the rail; "handed_off" = user's own session completes it. */
  status: "completed" | "handed_off";
  /** The mandate that authorized this checkout (cited in full for audit). */
  mandateId: string;
  mandate: PurchaseMandate;
  evidence: RailEvidence;
}

export type CheckoutOutcome =
  | { ok: true; order: OrderRecord }
  | { ok: false; stage: "mandate"; error: MandateRejection }
  | { ok: false; stage: "rail"; error: CheckoutError };

export interface CheckoutOrchestratorOptions {
  /** Rails in priority order; the first whose canHandle(offer) passes wins. */
  rails: CheckoutRail[];
  /** Public keys (base64 SPKI) whose mandates this orchestrator accepts. */
  trustedPublicKeys: string[];
  /** Single-use nonce ledger shared across checkouts. */
  ledger: NonceLedger;
  now?: () => Date;
}

export interface CheckoutOrchestrator {
  completeCheckout(offer: Offer, mandate: PurchaseMandate, ctx: RailContext): Promise<CheckoutOutcome>;
}

export function createCheckoutOrchestrator(options: CheckoutOrchestratorOptions): CheckoutOrchestrator {
  const now = options.now ?? (() => new Date());
  return {
    async completeCheckout(offer, mandate, ctx) {
      // Browser observations are comparison inputs, not merchant-verified
      // checkout facts. This guard intentionally precedes even canHandle so
      // no checkout rail receives an agent-observed offer in any capacity.
      if (requiresNativeRevalidation(offer)) {
        return {
          ok: false,
          stage: "rail",
          error: checkoutError(
            "native_revalidation_required",
            "this offer was reported by the buyer's browser agent and must be confirmed by a native store connection before checkout",
            { details: { productUrl: offer.product.url } },
          ),
        };
      }

      // 1. Capability-based rail selection (pure — never burns the mandate).
      //    canHandle is documented as never throwing, but we defend against
      //    one that does anyway: a throw here must degrade to a structured
      //    "rail" stage error, not an uncaught exception out of this
      //    function (and, critically, it happens BEFORE the nonce is
      //    consumed, so the mandate survives to be retried).
      let rail: CheckoutRail | undefined;
      try {
        rail = options.rails.find((candidate) => candidate.canHandle(offer));
      } catch (cause) {
        return {
          ok: false,
          stage: "rail",
          error: checkoutError("internal", `rail selection threw: ${cause instanceof Error ? cause.message : String(cause)}`),
        };
      }
      if (rail === undefined) {
        return {
          ok: false,
          stage: "rail",
          error: checkoutError("no_rail", `no checkout rail can handle offer ${offer.id} (store: ${offer.sourceStore})`),
        };
      }

      // 2. The mandate hard gate. This is the ONLY producer of the
      //    VerifiedMandate the rail's signature demands. verifyMandate itself
      //    never throws; the belt-and-braces catch keeps completeCheckout
      //    structured (failing closed) even against an unexpected throw.
      let verification;
      try {
        verification = await verifyMandate(mandate, offer, {
          trustedPublicKeys: options.trustedPublicKeys,
          ledger: options.ledger,
          now,
        });
      } catch (cause) {
        return {
          ok: false,
          stage: "mandate",
          error: {
            code: "ledger_unavailable",
            message: `mandate verification failed closed: ${cause instanceof Error ? cause.message : String(cause)}`,
            mandateId: mandate.id,
          },
        };
      }
      if (!verification.ok) {
        return { ok: false, stage: "mandate", error: verification.rejection };
      }

      // 3. Execute the rail — after asserting the runtime registry agrees the
      //    object really came from verifyMandate (belt-and-braces; rails
      //    re-check this themselves).
      if (!isVerifiedMandate(verification.verified)) {
        return {
          ok: false,
          stage: "rail",
          error: checkoutError("unverified_mandate", "verified mandate failed the runtime registry check"),
        };
      }
      let result;
      try {
        result = await rail.execute(offer, verification.verified, ctx);
      } catch (cause) {
        // Rails must not throw; if one does anyway, degrade to a structured error.
        result = {
          ok: false as const,
          error: checkoutError("internal", `rail ${rail.id} threw: ${cause instanceof Error ? cause.message : String(cause)}`, {
            rail: rail.id,
          }),
        };
      }
      if (!result.ok) {
        return { ok: false, stage: "rail", error: result.error };
      }

      return {
        ok: true,
        order: {
          orderId: `order_${randomUUID()}`,
          createdAt: now().toISOString(),
          offerId: offer.id,
          merchantId: offer.merchant.id,
          merchantDomain: offer.merchant.domain,
          railId: rail.id,
          status: result.status,
          mandateId: verification.verified.mandate.id,
          mandate: verification.verified.mandate,
          evidence: result.evidence,
        },
      };
    },
  };
}
