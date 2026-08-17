#!/usr/bin/env node
/**
 * Env-gated LIVE check against Etsy Open API v3. Requires ETSY_API_KEY
 * (an APPROVED app keystring — new registrations sit "pending approval"
 * until manually reviewed). Without a key it skips honestly.
 */
import { OfferSchema } from "@northcinder/protocol";
import { createEtsyAdapter } from "../dist/index.js";

if (!process.env.ETSY_API_KEY) {
  console.log("[live-check] ETSY_API_KEY not configured — skipping live check honestly (app approval is manual at Etsy).");
  process.exit(0);
}
const adapter = createEtsyAdapter({});
const result = await adapter.search({ text: process.env.LIVE_QUERY ?? "handmade lamp", maxResults: 5 }, { timeoutMs: 20000 });
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
