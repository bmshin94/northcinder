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

export type DiscoverySourceStatus = "ready" | "not_configured" | "invalid_configuration";

export interface DiscoverySourceReadiness {
  store: "amazon" | "ebay" | "etsy" | "shopify" | "woocommerce";
  status: DiscoverySourceStatus;
}

const present = (value: string | undefined): boolean => value !== undefined && value.trim() !== "";

/** Derive adapter configuration readiness without making provider or product
 * requests. "ready" means locally sufficient configuration is present; it
 * does not claim that a third-party credential or endpoint is live. */
export function discoverySourcesFromEnv(env: EnvSource): DiscoverySourceReadiness[] {
  const amazon: DiscoverySourceReadiness = {
    store: "amazon",
    status: present(env.AMAZON_SESSION_PROFILE) ? "ready" : "not_configured",
  };

  const ebayId = present(env.EBAY_CLIENT_ID);
  const ebaySecret = present(env.EBAY_CLIENT_SECRET);
  const ebayEnvironmentValid =
    env.EBAY_ENV === undefined || env.EBAY_ENV === "" || env.EBAY_ENV === "sandbox" || env.EBAY_ENV === "production";
  const ebay: DiscoverySourceReadiness = {
    store: "ebay",
    status:
      ebayId !== ebaySecret || !ebayEnvironmentValid
        ? "invalid_configuration"
        : ebayId
          ? "ready"
          : "not_configured",
  };

  const etsy: DiscoverySourceReadiness = {
    store: "etsy",
    status: present(env.ETSY_API_KEY) ? "ready" : "not_configured",
  };

  let shopifyStatus: DiscoverySourceStatus;
  try {
    createShopifyAdapter({ env });
    if (present(env.SHOPIFY_UCP_AGENT_PROFILE_URL)) {
      const profile = new URL(env.SHOPIFY_UCP_AGENT_PROFILE_URL!);
      shopifyStatus = profile.protocol === "https:" && !profile.username && !profile.password
        ? "ready"
        : "invalid_configuration";
    } else {
      shopifyStatus = (env.SHOPIFY_MCP_SHOPS ?? "").split(",").some((shop) => shop.trim() !== "")
        ? "invalid_configuration"
        : "not_configured";
    }
  } catch {
    shopifyStatus = "invalid_configuration";
  }
  const shopify: DiscoverySourceReadiness = { store: "shopify", status: shopifyStatus };

  let woocommerceStatus: DiscoverySourceStatus;
  try {
    createWoocommerceAdapter({ env });
    woocommerceStatus = (env.WOOCOMMERCE_STORE_HOSTS ?? "").split(",").some((host) => host.trim() !== "")
      ? "ready"
      : "not_configured";
  } catch {
    woocommerceStatus = "invalid_configuration";
  }
  const woocommerce: DiscoverySourceReadiness = { store: "woocommerce", status: woocommerceStatus };

  return [amazon, ebay, etsy, shopify, woocommerce];
}

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
