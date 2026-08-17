import { z } from "zod";
import { OfferSchema, type Offer } from "@northcinder/protocol";
import { scaledToMinorUnits } from "@northcinder/adapter-kit";

export const WOOCOMMERCE_STORE_ID = "woocommerce";

/** Offer-id codec: "wc|<store host>|<product id>". Host never contains "|". */
export function encodeOfferId(host: string, productId: number | string): string {
  return `wc|${host}|${productId}`;
}
export function decodeOfferId(id: string): { host: string; productId: string } | null {
  const parts = id.split("|");
  if (parts.length !== 3 || parts[0] !== "wc" || !parts[1] || !parts[2]) return null;
  return { host: parts[1], productId: parts[2] };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Store API `prices` shape: every money field is a STRING integer already
 * scaled by `currency_minor_unit` (e.g. "8999" at minor_unit 2 == $89.99).
 * That is not necessarily the SAME exponent the protocol expects for the
 * currency (`adapter-kit`'s `currencyExponent`) — rescale exactly via
 * `scaledToMinorUnits`, treating the store's own scale as the "divisor"
 * (10 ** currency_minor_unit), never floats.
 */
const PricesSchema = z.looseObject({
  price: z.string().regex(/^\d+$/, "Store API price must be a non-negative integer string"),
  currency_code: z.string(),
  currency_minor_unit: z.number().int().nonnegative(),
});

function pricesToMoney(prices: z.infer<typeof PricesSchema>) {
  const amount = Number(prices.price);
  if (!Number.isSafeInteger(amount)) return null;
  const storeDivisor = 10 ** prices.currency_minor_unit;
  return scaledToMinorUnits(amount, storeDivisor, prices.currency_code);
}

/** Store API Product resource — the fields this adapter consumes; extras ignored. */
export const WooProductSchema = z.looseObject({
  id: z.number().int(),
  name: z.string().min(1),
  permalink: z.url(),
  sku: z.string().optional(),
  short_description: z.string().optional(),
  on_sale: z.boolean().optional(),
  is_in_stock: z.boolean(),
  prices: PricesSchema,
  images: z
    .array(
      z.looseObject({
        src: z.string().optional(),
      }),
    )
    .optional(),
});
export type WooProduct = z.infer<typeof WooProductSchema>;

/**
 * Map one Store API product to a protocol Offer. Returns null when the raw
 * payload doesn't shape-match or the money can't be exactly represented —
 * skipped, never fabricated (mirrors etsy/shopify honesty posture).
 */
export function mapWooProduct(raw: unknown, host: string): Offer | null {
  const parsed = WooProductSchema.safeParse(raw);
  if (!parsed.success) return null;
  const product = parsed.data;
  const price = pricesToMoney(product.prices);
  if (!price) return null;

  const imageUrl = product.images?.map((img) => img.src).find((src): src is string => !!src && z.url().safeParse(src).success);
  const description = product.short_description ? stripHtml(product.short_description) : undefined;

  const offer: Offer = {
    id: encodeOfferId(host, product.id),
    product: {
      id: String(product.id),
      title: product.name,
      ...(description ? { description } : {}),
      url: product.permalink,
      ...(imageUrl ? { imageUrl } : {}),
      // Strip HTML from short_description before it can land in attributes too.
      attributes: description ? { shortDescription: description } : {},
    },
    price,
    // The Store API has no cross-store merchant identity beyond the host
    // itself (no storefront-name field on the product resource) — mirrors
    // shopify's per-shop merchant mapping exactly.
    merchant: { id: host, name: host, domain: host, platform: "woocommerce" },
    availability: product.is_in_stock ? "in_stock" : "out_of_stock",
    sourceStore: WOOCOMMERCE_STORE_ID,
    // The public Store API has no sponsored-placement concept — never invent one.
    sponsored: false,
  };
  return OfferSchema.safeParse(offer).success ? offer : null;
}

/** Extract offers from a `GET /products` array payload; unmappable entries are skipped. */
export function woocommerceSearchPayloadToOffers(payload: unknown, host: string): Offer[] {
  if (!Array.isArray(payload)) return [];
  const offers: Offer[] = [];
  for (const raw of payload) {
    const offer = mapWooProduct(raw, host);
    if (offer) offers.push(offer);
  }
  return offers;
}
