/**
 * The explicit human approval gate (spec §4 invariant 4):
 *
 *   request_purchase_authorization  → PENDING authorization + human summary
 *   approve_purchase(code)          → mandate SIGNED, authorization approved
 *   decline_purchase                → authorization VOID (symmetric, guilt-free)
 *
 * The confirmation code is written to
 * `<configDir>/pending-authorizations/<id>.code` (0600). The standard MCP
 * runtime disables the optional STDERR banner because hosts commonly capture
 * child-process stderr. The tool result deliberately omits the code. Another
 * program the buyer runs under the same OS account can read buyer-local state;
 * separate accounts are an optional local hardening boundary.
 * Wrong-code attempts are bounded; pending authorizations expire.
 *
 * approval "sign what you see": both trusted channels render the FOUR-TUPLE
 * (merchant of record, exact item + variant, all-in total with an honest
 * unknown-tax statement, payment context per rail) plus an order fingerprint
 * displayed WITH the code. The fingerprint commits the code to the tuple —
 * approval recomputes it and rejects any tuple mutated after issuance — and
 * the mandate nonce is fixed at request time so the mandate signed at
 * approval is exactly the order the human saw fingerprinted.
 *
 * The purchase mandate is signed only AT APPROVAL TIME (issuance = the human
 * act), with the user's local ed25519 keypair, binding the exact offer digest,
 * quantity one, merchant, and a hard spending cap.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Money, Offer, PurchaseMandate } from "@northcinder/protocol";
import { issueMandate, offerTotal, type MandateKeypair } from "@northcinder/checkout";
import { BRAND_NAME } from "./brand.js";
import { runFsOp } from "./fs-error-sanitizer.js";
import {
  formatMoney,
  orderFingerprint,
  renderOrderTuple,
  VARIANT_ATTRIBUTE,
  type PaymentContext,
} from "./order-tuple.js";

export const DEFAULT_AUTHORIZATION_TTL_MS = 15 * 60_000;
export const DEFAULT_MAX_CODE_ATTEMPTS = 3;
export const PENDING_DIR = "pending-authorizations";

/** Unambiguous alphabet (no 0/O, 1/I/L) for a human-typed code. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export type AuthorizationStatus = "pending" | "approved" | "denied" | "expired" | "consumed";

export interface Authorization {
  id: string;
  status: AuthorizationStatus;
  offer: Offer;
  intent: string;
  maxAmount: Money;
  /** Which rail would execute the purchase — decides the tuple's payment-context line. */
  paymentContext: PaymentContext;
  createdAt: string;
  expiresAt: string;
  attemptsRemaining: number;
  /** Present iff status is "approved" or "consumed": the signed purchase mandate. */
  mandate?: PurchaseMandate;
}

export type ApprovalErrorCode =
  | "not_found"
  | "expired"
  | "code_mismatch"
  | "attempts_exhausted"
  | "already_approved"
  | "denied"
  | "tuple_mismatch";

export type ApprovalResult =
  | { ok: true; authorization: Authorization }
  | { ok: false; error: { code: ApprovalErrorCode; message: string; attemptsRemaining?: number } };

export type DeclineErrorCode = "not_found" | "already_consumed" | "checkout_in_progress";

export type DeclineResult =
  | { ok: true; authorization: Authorization }
  | { ok: false; error: { code: DeclineErrorCode; message: string } };

export interface RequestOutcome {
  authorization: Authorization;
  /** Human-readable summary for the USER (never contains the code). */
  summary: string;
  /** Where the out-of-band code was delivered. */
  codeDelivery: { file: string; stderr: boolean };
  /**
   * The display-binding order fingerprint shown WITH the code on the trusted
   * channels. NOT a secret and NEVER a substitute for the code — but it must
   * still not be relayed into tool results (display-binding only; the
   * existing leak tests assert its absence there).
   */
  fingerprint: string;
}

/**
 * local UI: everything the approval-page push (ntfy) may carry — the URL and the
 * display-binding fingerprint, deliberately NOT the code (the page collects
 * the code from the human; pushing the secret through a third-party push
 * relay would widen the trust boundary).
 */
export interface ApprovalRequestEvent {
  authorizationId: string;
  fingerprint: string;
  intent: string;
  expiresAt: string;
  /** Present when an approval page is being served this boot. */
  approvalUrl?: string;
}

