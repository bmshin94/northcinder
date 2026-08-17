# @northcinder/checkout — purchase authorization (the invariant-#4 hard gate) + checkout rails

The open, auditable half of checkout (spec §2/§5): anyone can read this package and verify
that **no code path completes a purchase without an explicit, per-purchase, cryptographically
signed user mandate** — the Perplexity-lawsuit failure mode. The gate is enforced at three
layers (compile-time type brand, runtime verifier registry, cross-process single-use nonce
markers) as defense-in-depth, not merely policy.

**Honest scope:** this is a gate on purchase *paths*, not a sandbox against hostile code.
Code running in the same process — or anything with read access to the user's key file —
can mint genuine mandates or patch this package. The guarantee is that no *accidental or
architectural* path (a buggy agent, a confused tool call, a rail invoked directly) can
complete a purchase without a verified, single-use, per-purchase mandate.

## The mandate hard gate (spec §4 invariant 4)

- **Keypair:** a local ed25519 keypair is generated on first run into the user's config dir
  (`NORTHCINDER_CONFIG_DIR` → `$XDG_CONFIG_HOME/northcinder` → `~/.config/northcinder`), file mode `0600`.
  The private key never leaves `keystore.ts`.
- **Issuance:** `issueMandate` signs the canonical payload
  `{id, intent, offer id, merchant, max amount+currency, issuedAt, expiry, nonce}` (a
  deterministic order-fixed JSON array under a versioned domain tag). Mandates are
  AP2-shaped (signed intent mandates per github.com/google-agentic-commerce/AP2) — **not**
  a full W3C verifiable-credential implementation (MVP; recorded as a design decision).
- **Verification:** `verifyMandate` is the ONLY producer of the `VerifiedMandate` type —
  its brand symbol lives in a module the package never exports. Rails **require** a
  `VerifiedMandate`, so checkout without verification does not typecheck
  (`test/invariant4.test-d.ts` keeps that guarantee under `vitest --typecheck`).
  Because a type brand alone is defeatable in-process (a cast, or recovering the symbol
  from a genuine object via `Object.getOwnPropertySymbols`), the verifier also registers
  every `VerifiedMandate` in a package-private **WeakSet registry**; both rails and the
  orchestrator check membership at runtime and refuse forged objects with a structured
  `unverified_mandate` error. Each verification rejection is a specific structured error:
  `malformed`, `untrusted_key`, `signature_invalid`, `expired`, `offer_mismatch`,
  `merchant_mismatch`, `currency_mismatch`, `amount_exceeded`, `replayed`,
  `ledger_unavailable` (ledger I/O failure — fails closed, never a throw).
- **Single-use, cross-process:** the file nonce ledger's commit point is an atomic
  `O_EXCL` per-nonce marker file (`<ledger>.markers/<sha256>`, `0600`) — exactly one
  ledger instance or process on the filesystem can consume a nonce; the JSONL file stays
  as the append-only audit log. One mandate = one checkout ATTEMPT; a failed rail does not
  refund the nonce (fail-safe: re-authorize, never double-spend authority). A failed
  verification never burns the nonce.

## Rails (spec §5 — neutral client of open rails; raw card data structurally absent)

- **ACP client rail** (`createAcpRail`): client of the open Agentic Commerce Protocol
  checkout-session REST API (Apache-2.0, github.com/agentic-commerce-protocol, version
  `2026-04-17`): `POST /checkout_sessions`, `.../complete`, `.../cancel`, with the required
  `Authorization`/`API-Version`/`Idempotency-Key`/`Content-Type` headers. Payment is
  **delegated**: the client transmits only an opaque credential token
  (`{type: "spt", token}`); there is no field in this package's types where a card PAN,
  expiry, or CVC could exist. The rail also re-checks the merchant's own final total
  (tax/shipping included) against the mandate cap and cancels the session if it exceeds it.
  Tested end-to-end against the in-repo mock ACP merchant (`test/mock-acp-merchant.ts`),
  which additionally rejects any 13–19-digit run in a completion body as a raw PAN.
- **Own-session rail** (`createCartPermalinkRail`): builds a Shopify cart permalink
  (`https://<shop>/cart/<variant>:<qty>`) and hands off to the **user's own browser
  session**, where their own stored payment method completes the purchase — the
  "non-cooperative / user's own account" path. No payment data ever exists here.
  Live evidence: `node scripts/live-cart-permalink.mjs` (headless GET, no purchase).

## Orchestrator

`createCheckoutOrchestrator({rails, trustedPublicKeys, ledger}).completeCheckout(offer, mandate, ctx)`:
pure capability-based rail selection first (an unroutable offer never burns a mandate),
then the mandate gate, then rail execution. Returns an `OrderRecord` citing the mandate
(id + full mandate) plus rail evidence, or a structured stage-tagged error. Never throws.

## Fidelity notes (honesty about inferred fields)

The ACP client is shaped against the published 2026-04-17 OpenAPI/JSON-schema/examples
(fetched 2026-07-04). Fields we exercise against the real schema: paths, required headers,
`line_items[{id,quantity}]`, `currency`, `fulfillment_details`, session `status`/`totals`/
`capabilities.payment.handlers`, `payment_data.{handler_id,instrument.credential{type,token}}`,
`order.{id,checkout_session_id,permalink_url}`, and the `Error{type,code,message}` envelope.
Inferred/simplified for MVP: single-quantity single-line-item carts, first-handler
selection, `instrument.type: "card"` fixed, and no 3DS/intervention flows (the
`authentication_required` status is treated as `merchant_rejected`).
