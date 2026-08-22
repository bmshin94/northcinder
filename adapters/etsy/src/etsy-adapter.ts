import { z } from "zod";
import {
  OfferSchema,
  storeError,
  type AdapterContext,
  type AdapterManifest,
  type AdapterOfferResult,
  type AdapterSearchResult,
  type Offer,
  type StoreAdapter,
  type StoreError,
} from "@northcinder/protocol";
import { fetchWithBudget, scaledToMinorUnits, type HttpResult } from "@northcinder/adapter-kit";

export const ETSY_STORE_ID = "etsy";
const API_HOST = "openapi.etsy.com";
const BASE = `https://${API_HOST}/v3/application`;

export interface EtsyAdapterConfig {
  /** Etsy Open API v3 keystring (app-review gated). Fallback env: ETSY_API_KEY. */
  apiKey?: string;
  /** Injectable fetch (fixtures in tests). */
  fetchImpl?: typeof fetch;
  /** Environment source (defaults to process.env; pass {} to isolate tests). */
  env?: Record<string, string | undefined>;
}

const ListingSchema = z.looseObject({
  listing_id: z.number().int(),
  shop_id: z.number().int().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  state: z.string().optional(),
  quantity: z.number().int().optional(),
  url: z.url(),
  price: z.looseObject({
    amount: z.number().int(),
    divisor: z.number().int(),
    currency_code: z.string(),
  }),
});

function mapListing(raw: unknown): Offer | null {
  const parsed = ListingSchema.safeParse(raw);
  if (!parsed.success) return null;
  const listing = parsed.data;
  const price = scaledToMinorUnits(listing.price.amount, listing.price.divisor, listing.price.currency_code);
  if (!price) return null;
  const active = listing.state === undefined || listing.state === "active";
  const availability: Offer["availability"] =
    listing.quantity === undefined ? (active ? "unknown" : "out_of_stock") : listing.quantity > 0 && active ? "in_stock" : "out_of_stock";
  const shopId = listing.shop_id;

  const offer: Offer = {
    id: String(listing.listing_id),
    product: {
      id: String(listing.listing_id),
      title: listing.title,
      ...(listing.description ? { description: listing.description } : {}),
      url: listing.url,
      attributes: {},
    },
    price,
    merchant:
      shopId !== undefined
        ? // The listings endpoints return only the numeric shop id; resolving the
          // display name needs a further (also key-gated) getShop call — deferred.
          { id: `etsy-shop:${shopId}`, name: `Etsy shop #${shopId}`, domain: "etsy.com", platform: "etsy" }
        : { id: "etsy-shop:unknown", name: "unknown Etsy shop", domain: "etsy.com", platform: "etsy" },
    availability,
    sourceStore: ETSY_STORE_ID,
    // Open API listing search is organic; northcinder takes no placement money (spec §4).
    sponsored: false,
  };
  return OfferSchema.safeParse(offer).success ? offer : null;
}

function httpFailureToStoreError(result: Extract<HttpResult, { ok: false }>, what: string): StoreError {
  if (result.kind === "timeout") return storeError(ETSY_STORE_ID, "timeout", `${what} timed out`);
  if (result.kind === "too_large")
    return storeError(ETSY_STORE_ID, "invalid_response", `${what}: response exceeded body cap`, { retryable: false });
  return storeError(ETSY_STORE_ID, "unavailable", `${what}: network failure`);
}

export function createEtsyAdapter(config: EtsyAdapterConfig = {}): StoreAdapter {
  const env = config.env ?? process.env;
  const apiKey = config.apiKey ?? env.ETSY_API_KEY;
  const fetchImpl = config.fetchImpl;

  const manifest: AdapterManifest = {
    id: ETSY_STORE_ID,
    name: "Etsy Open API v3",
    version: "0.2.1",
    description:
      "Etsy Open API v3 adapter. App registration sits 'pending approval' until Etsy manually reviews it; fixture-driven until an approved key exists.",
    permissions: { allowedHosts: [API_HOST], userSession: false },
    capabilities: { checkout: false },
  };

  const notConfigured = (): { ok: false; error: StoreError } => ({
    ok: false,
    error: storeError(
      ETSY_STORE_ID,
      "not_configured",
      "Etsy adapter is not configured: set ETSY_API_KEY (an Etsy Open API v3 keystring — new apps remain 'pending approval' until manually reviewed by Etsy)",
      { retryable: false },
    ),
  });

  async function apiGet(path: string, ctx: AdapterContext): Promise<{ ok: true; body: unknown; status: number } | { ok: false; error: StoreError }> {
    const result = await fetchWithBudget(
      `${BASE}${path}`,
      { method: "GET", headers: { "x-api-key": apiKey!, accept: "application/json" } },
      { timeoutMs: ctx.timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}), ...(fetchImpl ? { fetchImpl } : {}) },
    );
    if (!result.ok) return { ok: false, error: httpFailureToStoreError(result, `Etsy ${path}`) };
    if (result.status === 429) {
      return { ok: false, error: storeError(ETSY_STORE_ID, "rate_limited", `Etsy ${path} rate limited`, { ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}) }) };
    }
    if (result.status === 401 || result.status === 403) {
      return {
        ok: false,
        error: storeError(ETSY_STORE_ID, "permission_denied", `Etsy rejected the API key (HTTP ${result.status}) — the app may still be pending approval`, { retryable: false }),
      };
    }
    let body: unknown;
    try {
      body = JSON.parse(result.bodyText);
    } catch {
      return { ok: false, error: storeError(ETSY_STORE_ID, "invalid_response", "Etsy returned non-JSON", { retryable: false }) };
    }
    return { ok: true, body, status: result.status };
  }

  return {
    manifest,

    async search(query, ctx): Promise<AdapterSearchResult> {
      if (!apiKey) return notConfigured();
      const params = new URLSearchParams({ keywords: query.text, limit: String(query.maxResults ?? 20) });
      const result = await apiGet(`/listings/active?${params}`, ctx);
      if (!result.ok) return result;
      if (result.status !== 200) {
        return { ok: false, error: storeError(ETSY_STORE_ID, "unavailable", `Etsy listings search returned HTTP ${result.status}`) };
      }
      const listings = (result.body as { results?: unknown[] }).results ?? [];
      const offers: Offer[] = [];
      for (const raw of listings) {
        const offer = mapListing(raw);
        if (offer) offers.push(offer);
      }
      return { ok: true, offers: query.maxResults !== undefined ? offers.slice(0, query.maxResults) : offers };
    },

    async getOffer(offerId, ctx): Promise<AdapterOfferResult> {
      if (!apiKey) return notConfigured();
      if (!/^\d+$/.test(offerId)) {
        return {
          ok: false,
          error: storeError(ETSY_STORE_ID, "not_found", `not an Etsy listing id: ${JSON.stringify(offerId)}`, { retryable: false }),
        };
      }
      const result = await apiGet(`/listings/${offerId}`, ctx);
      if (!result.ok) return result;
      if (result.status === 404) {
        return { ok: false, error: storeError(ETSY_STORE_ID, "not_found", `Etsy listing ${offerId} not found`, { retryable: false }) };
      }
      if (result.status !== 200) {
        return { ok: false, error: storeError(ETSY_STORE_ID, "unavailable", `Etsy getListing returned HTTP ${result.status}`) };
      }
      const offer = mapListing(result.body);
      if (!offer) {
        return { ok: false, error: storeError(ETSY_STORE_ID, "invalid_response", "Etsy listing did not map to a valid offer", { retryable: false }) };
      }
      return { ok: true, offer };
    },
  };
}
