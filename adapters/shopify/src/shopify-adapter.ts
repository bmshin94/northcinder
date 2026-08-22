import {
  ChildSourceHostnameSchema,
  storeError,
  toChildSourceError,
  validateCredentialedBaseUrl,
  type AdapterContext,
  type AdapterManifest,
  type AdapterOfferResult,
  type AdapterSearchResult,
  type SourceStatus,
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
   * Each host is contacted at https://<host>/api/ucp/mcp. Fallback env:
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
      return storeError(STORE_ID, "unavailable", `${host}: ${result.detail}`);
    case "http":
      return result.status === 429
        ? storeError(STORE_ID, "rate_limited", `${host}: catalog rate limited`, {
            details: { httpStatus: result.status },
            ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
          })
        : storeError(STORE_ID, "unavailable", `${host}: catalog request returned an HTTP error`, {
            details: { httpStatus: result.status },
          });
    case "rpc":
      return storeError(STORE_ID, "invalid_response", `${host}: catalog RPC request failed`, {
        retryable: false,
        ...(result.rpcCode !== undefined ? { details: { rpcCode: result.rpcCode } } : {}),
      });
    case "invalid_response":
      return storeError(STORE_ID, "invalid_response", `${host}: catalog returned an invalid response`, { retryable: false });
  }
}

