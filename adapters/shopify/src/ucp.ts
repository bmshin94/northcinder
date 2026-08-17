import { z } from "zod";
import { MoneySchema, OfferSchema, type Offer } from "@northcinder/protocol";
import { parseDecimalToMinorUnits } from "@northcinder/adapter-kit";

export const STORE_ID = "shopify";

/** Offer-id codec: "sf|<shop host>|<product gid>". The gid may contain ":" and "/". */
export function encodeOfferId(host: string, productGid: string): string {
  return `sf|${host}|${productGid}`;
}
export function decodeOfferId(id: string): { host: string; productGid: string } | null {
  const parts = id.split("|");
  if (parts.length !== 3 || parts[0] !== "sf" || !parts[1] || !parts[2]) return null;
  return { host: parts[1], productGid: parts[2] };
}

/**
 * UCP catalog-search product shape (the parts we consume; extras ignored).
 * Global Catalog (live-verified 2026-07-11) carries the storefront URL on
 * each VARIANT; per-store search carries it on the product — accept both.
 */
const UcpSearchProductSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.looseObject({ html: z.string().optional(), plain: z.string().optional() }).optional(),
  url: z.url().optional(),
  price_range: z.looseObject({ min: MoneySchema }).optional(),
  variants: z
    .array(
      z.looseObject({
        id: z.string().min(1).optional(),
        url: z.url().optional(),
        price: MoneySchema.optional(),
        availability: z.looseObject({ available: z.boolean() }).optional(),
        media: z.array(z.looseObject({ type: z.string().optional(), url: z.string() })).optional(),
      }),
    )
    .optional(),
});

/**
 * Offer attribute carrying the purchasable variant gid
 * (gid://shopify/ProductVariant/<id>). Consumed by @northcinder/checkout's
 * cart-permalink rail — the literal must stay in sync with
 * SHOPIFY_VARIANT_ATTRIBUTE there.
 */
export const VARIANT_GID_ATTRIBUTE = "shopify:variantGid";

const UcpSearchPayloadSchema = z.looseObject({
  products: z.array(z.unknown()),
});

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Map one UCP search product to a protocol Offer. Returns null when the
 * product lacks the fields an Offer requires (skipped, never fabricated).
 */
export function ucpSearchProductToOffer(raw: unknown, shopHost: string): Offer | null {
  const parsed = UcpSearchProductSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const url = p.url ?? p.variants?.find((v) => v.url !== undefined)?.url;
  if (url === undefined) return null;
  const price = p.price_range?.min ?? p.variants?.find((v) => v.price)?.price;
  if (!price) return null;
  const availabilities = (p.variants ?? []).map((v) => v.availability?.available).filter((a): a is boolean => a !== undefined);
  const availability =
    availabilities.length === 0 ? "unknown" : availabilities.some(Boolean) ? "in_stock" : "out_of_stock";
  const imageUrl = p.variants?.flatMap((v) => v.media ?? []).find((m) => m.type === "image" && z.url().safeParse(m.url).success)?.url;
  const description = p.description?.html ? stripHtml(p.description.html) : p.description?.plain;
  // Prefer an available variant's gid; fall back to the first variant with one.
  const variantGid =
    p.variants?.find((v) => v.id !== undefined && v.availability?.available === true)?.id ??
    p.variants?.find((v) => v.id !== undefined)?.id;

  const offer: Offer = {
    id: encodeOfferId(shopHost, p.id),
    product: {
      id: p.id,
      title: p.title,
      ...(description ? { description } : {}),
      url,
      ...(imageUrl ? { imageUrl } : {}),
      attributes: variantGid ? { [VARIANT_GID_ATTRIBUTE]: variantGid } : {},
    },
    price,
    merchant: { id: shopHost, name: shopHost, domain: shopHost, platform: "shopify" },
    availability,
    sourceStore: STORE_ID,
    // Storefront/global catalog search is the store's own organic catalog —
    // nobody paid northcinder for placement. Mandatory declaration, spec §4.
    sponsored: false,
  };
  return OfferSchema.safeParse(offer).success ? offer : null;
}

/** Extract offers from a UCP catalog-search payload; unmappable products are skipped. */
export function ucpSearchPayloadToOffers(payload: unknown, shopHostFallback?: string): Offer[] {
  const parsed = UcpSearchPayloadSchema.safeParse(payload);
  if (!parsed.success) return [];
  const offers: Offer[] = [];
  for (const raw of parsed.data.products) {
    // Global-catalog results span shops: derive merchant from the product's
    // storefront URL host (live-verified: on the variant in global results).
    let host = shopHostFallback;
    if (!host) {
      const r = raw as { url?: string; variants?: Array<{ url?: string }> };
      const url = r.url ?? r.variants?.find((v) => v.url !== undefined)?.url;
      try {
        host = new URL(url ?? "").host;
      } catch {
        continue;
      }
    }
    const offer = ucpSearchProductToOffer(raw, host);
    if (offer) offers.push(offer);
  }
  return offers;
}

/** get_product_details payload (price is a DECIMAL STRING here, unlike search). */
const UcpProductDetailsSchema = z.looseObject({
  product: z.looseObject({
    product_id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    url: z.url(),
    image_url: z.string().optional(),
    price_range: z.looseObject({ min: z.union([z.string(), z.number()]), currency: z.string() }).optional(),
    selectedOrFirstAvailableVariant: z
      .looseObject({
        variant_id: z.string().min(1).optional(),
        price: z.union([z.string(), z.number()]).optional(),
        currency: z.string().optional(),
        available: z.boolean().optional(),
      })
      .optional(),
  }),
});

export function ucpProductDetailsToOffer(payload: unknown, shopHost: string): Offer | null {
  const parsed = UcpProductDetailsSchema.safeParse(payload);
  if (!parsed.success) return null;
  const p = parsed.data.product;
  const variant = p.selectedOrFirstAvailableVariant;
  const rawPrice = variant?.price ?? p.price_range?.min;
  const currency = variant?.currency ?? p.price_range?.currency;
  if (rawPrice === undefined || currency === undefined) return null;
  const price = parseDecimalToMinorUnits(String(rawPrice), currency);
  if (!price) return null;

  const offer: Offer = {
    id: encodeOfferId(shopHost, p.product_id),
    product: {
      id: p.product_id,
      title: p.title,
      ...(p.description ? { description: p.description } : {}),
      url: p.url,
      ...(p.image_url && z.url().safeParse(p.image_url).success ? { imageUrl: p.image_url } : {}),
      attributes: variant?.variant_id ? { [VARIANT_GID_ATTRIBUTE]: variant.variant_id } : {},
    },
    price,
    merchant: { id: shopHost, name: shopHost, domain: shopHost, platform: "shopify" },
    availability: variant?.available === undefined ? "unknown" : variant.available ? "in_stock" : "out_of_stock",
    sourceStore: STORE_ID,
    sponsored: false,
  };
  return OfferSchema.safeParse(offer).success ? offer : null;
}
