import {
  AllowedHostSchema,
  storeError,
  type AdapterContext,
  type AdapterManifest,
  type AdapterOfferResult,
  type AdapterSearchResult,
  type Offer,
  type SearchQuery,
  type StoreAdapter,
} from "@northcinder/protocol";
import { mapWithConcurrency } from "@northcinder/adapter-kit";
import { callMcpTool, type McpCallResult } from "./mcp.js";
import {
  STORE_ID,
  decodeOfferId,
  ucpProductDetailsToOffer,
  ucpSearchPayloadToOffers,
} from "./ucp.js";

/** Default Global Catalog MCP endpoint (GA since Spring '26) — configurable. */
export const GLOBAL_CATALOG_MCP_URL = "https://catalog.shopify.com/api/ucp/mcp";

export interface ShopifyAdapterConfig {
  /**
   * Per-store storefront MCP hosts (public, no auth), e.g. "www.allbirds.com".
   * Each host is contacted at https://<host>/api/mcp. Fallback env:
   * SHOPIFY_MCP_SHOPS (comma-separated).
   */
  shops?: string[];
  /**
   * Global Catalog leg (primary when configured). The anonymous-tier
   * credential is a UCP AGENT PROFILE — an HTTPS URL to a JSON document you
   * host, referenced in every call's `meta["ucp-agent"].profile`
   * (live-verified 2026-07-11; no Authorization header needed for catalog
   * reads). An optional Dev-Dashboard bearer token raises the rate tier.
   * Fallback env: SHOPIFY_UCP_AGENT_PROFILE_URL /
   * SHOPIFY_GLOBAL_CATALOG_API_KEY / SHOPIFY_GLOBAL_CATALOG_MCP_URL.
   */
  globalCatalog?: { profileUrl?: string; apiKey?: string; url?: string };
  /** Concurrency cap for the per-shop fan-out (default 4). */
  maxShopConcurrency?: number;
  /** Injectable fetch (fixtures in tests; real fetch in production). */
  fetchImpl?: typeof fetch;
  /** Environment source (defaults to process.env; pass {} to isolate tests). */
  env?: Record<string, string | undefined>;
}

function mcpErrorToStoreError(result: Extract<McpCallResult, { ok: false }>, host: string) {
  switch (result.kind) {
    case "timeout":
      return storeError(STORE_ID, "timeout", `${host}: ${result.detail}`);
    case "network":
    case "http":
      return storeError(STORE_ID, "unavailable", `${host}: ${result.detail}`);
    default:
      return storeError(STORE_ID, "invalid_response", `${host}: ${result.detail}`, { retryable: false });
  }
}

