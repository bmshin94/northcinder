// The mandate hard gate (spec §4 invariant 4) — client-side, open, auditable.
// NOTE: ./mandate/brand.js is deliberately NOT exported: the VerifiedMandate
// brand symbol stays module-private so only verifyMandate can produce one.
export * from "./mandate/canonical.js";
export * from "./mandate/keystore.js";
export * from "./mandate/nonce-ledger.js";
export * from "./mandate/issue.js";
export * from "./mandate/verify.js";

// Checkout rails (spec §5) + orchestrator.
export * from "./rails/rail.js";
export * from "./rails/acp.js";
export * from "./rails/cart-permalink.js";
export * from "./orchestrator.js";