export interface AuthorizationStoreOptions {
  keypair: MandateKeypair;
  configDir: string;
  /** Pending-authorization validity window (default 15 min). */
  ttlMs?: number;
  /** Wrong-code attempts before the authorization is voided (default 3). */
  maxCodeAttempts?: number;
  /** Signed-mandate validity window after approval (default: issueMandate's 15 min). */
  mandateTtlMs?: number;
  now?: () => Date;
  /** Suppress the optional stderr banner; the standard MCP runtime sets this to true. */
  quiet?: boolean;
  /**
   * local UI approval page ("one gate, two doors"): when set, the OUT-OF-BAND
   * buyer-local channels (code file and an optional low-level stderr banner)
   * additionally
   * carry this URL, where the human can review the same four-tuple and
   * approve/decline in a browser. The URL embeds the local UI session token,
   * so it inherits the code channels' secrecy discipline.
   */
  approvalUrl?: (authorizationId: string) => string | undefined;
  /**
   * local UI push hook: called after the out-of-band channels are written, so the
   * approval push (ntfy) can be sent. Must never make request() fail — a
   * throwing hook is contained.
   */
  onRequested?: (event: ApprovalRequestEvent) => void;
}

export interface AuthorizationStore {
  request(offer: Offer, opts: { intent: string; maxAmount?: Money; paymentContext?: PaymentContext }): RequestOutcome;
  /**
   * THE single approval gate ("one verify function, two doors"): the MCP
   * approve_purchase tool calls it today, and the local UI approval page must call
   * this same method — never a parallel verification path.
   */
  approve(authorizationId: string, confirmationCode: string): ApprovalResult;
  /**
   * Symmetric first-class decline: voids a pending (or approved-but-unused)
   * authorization. Idempotent; never a penalized outcome.
   */
  decline(authorizationId: string): DeclineResult;
  get(authorizationId: string): Authorization | undefined;
  /**
   * The ISSUANCE-time display-binding fingerprint (shown with the code on
   * every trusted channel). Display-only — never a secret, never a code.
   */
  fingerprintOf(authorizationId: string): string | undefined;
  /**
   * Marks a checkout attempt as EXECUTING for this authorization. While the
   * flag is set, decline() refuses honestly (the charge may already be
   * completing at the merchant — "nothing will be charged" would be a lie).
   * The caller MUST pair it with endCheckout()/markConsumed().
   */
  beginCheckout(authorizationId: string): void;
  /** Clears the in-flight flag set by beginCheckout(). */
  endCheckout(authorizationId: string): void;
  /** Marks an approved authorization consumed (one checkout attempt per mandate). */
  markConsumed(authorizationId: string): void;
}

