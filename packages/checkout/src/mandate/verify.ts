/**
 * The mandate hard gate (spec §4 invariant 4). `verifyMandate` is the ONLY
 * producer of `VerifiedMandate` — the brand symbol lives in a module that the
 * package never exports — so checkout rails, which demand a VerifiedMandate,
 * are unreachable without passing this verification. Every rejection is a
 * specific structured error, never a throw.
 */
import { createPublicKey, verify as edVerify } from "node:crypto";
import { PurchaseMandateSchema, requiresNativeRevalidation, type Money, type Offer, type PurchaseMandate } from "@northcinder/protocol";
import { VERIFIED_MANDATE_BRAND } from "./brand.js";
import {
  canonicalMandatePayload,
  BRIER_MANDATE_SIGNING_DOMAIN,
  LEGACY_MANDATE_SIGNING_DOMAIN,
  THENAGAIN_MANDATE_SIGNING_DOMAIN,
} from "./canonical.js";
import { offerTotal } from "./issue.js";
import type { NonceLedger } from "./nonce-ledger.js";

/**
 * Proof that a mandate passed the gate. Cannot be constructed outside
 * `verifyMandate` (the brand symbol is module-private to this package).
 */
export interface VerifiedMandate {
  readonly [VERIFIED_MANDATE_BRAND]: true;
  readonly mandate: PurchaseMandate;
  /** Exact offer total presented to and accepted by this verification. */
  readonly approvedTotal: Money;
  readonly verifiedAt: string;
}

export type MandateRejectionCode =
  | "malformed"
  | "native_revalidation_required"
  | "untrusted_key"
  | "signature_invalid"
  | "expired"
  | "offer_mismatch"
  | "merchant_mismatch"
  | "currency_mismatch"
  | "amount_exceeded"
  | "replayed"
  | "ledger_unavailable";

export interface MandateRejection {
  code: MandateRejectionCode;
  message: string;
  mandateId?: string;
}

export type MandateVerification =
  | { ok: true; verified: VerifiedMandate }
  | { ok: false; rejection: MandateRejection };

export interface VerifyMandateOptions {
  /**
   * Public keys (base64 SPKI) this verifier trusts — normally exactly the
   * user's local keystore key. A valid signature from any OTHER key is an
   * attacker re-signing, not authorization.
   */
  trustedPublicKeys: string[];
  /** Single-use replay protection; the nonce is consumed on success. */
  ledger: NonceLedger;
  now?: () => Date;
}

/**
 * Runtime half of the gate: every VerifiedMandate this verifier produces is
 * registered here by OBJECT IDENTITY. The type-level brand alone is
 * defeatable in-process (a cast, or recovering the symbol via
 * Object.getOwnPropertySymbols on a genuine VerifiedMandate); WeakSet
 * membership is not — rails and the orchestrator check it before acting.
 */
const verifiedRegistry = new WeakSet<VerifiedMandate>();

/** True iff this exact object was produced by verifyMandate in this process. */
export function isVerifiedMandate(value: VerifiedMandate): boolean {
  return verifiedRegistry.has(value);
}

function reject(code: MandateRejectionCode, message: string, mandateId?: string): MandateVerification {
  return { ok: false, rejection: { code, message, ...(mandateId !== undefined ? { mandateId } : {}) } };
}

