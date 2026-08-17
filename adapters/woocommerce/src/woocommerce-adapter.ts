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
  type StoreError,
} from "@northcinder/protocol";
import { fetchWithBudget, mapWithConcurrency, type HttpResult } from "@northcinder/adapter-kit";
import { WOOCOMMERCE_STORE_ID, decodeOfferId, mapWooProduct, woocommerceSearchPayloadToOffers } from "./mapper.js";

export interface WoocommerceAdapterConfig {
  /**
   * Bare storefront hostnames running WooCommerce, e.g. "shop.example.com".
   * Each is contacted at the PUBLIC, unauthenticated
   * `https://<host>/wp-json/wc/store/v1/products` Store API — no credentials
   * exist for this endpoint by design. Fallback env: WOOCOMMERCE_STORE_HOSTS
   * (comma-separated).
   */
  stores?: string[];
  /** Concurrency cap for the per-store fan-out (default 4). */
  maxStoreConcurrency?: number;
  /** Injectable fetch (fixtures in tests; real fetch in production). */
  fetchImpl?: typeof fetch;
  /** Environment source (defaults to process.env; pass {} to isolate tests). */
  env?: Record<string, string | undefined>;
}

function httpFailureToStoreError(result: Extract<HttpResult, { ok: false }>, host: string): StoreError {
  if (result.kind === "timeout") return storeError(WOOCOMMERCE_STORE_ID, "timeout", `${host}: request timed out`);
  if (result.kind === "too_large")
    return storeError(WOOCOMMERCE_STORE_ID, "invalid_response", `${host}: response exceeded body cap`, { retryable: false });
  return storeError(WOOCOMMERCE_STORE_ID, "unavailable", `${host}: network failure`);
}