export function createShopifyAdapter(config: ShopifyAdapterConfig = {}): StoreAdapter {
  const env = config.env ?? process.env;
  const shops = (config.shops ?? (env.SHOPIFY_MCP_SHOPS ?? "").split(","))
    .map((shop) => shop.trim().toLowerCase())
    .filter(Boolean);
  const profileUrl = config.globalCatalog?.profileUrl ?? env.SHOPIFY_UCP_AGENT_PROFILE_URL;
  const apiKeyRaw = config.globalCatalog?.apiKey ?? env.SHOPIFY_GLOBAL_CATALOG_API_KEY;
  const apiKey = apiKeyRaw?.trim() || undefined;
  const globalUrlRaw = config.globalCatalog?.url ?? env.SHOPIFY_GLOBAL_CATALOG_MCP_URL ?? GLOBAL_CATALOG_MCP_URL;
  const maxShopConcurrency = config.maxShopConcurrency ?? 4;
  const fetchImpl = config.fetchImpl;

  if (profileUrl !== undefined) {
    let profile: URL;
    try {
      profile = new URL(profileUrl);
    } catch {
      throw new Error("invalid Shopify UCP agent profile URL: must be an HTTPS URL without userinfo");
    }
    if (profile.protocol !== "https:" || profile.username || profile.password) {
      throw new Error("invalid Shopify UCP agent profile URL: must be an HTTPS URL without userinfo");
    }
  }

  const validatedGlobalUrl = validateCredentialedBaseUrl(globalUrlRaw, { allowLoopbackHttp: false });
  if (!validatedGlobalUrl.ok) {
    throw new Error(
      "invalid Shopify Global Catalog URL: must use HTTPS without credentials, query, or fragment",
    );
  }
  const globalUrl = validatedGlobalUrl.url.toString();

  for (const shop of shops) {
    const parsed = ChildSourceHostnameSchema.safeParse(shop);
    if (!parsed.success) {
      throw new Error(
        `invalid Shopify shop host ${JSON.stringify(shop)}: must be a bare hostname (no scheme, path, port, or wildcard)`,
      );
    }
  }
  const globalHost = new URL(globalUrl).hostname.toLowerCase();

  const manifest: AdapterManifest = {
    id: STORE_ID,
    name: "Shopify UCP Catalog",
    version: "0.2.0",
    description:
      "Shopify Global and Storefront Catalog UCP, using a buyer-controlled HTTPS UCP agent profile for every anonymous catalog call.",
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

  const ucpAgentMeta = { meta: { "ucp-agent": { profile: profileUrl } } };

  function missingProfileError() {
    return storeError(
      STORE_ID,
      "not_configured",
      "Shopify UCP requires SHOPIFY_UCP_AGENT_PROFILE_URL: an HTTPS URL without userinfo to UCP agent-profile JSON you control",
      { retryable: false },
    );
  }

  async function searchShop(host: string, query: SearchQuery, ctx: AdapterContext): Promise<AdapterSearchResult> {
    const args: Record<string, unknown> = {
      ...ucpAgentMeta,
      catalog: {
        query: query.text,
        ...(query.maxResults !== undefined
          ? { pagination: { limit: Math.min(Math.max(query.maxResults, 1), 250) } }
          : {}),
      },
    };
    const result = await callMcpTool(`https://${host}/api/ucp/mcp`, "search_catalog", args, mcpOptions(ctx));
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
      ...ucpAgentMeta,
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
      if (profileUrl === undefined && shops.length > 0) return { ok: false, error: missingProfileError() };
      if (profileUrl !== undefined) {
        const global = await searchGlobalCatalog(query, ctx);
        // Global leg down but storefront shops configured → degrade to them.
        if (global.ok || shops.length === 0) {
          return global.ok ? { ...global, sourceStatuses: [{ source: globalHost, ok: true, offerCount: global.offers.length }] } : global;
        }
        const globalFailure: SourceStatus = { source: globalHost, ok: false, error: toChildSourceError(global.error) };
        const settled = await mapWithConcurrency(shops, maxShopConcurrency, (host) => searchShop(host, query, ctx));
        const offers: Offer[] = [];
        const sourceStatuses: SourceStatus[] = [globalFailure];
        const failures: Array<{ host: string; code: string; message: string; retryAfterMs?: number }> = [];
        settled.forEach((entry, i) => {
          const host = shops[i]!;
          if (entry instanceof Error) {
            const error = storeError(STORE_ID, "internal", "storefront adapter failed unexpectedly", { retryable: false });
            failures.push({ host, code: error.code, message: error.message });
            sourceStatuses.push({ source: host, ok: false, error: toChildSourceError(error) });
          } else if (entry.ok) {
            offers.push(...entry.offers);
            sourceStatuses.push({ source: host, ok: true, offerCount: entry.offers.length });
          } else {
            failures.push({ host, code: entry.error.code, message: entry.error.message, ...(entry.error.retryAfterMs !== undefined ? { retryAfterMs: entry.error.retryAfterMs } : {}) });
            sourceStatuses.push({ source: host, ok: false, error: toChildSourceError(entry.error) });
          }
        });
        if (offers.length === 0 && failures.length === shops.length) {
          const attemptedFailures = [{ host: globalHost, code: global.error.code, message: global.error.message, ...(global.error.retryAfterMs !== undefined ? { retryAfterMs: global.error.retryAfterMs } : {}) }, ...failures];
          const allTimeout = attemptedFailures.every((f) => f.code === "timeout");
          const allRateLimited = attemptedFailures.every((f) => f.code === "rate_limited");
          const retryAfterMs = Math.max(...attemptedFailures.flatMap((failure) => failure.retryAfterMs === undefined ? [] : [failure.retryAfterMs]));
          return { ok: false, error: storeError(STORE_ID, allTimeout ? "timeout" : allRateLimited ? "rate_limited" : "unavailable", `all ${shops.length} configured storefront MCP endpoints failed`, { details: { failures: attemptedFailures }, ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}) }) };
        }
        return { ok: true, offers: query.maxResults !== undefined ? offers.slice(0, query.maxResults) : offers, sourceStatuses };
      }
      if (shops.length === 0) {
        return {
          ok: false,
          error: storeError(
            STORE_ID,
            "not_configured",
            "Shopify adapter is not configured: set SHOPIFY_UCP_AGENT_PROFILE_URL (an HTTPS URL without userinfo to UCP agent-profile JSON you control)",
            { retryable: false },
          ),
        };
      }
      const settled = await mapWithConcurrency(shops, maxShopConcurrency, (host) => searchShop(host, query, ctx));
      const offers: Offer[] = [];
      const sourceStatuses: SourceStatus[] = [];
      const failures: Array<{ host: string; code: string; message: string; retryAfterMs?: number }> = [];
      settled.forEach((entry, i) => {
        const host = shops[i]!;
        if (entry instanceof Error) { const error = storeError(STORE_ID, "internal", "storefront adapter failed unexpectedly", { retryable: false }); failures.push({ host, code: error.code, message: error.message }); sourceStatuses.push({ source: host, ok: false, error: toChildSourceError(error) }); }
        else if (entry.ok) { offers.push(...entry.offers); sourceStatuses.push({ source: host, ok: true, offerCount: entry.offers.length }); }
        else { failures.push({ host, code: entry.error.code, message: entry.error.message, ...(entry.error.retryAfterMs !== undefined ? { retryAfterMs: entry.error.retryAfterMs } : {}) }); sourceStatuses.push({ source: host, ok: false, error: toChildSourceError(entry.error) }); }
      });
      if (offers.length === 0 && failures.length === shops.length && shops.length > 0) {
        const allTimeout = failures.every((f) => f.code === "timeout");
        const allRateLimited = failures.every((f) => f.code === "rate_limited");
        const retryAfterMs = Math.max(...failures.flatMap((failure) => failure.retryAfterMs === undefined ? [] : [failure.retryAfterMs]));
        return {
          ok: false,
          error: storeError(
            STORE_ID,
            allTimeout ? "timeout" : allRateLimited ? "rate_limited" : "unavailable",
            `all ${shops.length} configured storefront MCP endpoints failed`,
            {
              details: { failures },
              ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
            },
          ),
        };
      }
      // Each shop already caps its OWN results to maxResults, but the
      // merged, multi-shop total can still exceed it (e.g. 3 shops × the
      // full per-shop limit each) — cap the merged set too.
      const capped = query.maxResults !== undefined ? offers.slice(0, query.maxResults) : offers;
      return { ok: true, offers: capped, sourceStatuses };
    },

    async getOffer(offerId, ctx): Promise<AdapterOfferResult> {
      if (profileUrl === undefined) return { ok: false, error: missingProfileError() };
      const decoded = decodeOfferId(offerId);
      if (!decoded) {
        return {
          ok: false,
          error: storeError(STORE_ID, "not_found", `not a Shopify offer id: ${JSON.stringify(offerId)}`, { retryable: false }),
        };
      }
      if (decoded.kind === "storefront" && decoded.productGid.startsWith("gid://shopify/p/")) {
        return {
          ok: false,
          error: storeError(STORE_ID, "not_found", "Global Catalog UPIDs require a seller-bound Global offer reference", { retryable: false }),
        };
      }
      const globalUpid = decoded.kind === "global";
      if (!globalUpid && !shops.includes(decoded.host.toLowerCase())) {
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
      const endpoint = globalUpid ? globalUrl : `https://${decoded.host}/api/ucp/mcp`;
      const headers = globalUpid && apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : undefined;
      const result = await callMcpTool(endpoint, "get_product", {
        ...ucpAgentMeta,
        catalog: { id: decoded.productGid },
      }, mcpOptions(ctx, headers));
      if (!result.ok) {
        if (result.kind === "rpc") {
          return {
            ok: false,
            error: storeError(STORE_ID, "not_found", `${decoded.host}: catalog product lookup failed`, {
              retryable: false,
              ...(result.rpcCode !== undefined ? { details: { rpcCode: result.rpcCode } } : {}),
            }),
          };
        }
        return { ok: false, error: mcpErrorToStoreError(result, decoded.host) };
      }
      const offer = ucpProductDetailsToOffer(result.payload, decoded.host, decoded);
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
