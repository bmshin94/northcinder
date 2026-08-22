/**
 * ACP client rail — a faithful minimal client of the open Agentic Commerce
 * Protocol checkout-session REST API, shaped against the published spec
 * (github.com/agentic-commerce-protocol, Apache-2.0, version 2026-04-17:
 * openapi.agentic_checkout.yaml + schema.agentic_checkout.json, fetched
 * 2026-07-04):
 *
 *   POST {base}/checkout_sessions            → 201 CheckoutSession
 *   POST {base}/checkout_sessions/{id}/complete → CheckoutSession(+order)
 *   POST {base}/checkout_sessions/{id}/cancel
 *
 * Required headers per the spec: Authorization (Bearer), Content-Type,
 * Idempotency-Key, API-Version. Payment is DELEGATED: the client sends only
 * an opaque credential token (`{type: "spt", token}`) — our types have no
 * field a card PAN could even occupy (spec §5: raw card data structurally
 * absent).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fetchWithBudget } from "@northcinder/adapter-kit";
import { AllowedHostSchema, requiresNativeRevalidation, validateCredentialedBaseUrl, type Money, type Offer } from "@northcinder/protocol";
import { offerTotal } from "../mandate/issue.js";
import { checkoutError, railExecutionRejection, type CheckoutRail, type RailContext, type RailResult } from "./rail.js";

export const ACP_API_VERSION = "2026-04-17";
export const ACP_RAIL_ID = "acp";
/** Honest agent self-identification for the allocated 0.2.0 release (same posture as the Amazon adapter's UA). */
export const ACP_USER_AGENT = "NorthCinderAgent/0.2 (automated shopping agent; buyer-loyal)";

/**
 * Delegated payment credential — the ONLY payment shape that exists in this
 * codebase. `token` is an opaque delegated token (e.g. a Stripe Shared
 * Payment Token); there is deliberately no field for a card number, expiry,
 * or CVC anywhere in these types.
 */
/** Detect 13–19 card digits anywhere in a purportedly opaque token. */
const RAW_PAN_PATTERN = /(?:^|\D)(?:\d[ -]?){12,18}\d(?!\d)/;

export const AcpPaymentCredentialSchema = z
  .object({
    type: z.enum(["spt", "vault_token"]),
    token: z.string().min(1),
  })
  .strict()
  .refine((credential) => !RAW_PAN_PATTERN.test(credential.token), {
    message: "delegated payment token must be opaque, not a raw card PAN",
    path: ["token"],
  });

export type AcpPaymentCredential = z.infer<typeof AcpPaymentCredentialSchema>;

export type AcpPaymentTokenProvider = (input: {
  checkoutSessionId: string;
  offer: Offer;
  maxAmount: Money;
}) => Promise<AcpPaymentCredential>;

export const AcpMerchantEndpointSchema = z
  .object({
    /** Base URL of the merchant's ACP implementation (no trailing slash). */
    baseUrl: z.string().min(1),
    /** Storefront domain this endpoint is authorized to serve. */
    merchantDomain: AllowedHostSchema.refine((domain) => !domain.includes("*"), {
      message: "merchantDomain must be one exact bare hostname, not a wildcard",
    }),
    /** Bearer API key for that merchant. */
    apiKey: z.string().min(1),
  })
  .strict()
  .superRefine((endpoint, context) => {
    const validated = validateCredentialedBaseUrl(endpoint.baseUrl, { allowLoopbackHttp: true });
    if (!validated.ok) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "ACP base URL must use HTTPS, except explicit loopback HTTP, and contain no credentials, query, or fragment",
      });
    }
  });
export type AcpMerchantEndpoint = z.infer<typeof AcpMerchantEndpointSchema>;

export interface AcpRailConfig {
  /** Offer.merchant.id → ACP endpoint. Only mapped merchants are handled. */
  merchants: Record<string, AcpMerchantEndpoint>;
  paymentTokenProvider: AcpPaymentTokenProvider;
  /**
   * ACP FulfillmentDetails passed through opaquely (name/email/phone/address
   * per the spec's FulfillmentDetails schema). Optional at session creation.
   */
  fulfillmentDetails?: Record<string, unknown>;
  /** ACP Buyer object sent on completion, passed through opaquely. */
  buyer?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

/** The subset of the ACP CheckoutSession this client consumes (extras ignored). */
const AcpSessionSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().regex(/^[a-zA-Z0-9_.:-]{1,64}$/),
  currency: z.string().regex(/^[a-zA-Z]{3}$/),
  totals: z.array(z.looseObject({ type: z.string(), amount: z.int() })).default([]),
  capabilities: z
    .looseObject({
      payment: z.looseObject({ handlers: z.array(z.looseObject({ id: z.string() })).default([]) }).optional(),
    })
    .optional(),
  messages: z.array(z.unknown()).default([]),
  order: z
    .looseObject({
      id: z.string().min(1),
      checkout_session_id: z.string(),
      permalink_url: z.string().optional(),
    })
    .optional(),
});

