import type { Offer } from "../schemas/core.js";
import type { AdapterManifest } from "../adapter/manifest.js";
import type {
  AdapterContext,
  AdapterOfferResult,
  AdapterSearchResult,
  StoreAdapter,
} from "../adapter/store-adapter.js";

/**
 * Deliberately-broken reference adapter. It exists to prove the conformance
 * harness catches real defects with specific errors:
 *
 *  1. Manifest declares out-of-scope hosts: a global wildcard and a URL with
 *     a scheme+path (permission-scope violation).
 *  2. `search` hangs forever — it never settles, instead of returning a
 *     structured timeout/unavailable error inside the budget.
 *  3. `getOffer` returns an offer that does NOT declare `sponsored`
 *     (the mandatory paid-placement declaration is missing).
 *
 * DO NOT fix this adapter. If it starts passing conformance, the harness
 * is broken.
 */
export function createBrokenReferenceAdapter(): StoreAdapter {
  // Intentionally invalid permission scope — bypasses the schema on purpose
  // (a hostile/buggy adapter would not run the schema either).
  const manifest = {
    id: "broken-reference",
    name: "Deliberately broken reference adapter",
    version: "0.1.0",
    permissions: {
      allowedHosts: ["*", "https://evil.example/steal"],
      userSession: false,
    },
    capabilities: { checkout: false },
  } as AdapterManifest;

  // Offer with `sponsored` deliberately undeclared.
  const offerMissingSponsored = {
    id: "broken-offer-1",
    product: {
      id: "broken-prod-1",
      title: "Suspiciously great deal",
      url: "https://reference.invalid/products/deal",
      attributes: {},
    },
    price: { amount: 100, currency: "EUR" },
    merchant: { id: "reference-shop", name: "Reference Shop", domain: "reference.invalid" },
    availability: "in_stock",
    sourceStore: "broken-reference",
    // sponsored: ABSENT on purpose
  } as unknown as Offer;

  return {
    manifest,
    search(_query, _ctx: AdapterContext): Promise<AdapterSearchResult> {
      // Hangs forever — the defect under test.
      return new Promise<AdapterSearchResult>(() => {});
    },
    async getOffer(_offerId: string, _ctx: AdapterContext): Promise<AdapterOfferResult> {
      return { ok: true, offer: offerMissingSponsored };
    },
  };
}
