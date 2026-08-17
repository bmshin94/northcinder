/**
 * Env-driven adapter registry (client integration): the service entry point registers
 * the five REAL store adapters unconditionally. Each adapter owns its own
 * graceful degradation — an unconfigured store answers every search with a
 * structured `not_configured` StoreError that surfaces in `storeStatuses`,
 * never a fake result and never a boot failure (shared contract:
 * live-by-default, fixture/key-gated, "not configured" reported honestly).
 *
 * Env consumed (all optional):
 *   SHOPIFY_MCP_SHOPS               comma-separated storefront MCP hosts (live, no auth)
 *   SHOPIFY_UCP_AGENT_PROFILE_URL   HTTPS URL of buyer-controlled UCP agent-profile JSON —
 *                                   enables the cross-merchant Global Catalog leg
 *                                   (anonymous tier; no key needed for catalog reads)
 *   SHOPIFY_GLOBAL_CATALOG_API_KEY  optional Dev-Dashboard bearer (higher rate tier)
 *   SHOPIFY_GLOBAL_CATALOG_MCP_URL  Global Catalog endpoint override
 *   EBAY_CLIENT_ID / EBAY_CLIENT_SECRET / EBAY_ENV / EBAY_MARKETPLACE_ID
 *   ETSY_API_KEY                    Etsy Open API v3 keystring
 *   AMAZON_SESSION_PROFILE          path to the USER'S OWN browser profile (spec §3A)
 *   WOOCOMMERCE_STORE_HOSTS         comma-separated WooCommerce store hosts
 *                                   (public Store API, live, no auth)
 *   NORTHCINDER_DEMO_SPONSORED_ADAPTER   "1" → also register the synthetic demo
 *                                   sponsored adapter (clearly labeled; demos only)
 */
import type { StoreAdapter } from "@northcinder/protocol";
import { createShopifyAdapter } from "@northcinder/adapter-shopify";
import { createEbayAdapter } from "@northcinder/adapter-ebay";
import { createEtsyAdapter } from "@northcinder/adapter-etsy";
import { createAmazonAdapter } from "@northcinder/adapter-amazon";
import { createWoocommerceAdapter } from "@northcinder/adapter-woocommerce";
import { createDemoSponsoredAdapter } from "./demo/sponsored-demo-adapter.js";

export type EnvSource = Record<string, string | undefined>;

export function buildAdaptersFromEnv(env: EnvSource): StoreAdapter[] {
  const adapters: StoreAdapter[] = [
    createShopifyAdapter({ env }),
    createEbayAdapter({ env }),
    createEtsyAdapter({ env }),
    createAmazonAdapter({ env }),
    createWoocommerceAdapter({ env }),
  ];
  if (env.NORTHCINDER_DEMO_SPONSORED_ADAPTER === "1") {
    adapters.push(createDemoSponsoredAdapter());
  }
  return adapters;
}