function signatureValid(publicKeyB64: string, payload: Uint8Array, signatureB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(payload), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export async function verifyMandate(
  mandate: PurchaseMandate,
  offer: Offer,
  options: VerifyMandateOptions,
): Promise<MandateVerification> {
  const now = (options.now ?? (() => new Date()))();

  const parsed = PurchaseMandateSchema.safeParse(mandate);
  if (!parsed.success) {
    return reject("malformed", `mandate failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  const m = parsed.data;

  // Browser-reported facts are comparison inputs, not a merchant-verified
  // checkout capability. verifyMandate is the sole producer of a genuine
  // VerifiedMandate, so rejecting here prevents callers from bypassing the
  // orchestrator and invoking an exported rail directly. This must remain
  // before nonce consumption so an ineligible attempt cannot burn authority.
  if (requiresNativeRevalidation(offer)) {
    return reject(
      "native_revalidation_required",
      `offer ${offer.id} was reported by the buyer's browser agent and must be confirmed by a native store connection before checkout (${offer.product.url})`,
      m.id,
    );
  }

  if (!options.trustedPublicKeys.includes(m.signature.publicKey)) {
    return reject("untrusted_key", "mandate is signed by a key this verifier does not trust", m.id);
  }

  const payload = canonicalMandatePayload({
    id: m.id,
    intent: m.intent,
    offerId: m.constraints.offerId,
    merchantId: m.constraints.merchantId,
    maxAmountMinor: m.constraints.maxAmount.amount,
    currency: m.constraints.maxAmount.currency,
    issuedAt: m.issuedAt,
    expiresAt: m.expiresAt,
    nonce: m.nonce,
  });
  const compatibleSignature = [BRIER_MANDATE_SIGNING_DOMAIN, THENAGAIN_MANDATE_SIGNING_DOMAIN, LEGACY_MANDATE_SIGNING_DOMAIN]
    .some((domain) => signatureValid(
      m.signature.publicKey,
      canonicalMandatePayload({
        id: m.id, intent: m.intent, offerId: m.constraints.offerId, merchantId: m.constraints.merchantId,
        maxAmountMinor: m.constraints.maxAmount.amount, currency: m.constraints.maxAmount.currency,
        issuedAt: m.issuedAt, expiresAt: m.expiresAt, nonce: m.nonce,
      }, domain),
      m.signature.value,
    ));
  if (!signatureValid(m.signature.publicKey, payload, m.signature.value) && !compatibleSignature) {
    return reject("signature_invalid", "ed25519 signature does not match the canonical mandate payload", m.id);
  }

  if (now.getTime() > new Date(m.expiresAt).getTime()) {
    return reject("expired", `mandate expired at ${m.expiresAt}`, m.id);
  }

  if (offer.id !== m.constraints.offerId) {
    return reject("offer_mismatch", `mandate authorizes offer ${m.constraints.offerId}, not ${offer.id}`, m.id);
  }

  if (offer.merchant.id !== m.constraints.merchantId) {
    return reject(
      "merchant_mismatch",
      `mandate authorizes merchant ${m.constraints.merchantId}, not ${offer.merchant.id}`,
      m.id,
    );
  }

  const total = offerTotal(offer);
  if (total.currency !== m.constraints.maxAmount.currency) {
    return reject(
      "currency_mismatch",
      `offer is priced in ${total.currency} but the mandate cap is in ${m.constraints.maxAmount.currency}`,
      m.id,
    );
  }
  if (total.amount > m.constraints.maxAmount.amount) {
    return reject(
      "amount_exceeded",
      `offer total ${total.amount} ${total.currency} exceeds the signed cap ${m.constraints.maxAmount.amount} ${m.constraints.maxAmount.currency}`,
      m.id,
    );
  }

  // Everything else passed — consume the single-use nonce LAST so a failed
  // verification never burns the mandate. A ledger I/O failure FAILS CLOSED:
  // without a durable burn we must not authorize (structured, never a throw).
  let consumed: boolean;
  try {
    consumed = await options.ledger.consume(m.nonce, { mandateId: m.id });
  } catch (cause) {
    return reject(
      "ledger_unavailable",
      `nonce ledger unavailable — failing closed, purchase not authorized: ${cause instanceof Error ? cause.message : String(cause)}`,
      m.id,
    );
  }
  if (!consumed) {
    return reject("replayed", "mandate nonce has already been used — a mandate authorizes exactly one purchase", m.id);
  }

  const verified: VerifiedMandate = {
    [VERIFIED_MANDATE_BRAND]: true,
    mandate: m,
    approvedTotal: total,
    verifiedAt: now.toISOString(),
  };
  verifiedRegistry.add(verified);
  return { ok: true, verified };
}
