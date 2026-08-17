#!/usr/bin/env node
/**
 * Env-gated LIVE check against the WooCommerce Store API. Requires
 * WOOCOMMERCE_STORE_HOSTS (comma-separated storefront hostnames). Without it,
 * skips honestly — the Store API is public/unauthenticated, so any real
 * WooCommerce store host works.
 */
import { OfferSchema } from "@northcinder/protocol";
import { createWoocommerceAdapter } from "../dist/index.js";

if (!process.env.WOOCOMMERCE_STORE_HOSTS) {
  console.log("[live-check] WOOCOMMERCE_STORE_HOSTS not configured — skipping live check honestly.");
  process.exit(0);
}
const adapter = createWoocommerceAdapter({});
const result = await adapter.search({ text: process.env.LIVE_QUERY ?? "chair", maxResults: 5 }, { timeoutMs: 20000 });
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