function generateCode(): string {
  const bytes = randomBytes(8);
  let raw = "";
  for (const b of bytes) raw += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Case/hyphen-insensitive constant-time-ish comparison via digest equality. */
function codeMatches(presented: string, expected: string): boolean {
  const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const a = createHash("sha256").update(normalize(presented)).digest();
  const b = createHash("sha256").update(normalize(expected)).digest();
  return timingSafeEqual(a, b);
}

/** The decline copy — as prominent as the approval copy, and guilt-free. */
const DECLINE_CHANNEL_LINE =
  "To DECLINE: simply do not share the code — or tell your agent to decline. Declining is always available and costs nothing.";

export function buildAuthorizationSummary(auth: Authorization): string {
  const o = auth.offer;
  return [
    `PURCHASE AUTHORIZATION REQUESTED (${auth.id}) — status: PENDING, nothing has been bought.`,
    ``,
    `  Item:      ${o.product.title}`,
    `  Merchant:  ${o.merchant.name} (${o.merchant.id})`,
    `  Price:     ${formatMoney(o.price)}${o.shipping?.cost ? ` + shipping ${formatMoney(o.shipping.cost)}` : ""}`,
    `  Total:     ${formatMoney(offerTotal(o))} (price + known shipping; tax UNKNOWN at authorization — the final tax appears at merchant checkout)`,
    `  Hard cap:  ${formatMoney(auth.maxAmount)} (checkout is refused above this)`,
    `  Intent:    ${auth.intent}`,
    `  Expires:   ${auth.expiresAt}`,
    ``,
    `TO APPROVE: the HUMAN USER reads the one-time code from their buyer-local ${BRAND_NAME} approval`,
    `channel and provides it to approve_purchase. The standard runtime never returns or prints the code`,
    `through the AI application's MCP channel. Another program the buyer runs under the same OS account`,
    `can read the buyer's files; separate accounts are an optional local hardening choice. Never guess the code.`,
    ``,
    `TO DECLINE: equally simple and always available — the user says no (or says nothing), and the agent`,
    `calls decline_purchase to void this authorization. Declining is a normal outcome, never penalized.`,
  ].join("\n");
}

export function createAuthorizationStore(options: AuthorizationStoreOptions): AuthorizationStore {
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? DEFAULT_AUTHORIZATION_TTL_MS;
  const maxAttempts = options.maxCodeAttempts ?? DEFAULT_MAX_CODE_ATTEMPTS;
  const pendingDir = join(options.configDir, PENDING_DIR);

  // Pending authorizations are intentionally in-memory. After a process
  // restart no record/code binding survives, so leaving prior code files
  // behind would create an orphaned secret that looks actionable. Remove the
  // whole per-boot artifact directory before accepting new requests; a stale
  // code therefore cannot be approved or reused by the new process.
  runFsOp(() => rmSync(pendingDir, { recursive: true, force: true }), "pending authorization cleanup failed");

  interface InternalRecord {
    authorization: Authorization;
    code: string;
    codeFile: string;
    /** The mandate nonce, fixed at REQUEST time so the fingerprint commits to it. */
    nonce: string;
    /** Fingerprint over the canonical tuple AS DISPLAYED to the human. */
    fingerprint: string;
    /**
     * Private request-time snapshot of the WHOLE offer as displayed to the
     * human. approve() deep-compares the live offer against it (catches
     * mutation of ANY field — incl. product.id, variant gid, title — not
     * just the fingerprinted ones), and checkout reads THIS, never the
     * externally-reachable live object.
     */
    offerSnapshot: Offer;
    /** Snapshot of the cap shown on the trusted channels (mutation-detected at approve). */
    approvedCap: Money;
    /** Snapshot of the intent line the human read (mutation-detected at approve). */
    intentSnapshot: string;
    /** True while a checkout attempt is executing (decline is refused then). */
    checkoutInFlight: boolean;
  }
  const records = new Map<string, InternalRecord>();

  /** Fingerprint over the authorization's CURRENT tuple + the issuance nonce. */
  function currentFingerprint(auth: Authorization, nonce: string): string {
    const total = offerTotal(auth.offer);
    return orderFingerprint({
      merchantId: auth.offer.merchant.id,
      offerId: auth.offer.id,
      // Bind the PURCHASE-relevant identities, not just the offer id: the
      // ACP rail buys by product.id, cart-permalink by the variant gid.
      productId: auth.offer.product.id,
      variantKey: auth.offer.product.attributes[VARIANT_ATTRIBUTE] ?? "",
      totalMinor: total.amount,
      currency: total.currency,
      nonce,
    });
  }

  /**
   * Defensive read view (the CHECKOUT door): a deep clone whose offer and cap
   * come from the private request-time snapshots — approve-time truth, never
   * the externally-reachable live object. Post-approve mutation of a held
   * reference therefore cannot re-aim what checkout verifies or charges.
   */
  function snapshotView(record: InternalRecord): Authorization {
    return {
      ...structuredClone(record.authorization),
      offer: structuredClone(record.offerSnapshot),
      maxAmount: structuredClone(record.approvedCap),
      intent: record.intentSnapshot,
    };
  }

  function expireIfDue(record: InternalRecord): void {
    const auth = record.authorization;
    if (auth.status === "pending" && now().getTime() > new Date(auth.expiresAt).getTime()) {
      auth.status = "expired";
      rmSync(record.codeFile, { force: true });
    }
  }

  return {
    request(offer, opts) {
      const at = now();
      const id = `auth_${randomUUID()}`;
      // Own copies: the authorization's tuple must not alias caller-held
      // objects (a later caller-side mutation must not silently retarget it).
      const ownOffer = structuredClone(offer);
      const maxAmount = structuredClone(opts.maxAmount ?? offerTotal(offer));
      const paymentContext = opts.paymentContext ?? "none";
      const authorization: Authorization = {
        id,
        status: "pending",
        offer: ownOffer,
        intent: opts.intent,
        maxAmount,
        paymentContext,
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + ttlMs).toISOString(),
        attemptsRemaining: maxAttempts,
      };

      const code = generateCode();
      // The mandate nonce is fixed NOW so the fingerprint displayed with the
      // code commits to the exact mandate that approval will sign.
      const nonce = randomBytes(18).toString("base64url");
      const fingerprint = currentFingerprint(authorization, nonce);
      const codeFile = join(pendingDir, `${id}.code`);
      // Every buyer-local approval channel shows the FULL four-tuple the mandate will sign
      // (merchant of record, exact item + variant, all-in total with honest
      // unknown-tax statement, payment context) plus the hard cap the
      // (untrusted) host agent chose — "sign what you see".
      const tupleLines = renderOrderTuple(ownOffer, paymentContext);
      const capLine = `HARD SPENDING CAP: ${formatMoney(maxAmount)} — the agent may spend up to this amount`;
      // local UI second door: the approval-page URL rides the same buyer-local
      // channels as the code — never the tool result.
      const approvalUrl = options.approvalUrl?.(id);
      const approvalUrlLine =
        approvalUrl !== undefined ? `Or review & approve/decline in your browser: ${approvalUrl}` : undefined;
      // Fail CLOSED but never let the underlying fs error — which typically
      // embeds the absolute configDir/pending-authorizations path — reach a
      // tool-facing error string; request_purchase_authorization
      // calls this via deps.authorizations.request at server.ts).
      runFsOp(() => {
        mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
        writeFileSync(
          codeFile,
          [
            code,
            `# Authorization ${id} · order-fingerprint ${fingerprint}`,
            `# ${authorization.intent}`,
            ...tupleLines.map((line) => `# ${line}`),
            `# ${capLine}`,
            `# Give the first line of this file to your agent ONLY if you approve this purchase.`,
            ...(approvalUrlLine !== undefined ? [`# ${approvalUrlLine}`] : []),
            `# ${DECLINE_CHANNEL_LINE}`,
            ``,
          ].join("\n"),
          { mode: 0o600 },
        );
        chmodSync(codeFile, 0o600);
      }, "purchase authorization request failed: the confirmation code could not be written");

      if (!options.quiet) {
        // Optional low-level diagnostic mode only. The standard MCP runtime
        // sets quiet=true because hosts commonly capture child-process stderr.
        process.stderr.write(
          [
            ``,
            `┌─ ${BRAND_NAME} purchase approval ──────────────────────────────────────`,
            `│ ${authorization.intent}`,
            ...tupleLines.map((line) => `│ ${line}`),
            `│ ${capLine}`,
            `│ Authorization ${id}`,
            `│ CONFIRMATION CODE: ${code} · order-fingerprint ${fingerprint}`,
            `│ Give this code to your agent ONLY if you approve this purchase.`,
            ...(approvalUrlLine !== undefined ? [`│ ${approvalUrlLine}`] : []),
            `│ ${DECLINE_CHANNEL_LINE}`,
            `└─────────────────────────────────────────────────────────────────`,
            ``,
          ].join("\n"),
        );
      }

      records.set(id, {
        authorization,
        code,
        codeFile,
        nonce,
        fingerprint,
        offerSnapshot: structuredClone(ownOffer),
        approvedCap: structuredClone(maxAmount),
        intentSnapshot: opts.intent,
        checkoutInFlight: false,
      });
      // local UI push hook (best-effort, contained): the approval push must never
      // fail — or delay reporting — the authorization request itself.
      if (options.onRequested !== undefined) {
        try {
          options.onRequested({
            authorizationId: id,
            fingerprint,
            intent: authorization.intent,
            expiresAt: authorization.expiresAt,
            ...(approvalUrl !== undefined ? { approvalUrl } : {}),
          });
        } catch {
          process.stderr.write(
            `[${BRAND_NAME}] approval push hook failed (authorization ${id}): hook_error\n`,
          );
        }
      }
      return {
        authorization,
        summary: buildAuthorizationSummary(authorization),
        codeDelivery: { file: codeFile, stderr: !options.quiet },
        fingerprint,
      };
    },

    approve(authorizationId, confirmationCode) {
      const record = records.get(authorizationId);
      if (!record) {
        return { ok: false, error: { code: "not_found", message: `no authorization ${authorizationId}` } };
      }
      expireIfDue(record);
      const auth = record.authorization;

      if (auth.status === "approved" || auth.status === "consumed") {
        return {
          ok: false,
          error: { code: "already_approved", message: `authorization ${auth.id} was already approved — approval is single-shot` },
        };
      }
      if (auth.status === "expired") {
        return { ok: false, error: { code: "expired", message: `authorization ${auth.id} expired at ${auth.expiresAt}` } };
      }
      if (auth.attemptsRemaining <= 0) {
        return {
          ok: false,
          error: { code: "attempts_exhausted", message: `authorization ${auth.id} was voided after too many wrong codes — request a new one` },
        };
      }
      if (auth.status === "denied") {
        return { ok: false, error: { code: "denied", message: `authorization ${auth.id} was voided` } };
      }

      if (!codeMatches(confirmationCode, record.code)) {
        auth.attemptsRemaining -= 1;
        if (auth.attemptsRemaining <= 0) {
          auth.status = "denied";
          rmSync(record.codeFile, { force: true });
          return {
            ok: false,
            error: {
              code: "attempts_exhausted",
              message: `wrong confirmation code; authorization ${auth.id} is now VOID (attempt limit reached) — request a new authorization`,
              attemptsRemaining: 0,
            },
          };
        }
        return {
          ok: false,
          error: {
            code: "code_mismatch",
            message: `wrong confirmation code (${auth.attemptsRemaining} attempt(s) remaining) — ask the user to re-read it`,
            attemptsRemaining: auth.attemptsRemaining,
          },
        };
      }

      // "Sign what you see": the code the human typed committed to the tuple
      // displayed at REQUEST time (via the fingerprint's nonce). Recompute the
      // fingerprint over the CURRENT tuple AND deep-compare the WHOLE offer
      // against the private request-time snapshot — mutation of ANY offer
      // field since issuance (product retargeted, variant swapped, total
      // changed, even the title the human read), a raised cap, or a rewritten
      // intent line voids the authorization.
      const capIntact =
        auth.maxAmount.amount === record.approvedCap.amount &&
        auth.maxAmount.currency === record.approvedCap.currency;
      const offerIntact = isDeepStrictEqual(auth.offer, record.offerSnapshot);
      const intentIntact = auth.intent === record.intentSnapshot;
      if (
        currentFingerprint(auth, record.nonce) !== record.fingerprint ||
        !offerIntact ||
        !capIntact ||
        !intentIntact
      ) {
        auth.status = "denied";
        rmSync(record.codeFile, { force: true });
        return {
          ok: false,
          error: {
            code: "tuple_mismatch",
            message: `authorization ${auth.id} is VOID: its order details changed after the confirmation code was issued — the code no longer matches what the user saw. Request a fresh authorization`,
          },
        };
      }

      // The human act: sign the mandate NOW — with the nonce the displayed
      // fingerprint committed to, so the signed mandate IS the approved order.
      auth.mandate = issueMandate({
        keypair: options.keypair,
        offer: auth.offer,
        intent: auth.intent,
        maxAmount: auth.maxAmount,
        nonce: record.nonce,
        ...(options.mandateTtlMs !== undefined ? { ttlMs: options.mandateTtlMs } : {}),
        now,
      });
      auth.status = "approved";
      rmSync(record.codeFile, { force: true }); // one-time code, gone once used
      // Door symmetry (local UI): every door — approve, decline, get — returns the
      // same defensive snapshot view, never the live internal record.
      return { ok: true, authorization: snapshotView(record) };
    },

    decline(authorizationId) {
      const record = records.get(authorizationId);
      if (!record) {
        return { ok: false, error: { code: "not_found", message: `no authorization ${authorizationId}` } };
      }
      expireIfDue(record);
      const auth = record.authorization;
      if (record.checkoutInFlight) {
        // A charge may be COMPLETING at the merchant right now — refusing is
        // the only honest answer ("nothing will be charged" would be a lie).
        return {
          ok: false,
          error: {
            code: "checkout_in_progress",
            message: `a checkout attempt for authorization ${auth.id} is already executing and can no longer be declined — its outcome (success or failure) will be reported and audited`,
          },
        };
      }
      if (auth.status === "consumed") {
        return {
          ok: false,
          error: {
            code: "already_consumed",
            message: `authorization ${auth.id} already had its checkout attempt — there is nothing left to decline`,
          },
        };
      }
      // Pending and approved-but-unused authorizations are voided; declining
      // an already-void one (denied/expired) is a clean no-op. Declining is
      // always available and never a penalized outcome.
      if (auth.status === "pending" || auth.status === "approved") {
        auth.status = "denied";
        delete auth.mandate; // an unused mandate never leaves a declined authorization
        rmSync(record.codeFile, { force: true });
      }
      return { ok: true, authorization: snapshotView(record) };
    },

    get(authorizationId) {
      const record = records.get(authorizationId);
      if (!record) return undefined;
      expireIfDue(record);
      return snapshotView(record);
    },

    fingerprintOf(authorizationId) {
      return records.get(authorizationId)?.fingerprint;
    },

    beginCheckout(authorizationId) {
      const record = records.get(authorizationId);
      if (record) record.checkoutInFlight = true;
    },

    endCheckout(authorizationId) {
      const record = records.get(authorizationId);
      if (record) record.checkoutInFlight = false;
    },

    markConsumed(authorizationId) {
      const record = records.get(authorizationId);
      if (record) {
        record.checkoutInFlight = false;
        if (record.authorization.status === "approved") {
          record.authorization.status = "consumed";
        }
      }
    },
  };
}
