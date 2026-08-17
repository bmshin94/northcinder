/**
 * The VerifiedMandate brand symbol. This module is INTENTIONALLY not
 * re-exported from the package index, and the package `exports` map exposes
 * only the root entry point — so no consumer (runtime or type-level) can
 * obtain the symbol value and forge a VerifiedMandate. Only
 * `verifyMandate()` in ./verify.ts can attach it.
 */
export const VERIFIED_MANDATE_BRAND: unique symbol = Symbol("northcinder.checkout.verified-mandate");
