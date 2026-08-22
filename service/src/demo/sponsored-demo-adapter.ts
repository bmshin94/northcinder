/**
 * DEMO-ONLY synthetic adapter (never on by default): emits exactly one
 * clearly-labeled sponsored offer so the neutrality ranking's sponsored
 * de-prioritization (spec §4 invariants 1 & 5) can be DEMONSTRATED even when
 * live store data happens to contain no sponsored placements.
 *
 * Honesty properties, by construction:
 *  - gated behind NORTHCINDER_DEMO_SPONSORED_ADAPTER=1 (see adapters-from-env.ts);
 *  - the offer title starts with "[DEMO sponsored placement]";
 *  - the merchant domain is `demo-sponsored.invalid` (an RFC 2606 reserved
 *    TLD that can never resolve);
 *  - the manifest declares ZERO allowed hosts — it is synthetic, no network.
 *
 * The offer is deliberately CHEAP (default $19.99) so the evidence is strong:
 * despite the lowest price in the result set, the ranking must place it below
 * every organic offer, with the `sponsored_deprioritization` reason attached.
 */
import type {
  AdapterManifest,
  AdapterOfferResult,
  AdapterSearchResult,
  Offer,
  SearchQuery,
  StoreAdapter,
} from "@northcinder/protocol";
import { storeError } from "@northcinder/protocol";

export const DEMO_SPONSORED_STORE_ID = "demo-sponsored";
const DEMO_OFFER_ID = "demo-sponsored-offer-1";

export interface DemoSponsoredAdapterConfig {
  /** Offer price in minor units (default 1999 = $19.99). */
  priceMinor?: number;
}

function demoOffer(query: SearchQuery, priceMinor: number): Offer {
  return {
    id: DEMO_OFFER_ID,
    product: {
      id: DEMO_OFFER_ID,
      title: `[DEMO sponsored placement] ${query.text} — synthetic paid listing (not a real product)`,
      description:
        "Synthetic sponsored offer injected by the demo adapter to demonstrate sponsored de-prioritization. It cannot be purchased.",
      url: "https://demo-sponsored.invalid/offer/demo-sponsored-offer-1",
      attributes: {},
    },
    price: { amount: priceMinor, currency: "USD" },
    merchant: {
      id: "demo-sponsored.invalid",
      name: "Demo Sponsored Merchant (synthetic)",
      domain: "demo-sponsored.invalid",
    },
    availability: "in_stock",
    sourceStore: DEMO_SPONSORED_STORE_ID,
    // The point of this adapter: a labeled paid placement.
    sponsored: true,
  };
}

export function createDemoSponsoredAdapter(config: DemoSponsoredAdapterConfig = {}): StoreAdapter {
  const priceMinor = config.priceMinor ?? 1999;

  const manifest: AdapterManifest = {
    id: DEMO_SPONSORED_STORE_ID,
    name: "Demo sponsored-placement adapter (synthetic)",
    version: "0.2.0",
    description:
      "demo-only synthetic adapter: injects one clearly-labeled sponsored offer to demonstrate the ranking's sponsored de-prioritization; no network, gated behind NORTHCINDER_DEMO_SPONSORED_ADAPTER=1",
    permissions: { allowedHosts: [], userSession: false },
    capabilities: { checkout: false },
  };

  return {
    manifest,
    async search(query): Promise<AdapterSearchResult> {
      return { ok: true, offers: [demoOffer(query, priceMinor)] };
    },
    async getOffer(offerId): Promise<AdapterOfferResult> {
      if (offerId !== DEMO_OFFER_ID) {
        return {
          ok: false,
          error: storeError(DEMO_SPONSORED_STORE_ID, "not_found", `no demo offer ${JSON.stringify(offerId)}`, {
            retryable: false,
          }),
        };
      }
      return { ok: true, offer: demoOffer({ text: "demo" }, priceMinor) };
    },
  };
}
