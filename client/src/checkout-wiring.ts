/**
 * Local checkout wiring for the client: the FILE nonce ledger is the DEFAULT
 * (checkout integration left it unwired) — mandate replay protection survives restarts and
 * excludes concurrent client instances via the ledger's O_EXCL markers.
 *
 * Rails, in priority order:
 *   1. ACP — for merchants explicitly mapped in NORTHCINDER_ACP_MERCHANTS. Payment
 *      is a DELEGATED opaque token (NORTHCINDER_ACP_PAYMENT_TOKEN); if none is
 *      configured the rail fails with a structured payment_token_unavailable —
 *      no card data exists anywhere in this codebase (spec §5).
 *   2. cart-permalink — own-session Shopify handoff (the user's own browser
 *      session and stored payment method complete the purchase).
 */
import { join } from "node:path";
import type { Offer } from "@northcinder/protocol";
import {
  createAcpRail,
  createCartPermalinkRail,
  createCheckoutOrchestrator,
  createFileNonceLedger,
  type AcpMerchantEndpoint,
  type CheckoutOrchestrator,
  type CheckoutRail,
} from "@northcinder/checkout";

export const NONCE_LEDGER_FILENAME = "nonces.jsonl";

export interface ClientCheckoutOptions {
  configDir: string;
  /** Public keys whose mandates the orchestrator accepts — normally exactly the local keystore key. */
  trustedPublicKeys: string[];
  acpMerchants?: Record<string, AcpMerchantEndpoint>;
  acpPaymentToken?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface ClientCheckout {
  orchestrator: CheckoutOrchestrator;
  /** The file-backed single-use nonce ledger path (default wiring). */
  ledgerPath: string;
  railIds: string[];
  /**
   * Which rail WOULD execute this offer (same priority order the
   * orchestrator uses; pure, no side effects) — lets the approval tuple
   * state the payment context honestly. Null when no rail can handle it.
   */
  railFor(offer: Offer): string | null;
}

export function createClientCheckout(options: ClientCheckoutOptions): ClientCheckout {
  const ledgerPath = join(options.configDir, NONCE_LEDGER_FILENAME);
  const ledger = createFileNonceLedger(ledgerPath);

  const rails: CheckoutRail[] = [];
  const merchants = options.acpMerchants ?? {};
  if (Object.keys(merchants).length > 0) {
    rails.push(
      createAcpRail({
        merchants,
        paymentTokenProvider: async () => {
          if (!options.acpPaymentToken) {
            throw new Error(
              "no delegated payment token configured (NORTHCINDER_ACP_PAYMENT_TOKEN) — northcinder only ever sends opaque delegated tokens, never card data",
            );
          }
          return { type: "spt", token: options.acpPaymentToken };
        },
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      }),
    );
  }
  rails.push(createCartPermalinkRail());

  const orchestrator = createCheckoutOrchestrator({
    rails,
    trustedPublicKeys: options.trustedPublicKeys,
    ledger,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  return {
    orchestrator,
    ledgerPath,
    railIds: rails.map((r) => r.id),
    railFor: (offer) => rails.find((r) => r.canHandle(offer))?.id ?? null,
  };
}
