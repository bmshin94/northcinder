import type { Merchant, TrustEvidence, TrustSignal } from "@northcinder/protocol";

/**
 * Merchant trust (spec §4 invariant 6). The provider interface is what the
 * rest of the service depends on — the seed implementation below is the MVP
 * stand-in that the buyer-outcome data network replaces later without
 * touching callers.
 */
export interface TrustProvider {
  trustSignal(merchant: Merchant): Promise<TrustSignal>;
}

/** A seed entry: a domain (exact or suffix-matched against subdomains) + why. */
export interface TrustSeedEntry {
  domain: string;
  detail: string;
}

export interface TrustSeed {
  /** Explicitly vetted merchants → `trusted`. */
  allow: TrustSeedEntry[];
  /** Explicitly bad merchants → `flagged`. Deny beats allow. */
  deny: TrustSeedEntry[];
  /**
   * Major-platform heuristic → `known`: storefronts on established platforms
   * clear the "is this even a real store" bar without being vetted merchants.
   * Matched ONLY against the merchant's DOMAIN (verifiable). The seller-declared
   * `Merchant.platform` string is deliberately ignored: it is store-supplied
   * data and must never be able to raise a trust level (spec §4 invariant 1 —
   * no seller-controlled input ever moves rank upward).
   */
  knownPlatformDomains: TrustSeedEntry[];
}

/** Cheaply-checkable defaults (no network calls — deterministic and offline). */
export const DEFAULT_TRUST_SEED: TrustSeed = {
  allow: [],
  deny: [],
  knownPlatformDomains: [
    { domain: "myshopify.com", detail: "storefront hosted on Shopify" },
    { domain: "ebay.com", detail: "listing on eBay" },
    { domain: "etsy.com", detail: "shop on Etsy" },
    { domain: "amazon.com", detail: "listing on Amazon" },
  ],
};

/** True when `domain` equals `seedDomain` or is a subdomain of it. */
function domainMatches(domain: string, seedDomain: string): boolean {
  const d = domain.toLowerCase();
  const s = seedDomain.toLowerCase();
  return d === s || d.endsWith(`.${s}`);
}

function findEntry(entries: TrustSeedEntry[], domain: string): TrustSeedEntry | undefined {
  return entries.find((e) => domainMatches(domain, e.domain));
}

/**
 * Seeded heuristic trust. Resolution order (first match wins):
 *   1. deny list        → flagged
 *   2. allow list       → trusted
 *   3. platform match   → known
 *   4. everything else  → UNKNOWN, explicit + evidenced (never silently
 *      trusted; spec §4.6 — "flagged" is reserved for deny-listed evidence)
 */
export function createSeedTrustProvider(seed: Partial<TrustSeed> = {}): TrustProvider {
  const resolved: TrustSeed = {
    allow: seed.allow ?? DEFAULT_TRUST_SEED.allow,
    deny: seed.deny ?? DEFAULT_TRUST_SEED.deny,
    knownPlatformDomains: seed.knownPlatformDomains ?? DEFAULT_TRUST_SEED.knownPlatformDomains,
  };

  return {
    async trustSignal(merchant: Merchant): Promise<TrustSignal> {
      const denied = findEntry(resolved.deny, merchant.domain);
      if (denied !== undefined) {
        return signal(merchant, "flagged", [
          { source: "seed-list", detail: `deny-listed: ${denied.detail}` },
        ]);
      }

      const allowed = findEntry(resolved.allow, merchant.domain);
      if (allowed !== undefined) {
        return signal(merchant, "trusted", [
          { source: "seed-list", detail: `allow-listed: ${allowed.detail}` },
        ]);
      }

      const platform = findEntry(resolved.knownPlatformDomains, merchant.domain);
      if (platform !== undefined) {
        return signal(merchant, "known", [
          { source: "platform-heuristic", detail: platform.detail },
        ]);
      }
      // NOTE: merchant.platform (a seller-declared string) is intentionally NOT
      // consulted — a self-claimed "shopify" on evil.example must stay unknown.

      // Default: unmatched merchants are explicitly UNKNOWN, with the reason
      // stated (invariant 6: never SILENTLY trusted — the signal + evidence
      // are always present, and "unknown" earns zero ranking points).
      // "flagged" (−40) is reserved for deny-listed evidence: absence of
      // history is not the same claim as evidence of harm.
      return signal(merchant, "unknown", [
        {
          source: "default-unknown",
          detail: `merchant "${merchant.id}" (${merchant.domain}) is not in the trust seed and has no buyer-outcome history — explicitly unknown, never silently trusted`,
        },
      ]);
    },
  };
}

function signal(
  merchant: Merchant,
  level: TrustSignal["level"],
  evidence: TrustEvidence[],
): TrustSignal {
  return { merchantId: merchant.id, level, evidence };
}