export function createWoocommerceAdapter(config: WoocommerceAdapterConfig = {}): StoreAdapter {
  const env = config.env ?? process.env;
  const stores = config.stores ?? (env.WOOCOMMERCE_STORE_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const maxStoreConcurrency = config.maxStoreConcurrency ?? 4;
  const fetchImpl = config.fetchImpl;

  for (const host of stores) {
    const parsed = AllowedHostSchema.safeParse(host);
    if (!parsed.success || host.includes("*")) {
      throw new Error(
        `invalid WooCommerce store host ${JSON.stringify(host)}: must be a bare hostname (no scheme, path, port, or wildcard)`,
      );
    }
  }

  const manifest: AdapterManifest = {
    id: WOOCOMMERCE_STORE_ID,
    name: "WooCommerce Store API",
    version: "0.1.0",
    description:
      "WooCommerce core's public, unauthenticated Store API (wp-json/wc/store/v1) — live by default, no credentials, per-store fan-out.",
    permissions: { allowedHosts: [...stores], userSession: false },
    capabilities: { checkout: false },
  };

  const notConfigured = (): { ok: false; error: StoreError } => ({
    ok: false,
    error: storeError(
      WOOCOMMERCE_STORE_ID,
      "not_configured",
      "WooCommerce adapter is not configured: set WOOCOMMERCE_STORE_HOSTS (comma-separated storefront hostnames running the public wc/store/v1 Store API)",
      { retryable: false },
    ),
  });

  async function getJson(
    url: string,
    ctx: AdapterContext,
  ): Promise<{ ok: true; body: unknown; status: number } | { ok: false; error: StoreError }> {
    const host = new URL(url).host;
    const result = await fetchWithBudget(
      url,
      { method: "GET", headers: { accept: "application/json" } },
      { timeoutMs: ctx.timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}), ...(fetchImpl ? { fetchImpl } : {}) },
    );
    if (!result.ok) return { ok: false, error: httpFailureToStoreError(result, host) };
    let body: unknown;
    try {
      body = JSON.parse(result.bodyText);
    } catch {
      return { ok: false, error: storeError(WOOCOMMERCE_STORE_ID, "invalid_response", `${host}: Store API returned non-JSON`, { retryable: false }) };
    }
    return { ok: true, body, status: result.status };
  }

  async function searchStore(host: string, query: SearchQuery, ctx: AdapterContext): Promise<AdapterSearchResult> {
    const params = new URLSearchParams({ search: query.text, per_page: String(query.maxResults ?? 20) });
    const result = await getJson(`https://${host}/wp-json/wc/store/v1/products?${params}`, ctx);
    if (!result.ok) return result;
    if (result.status !== 200) {
      return { ok: false, error: storeError(WOOCOMMERCE_STORE_ID, "unavailable", `${host}: Store API returned HTTP ${result.status}`) };
    }
    let offers = woocommerceSearchPayloadToOffers(result.body, host);
    if (query.maxResults !== undefined) offers = offers.slice(0, query.maxResults);
    return { ok: true, offers };
  }

  return {
    manifest,

    async search(query, ctx): Promise<AdapterSearchResult> {
      if (stores.length === 0) return notConfigured();

      const settled = await mapWithConcurrency(stores, maxStoreConcurrency, (host) => searchStore(host, query, ctx));
      const offers: Offer[] = [];
      const failures: Array<{ host: string; code: string; message: string }> = [];
      settled.forEach((entry, i) => {
        const host = stores[i]!;
        if (entry instanceof Error) failures.push({ host, code: "internal", message: "store adapter failed unexpectedly" });
        else if (entry.ok) offers.push(...entry.offers);
        else failures.push({ host, code: entry.error.code, message: entry.error.message });
      });
      // A down host degrades gracefully — never fails the whole search as
      // long as at least one configured host answered.
      if (offers.length === 0 && failures.length === stores.length && stores.length > 0) {
        const allTimeout = failures.every((f) => f.code === "timeout");
        return {
          ok: false,
          error: storeError(
            WOOCOMMERCE_STORE_ID,
            allTimeout ? "timeout" : "unavailable",
            `all ${stores.length} configured WooCommerce store(s) failed`,
            { details: { failures } },
          ),
        };
      }
      // Each store already caps its own results to maxResults, but the
      // merged, multi-store total can still exceed it — cap the merged set.
      const capped = query.maxResults !== undefined ? offers.slice(0, query.maxResults) : offers;
      return { ok: true, offers: capped };
    },

    async getOffer(offerId, ctx): Promise<AdapterOfferResult> {
      if (stores.length === 0) return notConfigured();
      const decoded = decodeOfferId(offerId);
      if (!decoded) {
        return {
          ok: false,
          error: storeError(WOOCOMMERCE_STORE_ID, "not_found", `not a WooCommerce offer id: ${JSON.stringify(offerId)}`, { retryable: false }),
        };
      }
      if (!stores.includes(decoded.host)) {
        return {
          ok: false,
          error: storeError(
            WOOCOMMERCE_STORE_ID,
            "permission_denied",
            `store host ${JSON.stringify(decoded.host)} is outside this adapter's configured scope`,
            { retryable: false },
          ),
        };
      }
      const result = await getJson(`https://${decoded.host}/wp-json/wc/store/v1/products/${decoded.productId}`, ctx);
      if (!result.ok) return result;
      if (result.status === 404) {
        return { ok: false, error: storeError(WOOCOMMERCE_STORE_ID, "not_found", `${decoded.host}: product ${decoded.productId} not found`, { retryable: false }) };
      }
      if (result.status !== 200) {
        return { ok: false, error: storeError(WOOCOMMERCE_STORE_ID, "unavailable", `${decoded.host}: Store API returned HTTP ${result.status}`) };
      }
      const offer = mapWooProduct(result.body, decoded.host);
      if (!offer) {
        return { ok: false, error: storeError(WOOCOMMERCE_STORE_ID, "invalid_response", `${decoded.host}: product did not map to a valid offer`, { retryable: false }) };
      }
      return { ok: true, offer };
    },
  };
}
