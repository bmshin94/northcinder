#!/usr/bin/env node
/**
 * Env-gated LIVE check against the eBay Buy Browse SANDBOX. Requires
 * EBAY_CLIENT_ID / EBAY_CLIENT_SECRET (any dev account's sandbox keypair).
 * Without keys it reports "not configured" and exits 0 — it never fakes.
 */
import { OfferSchema } from "@northcinder/protocol";
import { createEbayAdapter } from "../dist/index.js";

if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) {
  console.log("[live-check] eBay keys not configured (EBAY_CLIENT_ID/EBAY_CLIENT_SECRET) — skipping live check honestly.");
  process.exit(0);
}
const adapter = createEbayAdapter({ environment: process.env.EBAY_ENV === "production" ? "production" : "sandbox" });
const result = await adapter.search({ text: process.env.LIVE_QUERY ?? "headphones", maxResults: 5 }, { timeoutMs: 20000 });
if (!result.ok) {
  console.error(`[live-check] FAIL: [${result.error.code}] ${result.error.message}`);
  process.exit(1);
}
let invalid = 0;
for (const offer of result.offers) {
  if (!OfferSchema.safeParse(offer).success) invalid += 1;
  console.log(`  - ${offer.product.title} — ${offer.price.amount} ${offer.price.currency} (${offer.merchant.name})`);
}
console.log(`[live-check] ${result.offers.length} offers, schema-valid: ${invalid === 0}`);
process.exit(invalid === 0 && result.offers.length > 0 ? 0 : 1);
