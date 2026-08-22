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
import { fetchWithBudget, parseDecimalToMinorUnits, type HttpResult } from "@northcinder/adapter-kit";

export const EBAY_STORE_ID = "ebay";

const HOSTS = {
  sandbox: "api.sandbox.ebay.com",
  production: "api.ebay.com",
} as const;

export interface EbayAdapterConfig {
  /** eBay developer app credentials. Fallback env: EBAY_CLIENT_ID / EBAY_CLIENT_SECRET. */
  clientId?: string;
  clientSecret?: string;
  /**
   * "sandbox" (default — open to any dev account) or "production"
   * (Buy Browse production access requires eBay Partner Network approval).
   * Fallback env: EBAY_ENV.
   */
  environment?: "sandbox" | "production";
  /** X-EBAY-C-MARKETPLACE-ID header (default EBAY_US). */
  marketplaceId?: string;
  /** Injectable fetch (fixtures in tests). */
  fetchImpl?: typeof fetch;
  /** Environment source (defaults to process.env; pass {} to isolate tests). */
  env?: Record<string, string | undefined>;
}

const MoneyStringSchema = z.looseObject({ value: z.union([z.string(), z.number()]), currency: z.string() });

const ItemSummarySchema = z.looseObject({
  itemId: z.string().min(1),
  title: z.string().min(1),
  price: MoneyStringSchema,
  itemWebUrl: z.url(),
  image: z.looseObject({ imageUrl: z.string() }).optional(),
  seller: z.looseObject({ username: z.string().min(1) }).optional(),
  condition: z.string().optional(),
  shippingOptions: z
    .array(z.looseObject({ shippingCostType: z.string().optional(), shippingCost: MoneyStringSchema.optional() }))
    .optional(),
});

const ItemSchema = ItemSummarySchema.extend({
  shortDescription: z.string().optional(),
  brand: z.string().optional(),
  estimatedAvailabilities: z
    .array(z.looseObject({ estimatedAvailabilityStatus: z.string().optional() }))
    .optional(),
});

function mapCondition(condition: string | undefined): Offer["condition"] {
  if (!condition) return undefined;
  const lower = condition.toLowerCase();
  if (lower.includes("refurbished")) return "refurbished";
  if (lower.includes("new")) return "new";
  if (lower.includes("used") || lower.includes("pre-owned")) return "used";
  return undefined;
}

function mapItem(raw: unknown, domain: string, opts: { availability?: Offer["availability"] } = {}): Offer | null {
  const parsed = ItemSchema.safeParse(raw);
  if (!parsed.success) return null;
  const item = parsed.data;
  const price = parseDecimalToMinorUnits(String(item.price.value), item.price.currency);
  if (!price) return null;
  const seller = item.seller?.username;
  const shippingCostRaw = item.shippingOptions?.find((o) => o.shippingCost)?.shippingCost;
  const shippingCost = shippingCostRaw
    ? parseDecimalToMinorUnits(String(shippingCostRaw.value), shippingCostRaw.currency)
    : null;
  const condition = mapCondition(item.condition);

  let availability: Offer["availability"] = opts.availability ?? "unknown";
  const status = item.estimatedAvailabilities?.[0]?.estimatedAvailabilityStatus;
  if (status === "IN_STOCK" || status === "LIMITED_STOCK") availability = "in_stock";
  else if (status === "OUT_OF_STOCK") availability = "out_of_stock";

  const offer: Offer = {
    id: item.itemId,
    product: {
      id: item.itemId,
      title: item.title,
      ...(item.shortDescription ? { description: item.shortDescription } : {}),
      url: item.itemWebUrl,
      ...(item.image?.imageUrl && z.url().safeParse(item.image.imageUrl).success
        ? { imageUrl: item.image.imageUrl }
        : {}),
      ...(item.brand ? { brand: item.brand } : {}),
      attributes: {},
    },
    price,
    merchant: seller
      ? { id: `ebay:${seller}`, name: seller, domain, platform: "ebay" }
      : { id: "ebay:unknown-seller", name: "unknown eBay seller", domain, platform: "ebay" },
    availability,
    ...(shippingCost ? { shipping: { cost: shippingCost } } : {}),
    sourceStore: EBAY_STORE_ID,
    // Browse item_summary/search returns organic listings; northcinder takes no
    // placement money and adds no EPN affiliate parameters (spec §4).
    sponsored: false,
    ...(condition ? { condition } : {}),
  };
  return OfferSchema.safeParse(offer).success ? offer : null;
}

function httpFailureToStoreError(result: Extract<HttpResult, { ok: false }>, what: string): StoreError {
  if (result.kind === "timeout") return storeError(EBAY_STORE_ID, "timeout", `${what} timed out`);
  if (result.kind === "too_large")
    return storeError(EBAY_STORE_ID, "invalid_response", `${what}: response exceeded body cap`, { retryable: false });
  return storeError(EBAY_STORE_ID, "unavailable", `${what}: network failure`);
}

