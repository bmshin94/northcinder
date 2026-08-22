# @northcinder/checkout

NorthCinder separates shopping decisions from purchase authority. This package issues and verifies a versioned, signed mandate for one exact offer and then routes the verified purchase through a supported checkout rail.

## Exact purchase mandate

The current wire contract is version 2. Its signature covers the buyer's intent, spending cap, expiry, single-use nonce, quantity one, and a SHA-256 digest of the complete purchase-relevant offer identity. That digest includes the source store, offer and product identity, exact variant and normalized attributes, merchant identity and domain, price, known shipping and landed-cost facts, condition, and acquisition provenance.

Version 1 and former signing domains fail closed because they did not bind enough of the offer. Old order records can still be displayed, but they do not regain purchase authority.

`verifyMandate` checks the trusted local public key, signature, expiry, exact offer digest, merchant, currency, cap, and nonce before it produces a `VerifiedMandate`. Failed verification does not consume the nonce. Successful verification records an atomic per-nonce marker, so two processes sharing the same config directory cannot use the same mandate twice.

The local key and nonce files use owner-only permissions. This is not a sandbox against software running as the same OS user. A process with access to the private key or the ability to patch the runtime can act with that user's authority, so buyers should grant local file access deliberately.

## Checkout rails

### ACP

`createAcpRail` implements the Agentic Commerce Protocol checkout-session flow. Each configured endpoint names both the merchant id map key and an explicit `merchantDomain`. The domain must match the offer before any request or payment-token provider call. Endpoint URLs require HTTPS, except for explicit loopback HTTP, and cannot contain URL credentials, a query, or a fragment.

ACP payment uses an opaque delegated credential such as an SPT or vault token. Raw card numbers and raw verification fields are rejected. Merchant response text is not returned to the MCP host or stored in the audit; callers receive fixed messages with bounded HTTP status and merchant code fields.

### Buyer-session cart handoff

`createCartPermalinkRail` prepares a Shopify cart URL for quantity one. The buyer finishes in their own browser session with their own stored payment method. NorthCinder does not receive payment data on this path.

Both exported rails recompute the exact offer digest before network activity or cart handoff. A rail cannot reuse a mandate verified for a substituted store, product, variant, merchant domain, or price.

## Orchestrator and records

`createCheckoutOrchestrator({ rails, trustedPublicKeys, ledger })` selects a compatible rail, verifies the mandate, and executes the rail. A successful result returns an `OrderRecord` that cites the complete mandate and rail evidence. Errors are structured and fail closed.

The exported `@northcinder/checkout/mock-acp-merchant` entry is an offline example and test utility. It is not a hosted merchant or production service.