export function createShopifyAdapter(config: ShopifyAdapterConfig = {}): StoreAdapter {
  const env = config.env ?? process.env;
  const shops = config.shops ?? (env.SHOPIFY_MCP_SHOPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const profileUrl = config.globalCatalog?.profileUrl ?? env.SHOPIFY_UCP_AGENT_PROFILE_URL;
  const apiKey = config.globalCatalog?.apiKey ?? env.SHOPIFY_GLOBAL_CATALOG_API_KEY;
  const globalUrl = config.globalCatalog?.url ?? env.SHOPIFY_GLOBAL_CATALOG_MCP_URL ?? GLOBAL_CATALOG_MCP_URL;
  const maxShopConcurrency = config.maxShopConcurrency ?? 4;
  const fetchImpl = config.fetchImpl;

  for (const shop of shops) {
    const parsed = AllowedHostSchema.safeParse(shop);
    if (!parsed.success || shop.includes("*")) {
      throw new Error(
        `invalid Shopify shop host ${JSON.stringify(shop)}: must be a bare hostname (no scheme, path, port, or wildcard)`,
      );
    }
  }
  const globalHost = new URL(globalUrl).host;

  const manifest: AdapterManifest = {
    id: STORE_ID,
    name: "Shopify (Global Catalog MCP + per-store storefront MCP)",
    version: "0.1.0",
    description:
      "The cooperative spine: Shopify Global Catalog MCP (cross-merchant; anonymous tier via a buyer-controlled HTTPS UCP agent profile, env-gated) with public per-store storefront MCP fan-out as the live no-credential leg.",
    permissions: {
      // Exactly the hosts this instance may contact — the catalog endpoint
      // plus each explicitly configured shop. No wildcards.
      allowedHosts: [globalHost, ...shops],
      userSession: false,
    },
    capabilities: { checkout: false },
  };

  const mcpOptions = (ctx: AdapterContext, headers?: Record<string, string>) => ({
    timeoutMs: ctx.timeoutMs,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    ...(headers !== undefined ? { headers } : {}),
  });

  async function searchShop(host: string, query: SearchQuery, ctx: AdapterContext): Promise<AdapterSearchResult> {
    const args: Record<string, unknown> = {
      catalog: {
        query: query.text,
        ...(query.maxResults !== undefined ? { limit: query.maxResults } : {}),
      },
    };
    const result = await callMcpTool(`https://${host}/api/mcp`, "search_catalog", args, mcpOptions(ctx));
    if (!result.ok) return { ok: false, error: mcpErrorToStoreError(result, host) };
    let offers = ucpSearchPayloadToOffers(result.payload, host);
    if (query.maxResults !== undefined) offers = offers.slice(0, query.maxResults);
    return { ok: true, offers };
  }

  async function searchGlobalCatalog(query: SearchQuery, ctx: AdapterContext): Promise<AdapterSearchResult> {
    // Live-verified wire shape (2026-07-11): the agent profile rides inside
    // the tool arguments as meta["ucp-agent"].profile (NOT a header), and the
    // result limit is catalog.pagination.limit (1–50).
    const args: Record<string, unknown> = {
      meta: { "ucp-agent": { profile: profileUrl } },
      catalog: {
        query: query.text,
        ...(query.maxResults !== undefined
          ? { pagination: { limit: Math.min(Math.max(query.maxResults, 1), 50) } }
          : {}),
      },
    };
    // Anonymous tier needs no Authorization; a Dev-Dashboard bearer (when
    // configured) raises the rate tier.
    const headers = apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : undefined;
    const result = await callMcpTool(globalUrl, "search_catalog", args, mcpOptions(ctx, headers));
    if (!result.ok) return { ok: false, error: mcpErrorToStoreError(result, globalHost) };
    let offers = ucpSearchPayloadToOffers(result.payload);
    if (query.maxResults !== undefined) offers = offers.slice(0, query.maxResults);
    return { ok: true, offers };
  }

  return {
    manifest,

    async search(query, ctx): Promise<AdapterSearchResult> {
      if (profileUrl !== undefined) {
        const global = await searchGlobalCatalog(query, ctx);
        // Global leg down but storefront shops configured → degrade to them.
        if (global.ok || shops.length === 0) return global;
      }
      if (shops.length === 0) {
        return {
          ok: false,
          error: storeError(
            STORE_ID,
            "not_configured",
            "Shopify adapter is not configured: set SHOPIFY_UCP_AGENT_PROFILE_URL (an HTTPS URL to UCP agent-profile JSON you control — enables the cross-merchant Global Catalog leg) or SHOPIFY_MCP_SHOPS (comma-separated storefront hosts)",
            { retryable: false },
          ),
        };
      }
      const settled = await mapWithConcurrency(shops, maxShopConcurrency, (host) => searchShop(host, query, ctx));
      const offers: Offer[] = [];
      const failures: Array<{ host: string; code: string; message: string }> = [];
      settled.forEach((entry, i) => {
        const host = shops[i]!;
        if (entry instanceof Error) failures.push({ host, code: "internal", message: "storefront adapter failed unexpectedly" });
        else if (entry.ok) offers.push(...entry.offers);
        else failures.push({ host, code: entry.error.code, message: entry.error.message });
      });
      if (offers.length === 0 && failures.length === shops.length && shops.length > 0) {
        const allTimeout = failures.every((f) => f.code === "timeout");
        return {
          ok: false,
          error: storeError(
            STORE_ID,
            allTimeout ? "timeout" : "unavailable",
            `all ${shops.length} configured storefront MCP endpoints failed`,
            { details: { failures } },
          ),
        };
      }
      // Each shop already caps its OWN results to maxResults, but the
      // merged, multi-shop total can still exceed it (e.g. 3 shops × the
      // full per-shop limit each) — cap the merged set too.
      const capped = query.maxResults !== undefined ? offers.slice(0, query.maxResults) : offers;
      return { ok: true, offers: capped };
    },

    async getOffer(offerId, ctx): Promise<AdapterOfferResult> {
      const decoded = decodeOfferId(offerId);
      if (!decoded) {
        return {
          ok: false,
          error: storeError(STORE_ID, "not_found", `not a Shopify offer id: ${JSON.stringify(offerId)}`, { retryable: false }),
        };
      }
      if (!manifest.permissions.allowedHosts.includes(decoded.host)) {
        return {
          ok: false,
          error: storeError(
            STORE_ID,
            "permission_denied",
            `shop host ${JSON.stringify(decoded.host)} is outside this adapter's configured scope`,
            { retryable: false },
          ),
        };
      }
      const result = await callMcpTool(
        `https://${decoded.host}/api/mcp`,
        "get_product_details",
        { product_id: decoded.productGid },
        mcpOptions(ctx),
      );
      if (!result.ok) {
        if (result.kind === "rpc") {
          return {
            ok: false,
            error: storeError(STORE_ID, "not_found", `${decoded.host}: ${result.detail}`, { retryable: false }),
          };
        }
        return { ok: false, error: mcpErrorToStoreError(result, decoded.host) };
      }
      const offer = ucpProductDetailsToOffer(result.payload, decoded.host);
      if (!offer) {
        return {
          ok: false,
          error: storeError(STORE_ID, "invalid_response", `${decoded.host}: product details did not map to a valid offer`, { retryable: false }),
        };
      }
      return { ok: true, offer };
    },
  };
}
