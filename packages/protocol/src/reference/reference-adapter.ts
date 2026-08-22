import type { Offer, SearchQuery } from "../schemas/core.js";
import { storeError } from "../schemas/errors.js";
import type { AdapterManifest } from "../adapter/manifest.js";
import type {
  AdapterContext,
  AdapterOfferResult,
  AdapterSearchResult,
  StoreAdapter,
} from "../adapter/store-adapter.js";

const STORE_ID = "reference";

const FIXTURE_OFFERS: Offer[] = [
  {
    id: "ref-offer-fairphone",
    product: {
      id: "ref-prod-fairphone",
      title: "Fairphone 5 128GB",
      url: "https://reference.invalid/products/fairphone-5",
      attributes: { storage: "128GB", "removable battery": "yes" },
    },
    price: { amount: 59900, currency: "EUR" },
    merchant: { id: "reference-shop", name: "Reference Shop", domain: "reference.invalid" },
    availability: "in_stock",
    shipping: { cost: { amount: 495, currency: "EUR" }, estimatedDays: { min: 2, max: 5 } },
    sourceStore: STORE_ID,
    sponsored: false,
    condition: "new",
  },
  {
    id: "ref-offer-usbhub",
    product: {
      id: "ref-prod-usbhub",
      title: "7-port USB-C hub",
      url: "https://reference.invalid/products/usb-c-hub",
      attributes: { ports: "7" },
    },
    price: { amount: 2999, currency: "EUR" },
    merchant: { id: "reference-shop", name: "Reference Shop", domain: "reference.invalid" },
    availability: "in_stock",
    sourceStore: STORE_ID,
    // Deliberately a sponsored fixture: the reference set must exercise the
    // labeled-sponsored path, so ranking tests downstream have both kinds.
    sponsored: true,
  },
];

function matches(offer: Offer, query: SearchQuery): boolean {
  const haystack = `${offer.product.title} ${Object.entries(offer.product.attributes)
    .flat()
    .join(" ")}`.toLowerCase();
  return query.text
    .toLowerCase()
    .split(/\s+/)
    .some((term) => term.length > 0 && haystack.includes(term));
}

/**
 * Minimal in-memory reference adapter. Serves as (a) the conformance
 * harness's own passing test subject and (b) a fixture store for downstream
 * service/ranking tests (service integration).
 */
export function createReferenceAdapter(): StoreAdapter {
  const manifest: AdapterManifest = {
    id: STORE_ID,
    name: "Reference in-memory adapter",
    version: "0.2.0",
    description: "In-memory fixture adapter; the conformance harness's passing reference.",
    permissions: { allowedHosts: [], userSession: false },
    capabilities: { checkout: false },
  };

  return {
    manifest,
    async search(query: SearchQuery, _ctx: AdapterContext): Promise<AdapterSearchResult> {
      const offers = FIXTURE_OFFERS.filter((o) => matches(o, query)).slice(
        0,
        query.maxResults ?? FIXTURE_OFFERS.length,
      );
      return { ok: true, offers };
    },
    async getOffer(offerId: string, _ctx: AdapterContext): Promise<AdapterOfferResult> {
      const offer = FIXTURE_OFFERS.find((o) => o.id === offerId);
      if (!offer) {
        return {
          ok: false,
          error: storeError(STORE_ID, "not_found", `no offer with id "${offerId}"`, {
            retryable: false,
          }),
        };
      }
      return { ok: true, offer };
    },
  };
}

/** Offer ids the reference adapter is guaranteed to resolve (for tests). */
export const REFERENCE_KNOWN_OFFER_ID = "ref-offer-fairphone";
/** A query guaranteed to return ≥1 offer from the reference adapter. */
export const REFERENCE_KNOWN_QUERY: SearchQuery = { text: "fairphone" };