const AcpErrorSchema = z.looseObject({
  code: z.string().regex(/^[a-zA-Z0-9_.:-]{1,64}$/),
});

export function createAcpRail(config: AcpRailConfig): CheckoutRail {
  const fetchImpl = config.fetchImpl;

  function endpointFor(offer: Offer): AcpMerchantEndpoint | undefined {
    const parsed = AcpMerchantEndpointSchema.safeParse(config.merchants[offer.merchant.id]);
    if (!parsed.success) return undefined;
    return parsed.data.merchantDomain.toLowerCase() === offer.merchant.domain.toLowerCase()
      ? parsed.data
      : undefined;
  }

  async function post(
    endpoint: AcpMerchantEndpoint,
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    return fetchWithBudget(
      `${endpoint.baseUrl}${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${endpoint.apiKey}`,
          "content-type": "application/json",
          "api-version": ACP_API_VERSION,
          "idempotency-key": randomUUID(),
          "request-id": randomUUID(),
          "user-agent": ACP_USER_AGENT,
          timestamp: new Date().toISOString(),
        },
        body: JSON.stringify(body),
      },
      { timeoutMs, ...(signal !== undefined ? { signal } : {}), ...(fetchImpl !== undefined ? { fetchImpl } : {}) },
    );
  }

  function merchantErrorDetails(status: number, bodyText: string): Record<string, unknown> {
    try {
      const parsed = AcpErrorSchema.safeParse(JSON.parse(bodyText));
      if (parsed.success) return { httpStatus: status, merchantCode: parsed.data.code };
    } catch {
      // fall through
    }
    return { httpStatus: status };
  }

  return {
    id: ACP_RAIL_ID,

    canHandle(offer) {
      return !requiresNativeRevalidation(offer) && endpointFor(offer) !== undefined;
    },

    async execute(offer, verified, ctx): Promise<RailResult> {
      const rejection = railExecutionRejection(offer, verified, ACP_RAIL_ID);
      if (rejection !== null) return { ok: false, error: rejection };
      const endpoint = endpointFor(offer);
      if (!endpoint) {
        return {
          ok: false,
          error: checkoutError("not_configured", `no ACP endpoint configured for merchant ${offer.merchant.id}`, {
            rail: ACP_RAIL_ID,
          }),
        };
      }
      const maxAmount = verified.mandate.constraints.maxAmount;
      // Three sequential calls at most (create, complete, or create+cancel):
      // split the budget so no single call can eat the whole window.
      const perCall = Math.max(250, Math.floor(ctx.timeoutMs / 3));

      const fail = (code: Parameters<typeof checkoutError>[0], message: string, details?: Record<string, unknown>): RailResult => ({
        ok: false,
        error: checkoutError(code, message, { rail: ACP_RAIL_ID, ...(details !== undefined ? { details } : {}) }),
      });

      async function cancelBestEffort(sessionId: string): Promise<void> {
        await post(endpoint!, `/checkout_sessions/${sessionId}/cancel`, {}, perCall, ctx.signal).catch(() => {});
      }

      // 1. Create the checkout session.
      const createResult = await post(
        endpoint,
        "/checkout_sessions",
        {
          line_items: [{ id: offer.product.id, quantity: 1 }],
          currency: offer.price.currency.toLowerCase(),
          ...(config.fulfillmentDetails !== undefined ? { fulfillment_details: config.fulfillmentDetails } : {}),
        },
        perCall,
        ctx.signal,
      );
      if (!createResult.ok) {
        return fail("merchant_unreachable", `ACP merchant unreachable creating checkout session (${createResult.kind})`);
      }
      if (createResult.status >= 400) {
        return fail(
          "merchant_rejected",
          "ACP merchant rejected checkout session creation",
          merchantErrorDetails(createResult.status, createResult.bodyText),
        );
      }
      let session: z.infer<typeof AcpSessionSchema>;
      try {
        session = AcpSessionSchema.parse(JSON.parse(createResult.bodyText));
      } catch {
        return fail("invalid_merchant_response", "ACP merchant returned a malformed checkout session");
      }
      if (session.status !== "ready_for_payment") {
        await cancelBestEffort(session.id);
        return fail("merchant_rejected", "ACP checkout session is not ready for payment", {
          sessionStatus: session.status,
        });
      }

      // 2. "Sign what you see": the MERCHANT's own final total must EQUAL the
      //    approved total (offer price + known shipping — the number the human
      //    saw on the trusted channel), with ZERO tolerance. Any drift in
      //    either direction (a raised price, surprise tax, or a silently
      //    different item) cancels the session; the user must re-authorize at
      //    the true total. This subsumes the old ≤cap check: verification
      //    already guarantees approvedTotal ≤ cap.
      const approvedTotal = offerTotal(offer);
      const total = session.totals.find((t) => t.type === "total")?.amount;
      if (total === undefined) {
        await cancelBestEffort(session.id);
        return fail("invalid_merchant_response", "ACP checkout session carries no total");
      }
      if (session.currency.toUpperCase() !== approvedTotal.currency) {
        await cancelBestEffort(session.id);
        return fail(
          "currency_mismatch_at_checkout",
          `merchant session currency ${session.currency.toUpperCase()} does not match the approved total's ` +
            `currency ${approvedTotal.currency} — session canceled; re-authorize at the merchant's actual ` +
            `currency if it is acceptable`,
          {
            approvedTotal: approvedTotal.amount,
            merchantTotal: total,
            currency: approvedTotal.currency,
            sessionCurrency: session.currency.toUpperCase(),
          },
        );
      }
      if (total !== approvedTotal.amount) {
        await cancelBestEffort(session.id);
        return fail(
          "total_mismatch_at_checkout",
          `merchant total ${total} ${session.currency.toUpperCase()} does not equal the approved total ` +
            `${approvedTotal.amount} ${approvedTotal.currency} (zero tolerance) — session canceled; ` +
            `re-authorize at the merchant's actual total if it is acceptable`,
          {
            approvedTotal: approvedTotal.amount,
            merchantTotal: total,
            currency: approvedTotal.currency,
            sessionCurrency: session.currency.toUpperCase(),
          },
        );
      }

      // 3. Obtain the DELEGATED payment token (opaque; never a card PAN).
      let credential: AcpPaymentCredential;
      try {
        const provided = await config.paymentTokenProvider({
          checkoutSessionId: session.id,
          offer,
          maxAmount,
        });
        const parsedCredential = AcpPaymentCredentialSchema.safeParse(provided);
        if (!parsedCredential.success) {
          throw new Error("provider returned a non-opaque payment credential");
        }
        credential = parsedCredential.data;
      } catch {
        await cancelBestEffort(session.id);
        return fail(
          "payment_token_unavailable",
          "delegated payment token provider did not return a usable opaque credential",
        );
      }

      // 4. Complete the session.
      const handlerId = session.capabilities?.payment?.handlers[0]?.id;
      const completeResult = await post(
        endpoint,
        `/checkout_sessions/${session.id}/complete`,
        {
          ...(config.buyer !== undefined ? { buyer: config.buyer } : {}),
          payment_data: {
            ...(handlerId !== undefined ? { handler_id: handlerId } : {}),
            instrument: {
              type: "card",
              credential: { type: credential.type, token: credential.token },
            },
          },
        },
        perCall,
        ctx.signal,
      );
      if (!completeResult.ok) {
        return fail("merchant_unreachable", `ACP merchant unreachable completing checkout (${completeResult.kind})`, {
          checkoutSessionId: session.id,
        });
      }
      if (completeResult.status >= 400) {
        return fail(
          "merchant_rejected",
          "ACP merchant rejected checkout completion",
          {
            checkoutSessionId: session.id,
            ...merchantErrorDetails(completeResult.status, completeResult.bodyText),
          },
        );
      }
      let completed: z.infer<typeof AcpSessionSchema>;
      try {
        completed = AcpSessionSchema.parse(JSON.parse(completeResult.bodyText));
      } catch {
        return fail("invalid_merchant_response", "ACP merchant returned a malformed completion response", {
          checkoutSessionId: session.id,
        });
      }
      if (completed.status !== "completed" || completed.order === undefined) {
        return fail(
          "merchant_rejected",
          "ACP checkout completion did not produce an order",
          { checkoutSessionId: session.id, sessionStatus: completed.status },
        );
      }

      const finalTotal = completed.totals.find((t) => t.type === "total")?.amount ?? total;
      return {
        ok: true,
        status: "completed",
        evidence: {
          rail: "acp",
          merchantBaseUrl: endpoint.baseUrl,
          checkoutSessionId: session.id,
          orderId: completed.order.id,
          ...(completed.order.permalink_url !== undefined ? { permalinkUrl: completed.order.permalink_url } : {}),
          totalCharged: { amount: finalTotal, currency: maxAmount.currency },
        },
      };
    },
  };
}