export function createEbayAdapter(config: EbayAdapterConfig = {}): StoreAdapter {
  const env = config.env ?? process.env;
  const clientId = config.clientId ?? env.EBAY_CLIENT_ID;
  const clientSecret = config.clientSecret ?? env.EBAY_CLIENT_SECRET;
  const environment = config.environment ?? (env.EBAY_ENV === "production" ? "production" : "sandbox");
  const marketplaceId = config.marketplaceId ?? env.EBAY_MARKETPLACE_ID ?? "EBAY_US";
  const fetchImpl = config.fetchImpl;
  const host = HOSTS[environment];
  const base = `https://${host}`;

  const manifest: AdapterManifest = {
    id: EBAY_STORE_ID,
    name: "eBay Buy Browse API",
    version: "0.2.1",
    description:
      "eBay buyer-side Browse API adapter. Sandbox works with any dev keypair; production requires eBay Partner Network approval.",
    // Scoped to the host of the CONFIGURED instance only — a sandbox-mode
    // adapter has no business reaching production (or vice versa).
    permissions: { allowedHosts: [host], userSession: false },
    capabilities: { checkout: false },
  };

  const notConfigured = (): { ok: false; error: StoreError } => ({
    ok: false,
    error: storeError(
      EBAY_STORE_ID,
      "not_configured",
      "eBay adapter is not configured: set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET (sandbox keys work for any dev account; production Browse access requires eBay Partner Network approval)",
      { retryable: false },
    ),
  });

  let cachedToken: { value: string; expiresAt: number } | undefined;

  async function getToken(ctx: AdapterContext): Promise<{ ok: true; token: string } | { ok: false; error: StoreError }> {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return { ok: true, token: cachedToken.value };
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const result = await fetchWithBudget(
      `${base}/identity/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
      },
      { timeoutMs: ctx.timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}), ...(fetchImpl ? { fetchImpl } : {}) },
    );
    if (!result.ok) return { ok: false, error: httpFailureToStoreError(result, "eBay OAuth token request") };
    if (result.status === 429) {
      return { ok: false, error: storeError(EBAY_STORE_ID, "rate_limited", "eBay OAuth token request rate limited", { ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}) }) };
    }
    if (result.status !== 200) {
      return {
        ok: false,
        error: storeError(EBAY_STORE_ID, "permission_denied", `eBay OAuth rejected the app credentials (HTTP ${result.status})`, { retryable: false }),
      };
    }
    const parsed = z
      .looseObject({ access_token: z.string().min(1), expires_in: z.number() })
      .safeParse(JSON.parse(result.bodyText));
    if (!parsed.success) {
      return { ok: false, error: storeError(EBAY_STORE_ID, "invalid_response", "eBay OAuth response missing access_token", { retryable: false }) };
    }
    cachedToken = { value: parsed.data.access_token, expiresAt: Date.now() + parsed.data.expires_in * 1000 };
    return { ok: true, token: parsed.data.access_token };
  }

  async function browseGetOnce(
    path: string,
    token: string,
    ctx: AdapterContext,
  ): Promise<{ ok: true; body: unknown; status: number } | { ok: false; error: StoreError }> {
    const result = await fetchWithBudget(
      `${base}${path}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "x-ebay-c-marketplace-id": marketplaceId,
        },
      },
      { timeoutMs: ctx.timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}), ...(fetchImpl ? { fetchImpl } : {}) },
    );
    if (!result.ok) return { ok: false, error: httpFailureToStoreError(result, `eBay Browse ${path}`) };
    if (result.status === 429) {
      return { ok: false, error: storeError(EBAY_STORE_ID, "rate_limited", `eBay Browse ${path} rate limited`, { ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}) }) };
    }
    let body: unknown;
    try {
      body = JSON.parse(result.bodyText);
    } catch {
      return { ok: false, error: storeError(EBAY_STORE_ID, "invalid_response", "eBay Browse returned non-JSON", { retryable: false }) };
    }
    return { ok: true, body, status: result.status };
  }

  async function browseGet(path: string, ctx: AdapterContext): Promise<{ ok: true; body: unknown; status: number } | { ok: false; error: StoreError }> {
    const token = await getToken(ctx);
    if (!token.ok) return token;
    const first = await browseGetOnce(path, token.token, ctx);
    if (!first.ok || first.status !== 401) return first;

    // A 401 with a cached (presumably revoked) token — clear the cache and
    // retry exactly once with a freshly-issued token, rather than reporting
    // a store failure that a simple re-auth would have resolved.
    cachedToken = undefined;
    const fresh = await getToken(ctx);
    if (!fresh.ok) return fresh;
    return browseGetOnce(path, fresh.token, ctx);
  }

  return {
    manifest,

    async search(query, ctx): Promise<AdapterSearchResult> {
      if (!clientId || !clientSecret) return notConfigured();
      const params = new URLSearchParams({ q: query.text, limit: String(query.maxResults ?? 20) });
      const result = await browseGet(`/buy/browse/v1/item_summary/search?${params}`, ctx);
      if (!result.ok) return result;
      if (result.status !== 200) {
        return { ok: false, error: storeError(EBAY_STORE_ID, "unavailable", `eBay Browse search returned HTTP ${result.status}`) };
      }
      const summaries = (result.body as { itemSummaries?: unknown[] }).itemSummaries ?? [];
      const offers: Offer[] = [];
      for (const raw of summaries) {
        const offer = mapItem(raw, "ebay.com");
        if (offer) offers.push(offer);
      }
      return { ok: true, offers: query.maxResults !== undefined ? offers.slice(0, query.maxResults) : offers };
    },

    async getOffer(offerId, ctx): Promise<AdapterOfferResult> {
      if (!clientId || !clientSecret) return notConfigured();
      const result = await browseGet(`/buy/browse/v1/item/${encodeURIComponent(offerId)}`, ctx);
      if (!result.ok) return result;
      if (result.status === 404) {
        return { ok: false, error: storeError(EBAY_STORE_ID, "not_found", `eBay item ${JSON.stringify(offerId)} not found`, { retryable: false }) };
      }
      if (result.status !== 200) {
        return { ok: false, error: storeError(EBAY_STORE_ID, "unavailable", `eBay Browse item returned HTTP ${result.status}`) };
      }
      const offer = mapItem(result.body, "ebay.com");
      if (!offer) {
        return { ok: false, error: storeError(EBAY_STORE_ID, "invalid_response", "eBay item did not map to a valid offer", { retryable: false }) };
      }
      return { ok: true, offer };
    },
  };
}
