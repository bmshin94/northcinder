#!/usr/bin/env node
/**
 * LIVE verification of current Shopify UCP catalog legs (no credential needed,
 * but the buyer must provide their own UCP agent-profile URL).
 * Hits ≥2 real Shopify storefront /api/ucp/mcp endpoints, validates every
 * returned offer against the protocol OfferSchema, and prints evidence.
 *
 * Run from adapters/shopify after `pnpm -r build`:  pnpm live-check
 * Override stores/query/profile: SHOPIFY_MCP_SHOPS=www.x.com,www.y.com
 * SHOPIFY_UCP_AGENT_PROFILE_URL=https://agent.example/profile.json LIVE_QUERY="coffee" pnpm live-check
 */
import { OfferSchema } from "@northcinder/protocol";
import { createShopifyAdapter } from "../dist/index.js";

const shops = (process.env.SHOPIFY_MCP_SHOPS ?? "www.allbirds.com,www.rothys.com")
  .split(",").map((s) => s.trim()).filter(Boolean);
const query = process.env.LIVE_QUERY ?? "shoes";
const profileUrl = process.env.SHOPIFY_UCP_AGENT_PROFILE_URL;
if (!profileUrl) {
  console.error("[live-check] SHOPIFY_UCP_AGENT_PROFILE_URL is required for every Shopify UCP call");
  process.exit(1);
}

const adapter = createShopifyAdapter({ shops, globalCatalog: { profileUrl }, env: {} });
console.log(`[live-check] shops=${shops.join(", ")} query=${JSON.stringify(query)}`);

const result = await adapter.search({ text: query, maxResults: 5 }, { timeoutMs: 20000 });
if (!result.ok) {
  console.error(`[live-check] FAIL: search errored: [${result.error.code}] ${result.error.message}`);
  process.exit(1);
}
const perShop = new Map();
let invalid = 0;
for (const offer of result.offers) {
  const parsed = OfferSchema.safeParse(offer);
  if (!parsed.success) {
    invalid += 1;
    console.error(`[live-check] schema-INVALID offer ${offer.id}:`, parsed.error.issues);
    continue;
  }
  perShop.set(offer.merchant.domain, (perShop.get(offer.merchant.domain) ?? 0) + 1);
}
for (const offer of result.offers.slice(0, 6)) {
  console.log(
    `  - [${offer.merchant.domain}] ${offer.product.title} — ${offer.price.amount} ${offer.price.currency} minor units (${offer.availability})\n    ${offer.product.url}`,
  );
}
const shopsWithOffers = [...perShop.keys()];
console.log(`[live-check] ${result.offers.length} offers, all schema-valid: ${invalid === 0}, shops answering: ${shopsWithOffers.join(", ")}`);

// getOffer round-trip on the first live offer.
const first = result.offers[0];
if (first) {
  const fetched = await adapter.getOffer(first.id, { timeoutMs: 20000 });
  if (fetched.ok) {
    console.log(`[live-check] getOffer round-trip OK: ${fetched.offer.product.title} @ ${fetched.offer.price.amount} ${fetched.offer.price.currency}`);
  } else {
    console.error(`[live-check] getOffer round-trip FAILED: [${fetched.error.code}] ${fetched.error.message}`);
    process.exit(1);
  }
}

// Global Catalog honesty check: without a profile it must say not_configured.
const bare = createShopifyAdapter({ env: {} });
const unconfigured = await bare.search({ text: query }, { timeoutMs: 5000 });
if (!unconfigured.ok && unconfigured.error.code === "not_configured") {
  console.log("[live-check] Global Catalog without profile → structured not_configured ✓");
} else {
  console.error("[live-check] FAIL: unconfigured adapter did not report not_configured");
  process.exit(1);
}

if (invalid > 0 || shopsWithOffers.length < 2) {
  console.error(`[live-check] FAIL: need schema-valid offers from ≥2 shops (got ${shopsWithOffers.length})`);
  process.exit(1);
}
console.log("[live-check] PASS");
