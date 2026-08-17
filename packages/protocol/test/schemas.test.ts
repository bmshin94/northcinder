import { describe, expect, it } from "vitest";
import {
  BrowserObservationSchema,
  MoneySchema,
  OfferSchema,
  requiresNativeRevalidation,
  ProductSchema,
  PurchaseMandateSchema,
  RankedResultSchema,
  SearchQuerySchema,
  StoreErrorSchema,
  TrustSignalSchema,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const product = {
  id: "prod-42",
  title: "Fairphone 5 128GB",
  url: "https://shop.example.com/products/fairphone-5",
  attributes: { storage: "128GB", color: "black" },
};

const validOffer = {
  id: "offer-1",
  product,
  price: { amount: 59900, currency: "EUR" },
  merchant: { id: "shop.example.com", name: "Example Shop", domain: "shop.example.com" },
  availability: "in_stock",
  shipping: { cost: { amount: 495, currency: "EUR" }, estimatedDays: { min: 2, max: 5 } },
  sourceStore: "reference",
  sponsored: false,
};

// ---------------------------------------------------------------------------
// Money — integer minor units only
// ---------------------------------------------------------------------------

describe("MoneySchema", () => {
  it("accepts integer minor units with an ISO-4217 uppercase currency", () => {
    expect(MoneySchema.parse({ amount: 59900, currency: "EUR" })).toEqual({
      amount: 59900,
      currency: "EUR",
    });
  });

  it("rejects fractional amounts (floats are not money)", () => {
    expect(MoneySchema.safeParse({ amount: 599.0001, currency: "EUR" }).success).toBe(false);
  });

  it("rejects negative amounts and lowercase/invalid currency codes", () => {
    expect(MoneySchema.safeParse({ amount: -1, currency: "EUR" }).success).toBe(false);
    expect(MoneySchema.safeParse({ amount: 100, currency: "eur" }).success).toBe(false);
    expect(MoneySchema.safeParse({ amount: 100, currency: "EURO" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Offer — sponsored is MANDATORY (spec §4 invariant 1)
// ---------------------------------------------------------------------------

describe("OfferSchema", () => {
  it("parses a fully-specified offer, preserving provenance and price", () => {
    const parsed = OfferSchema.parse(validOffer);
    expect(parsed.sourceStore).toBe("reference");
    expect(parsed.price).toEqual({ amount: 59900, currency: "EUR" });
    expect(parsed.sponsored).toBe(false);
    expect(parsed.merchant.domain).toBe("shop.example.com");
  });

  it("REJECTS an offer that does not declare sponsored — no default, ever", () => {
    const { sponsored: _sponsored, ...undeclared } = validOffer;
    const result = OfferSchema.safeParse(undeclared);
    expect(result.success).toBe(false);
    if (!result.success) {
      const sponsoredIssue = result.error.issues.find((i) => i.path.join(".") === "sponsored");
      expect(sponsoredIssue).toBeDefined();
    }
  });

  it("rejects an offer without sourceStore provenance", () => {
    const { sourceStore: _s, ...noProvenance } = validOffer;
    expect(OfferSchema.safeParse(noProvenance).success).toBe(false);
  });

  it("requires browser provenance to bind sourceStore and acquisition together", () => {
    const provenanceStripped = { ...validOffer, sourceStore: "agent_browser" };
    expect(OfferSchema.safeParse(provenanceStripped).success).toBe(false);
    const nativeWithObservedAcquisition = {
      ...validOffer,
      acquisition: {
        kind: "agent_observed" as const,
        observedAt: "2026-08-16T10:00:00.000Z",
        receivedAt: "2026-08-16T10:01:00.000Z",
        placement: "unknown" as const,
      },
    };
    expect(OfferSchema.safeParse(nativeWithObservedAcquisition).success).toBe(false);
    const validBrowserOffer = { ...nativeWithObservedAcquisition, sourceStore: "agent_browser" };
    expect(OfferSchema.safeParse(validBrowserOffer).success).toBe(true);
    expect(requiresNativeRevalidation(provenanceStripped)).toBe(true);
    expect(requiresNativeRevalidation(nativeWithObservedAcquisition)).toBe(true);
    expect(requiresNativeRevalidation(validOffer)).toBe(false);
  });

  it("rejects unknown availability states", () => {
    expect(OfferSchema.safeParse({ ...validOffer, availability: "maybe" }).success).toBe(false);
    for (const ok of ["in_stock", "out_of_stock", "preorder", "unknown"]) {
      expect(OfferSchema.safeParse({ ...validOffer, availability: ok }).success).toBe(true);
    }
  });
});

describe("ProductSchema", () => {
  it("requires a real URL", () => {
    expect(ProductSchema.safeParse({ ...product, url: "not-a-url" }).success).toBe(false);
  });

  it("rejects affiliate and tracking parameters at the shared outbound-offer boundary", () => {
    for (const suffix of [
      "?tag=paid-partner-20",
      "?affiliate_id=publisher-42",
      "?utm_source=seller-campaign",
      "?mkcid=1&mkrid=711-53200-19255-0",
    ]) {
      expect(ProductSchema.safeParse({ ...product, url: `${product.url}${suffix}` }).success).toBe(false);
    }
    expect(ProductSchema.safeParse({ ...product, url: `${product.url}?variant=black-large` }).success).toBe(true);
  });
});

describe("BrowserObservationSchema", () => {
  const observation = {
    productUrl: "https://shop.example.com/products/fairphone-5?variant=black",
    title: "Fairphone 5 128GB",
    price: { amount: 59900, currency: "EUR" },
    availability: "in_stock",
    merchantName: "Example Shop",
    attributes: { storage: "128GB", color: "black" },
    placement: "organic",
    observedAt: "2026-08-16T10:00:00.000Z",
  } as const;

  it("accepts only the comparison facts an agent observed on an HTTPS product page", () => {
    const parsed = BrowserObservationSchema.parse(observation);

    expect(parsed.productUrl).toContain("shop.example.com");
    expect(parsed.placement).toBe("organic");
    expect(parsed.price.amount).toBe(59900);
  });

  it("rejects caller-supplied ranking, trust, credential, and raw-page fields", () => {
    for (const extra of [
      { score: 100 },
      { rank: 1 },
      { reasons: [{ criterion: "price", detail: "trust me" }] },
      { trust: "trusted" },
      { checkoutCapability: "automated" },
      { cookie: "session=buyer-secret" },
      { authorization: "Bearer buyer-secret" },
      { rawHtml: "<main>entire merchant page</main>" },
      { screenshot: "data:image/png;base64,AAAA" },
      { headers: { "set-cookie": "session=buyer-secret" } },
    ]) {
      expect(BrowserObservationSchema.safeParse({ ...observation, ...extra }).success).toBe(false);
    }
  });

  it("rejects non-HTTPS, credential-bearing, and tracked product URLs", () => {
    for (const productUrl of [
      "http://shop.example.com/products/fairphone-5",
      "https://buyer:secret@shop.example.com/products/fairphone-5",
      "https://shop.example.com/products/fairphone-5?utm_source=agent",
      "https://shop.example.com/products/fairphone-5?affiliate_id=publisher-42",
    ]) {
      expect(BrowserObservationSchema.safeParse({ ...observation, productUrl }).success).toBe(false);
    }
  });

  it("rejects malformed money and bounded-field overflows", () => {
    const tooManyAttributes = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`field-${index}`, "value"]),
    );
    for (const invalid of [
      { ...observation, price: { amount: 599.99, currency: "EUR" } },
      { ...observation, price: { amount: -1, currency: "EUR" } },
      { ...observation, price: { amount: 59900, currency: "eur" } },
      { ...observation, price: { amount: 59900, currency: "EUR", display: "EUR 599" } },
      { ...observation, title: "x".repeat(501) },
      { ...observation, merchantName: "x".repeat(201) },
      { ...observation, attributes: tooManyAttributes },
      { ...observation, attributes: { ["k".repeat(101)]: "value" } },
      { ...observation, attributes: { feature: "x".repeat(501) } },
      { ...observation, shipping: { estimatedDays: { min: 5, max: 4 } } },
    ]) {
      expect(BrowserObservationSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// SearchQuery — free text + structured criteria
// ---------------------------------------------------------------------------

describe("SearchQuerySchema", () => {
  it("accepts free text plus structured criteria", () => {
    const parsed = SearchQuerySchema.parse({
      text: "repairable smartphone",
      maxPrice: { amount: 70000, currency: "EUR" },
      mustHaveAttributes: ["removable battery"],
      deliveryBy: "2026-07-20",
      ethicsFlags: ["fair-trade"],
    });
    expect(parsed.maxPrice).toEqual({ amount: 70000, currency: "EUR" });
    expect(parsed.mustHaveAttributes).toEqual(["removable battery"]);
    expect(parsed.deliveryBy).toBe("2026-07-20");
  });

  it("accepts bare free text (all criteria optional)", () => {
    expect(SearchQuerySchema.parse({ text: "usb-c hub" }).text).toBe("usb-c hub");
  });

  it("rejects empty text and malformed deliveryBy dates", () => {
    expect(SearchQuerySchema.safeParse({ text: "" }).success).toBe(false);
    expect(SearchQuerySchema.safeParse({ text: "x", deliveryBy: "20-07-2026" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RankedResult — reasons[] are mandatory and machine-readable (spec §4 invariant 5)
// ---------------------------------------------------------------------------

describe("RankedResultSchema", () => {
  it("parses offer + score + machine-readable reasons", () => {
    const parsed = RankedResultSchema.parse({
      offer: validOffer,
      score: 0.92,
      reasons: [
        { criterion: "price", detail: "cheapest matching offer: EUR 599.00 vs EUR 649.00 median" },
      ],
    });
    expect(parsed.reasons[0]?.criterion).toBe("price");
  });

  it("REJECTS a result with zero reasons — every recommendation states why", () => {
    expect(
      RankedResultSchema.safeParse({ offer: validOffer, score: 0.9, reasons: [] }).success,
    ).toBe(false);
  });

  it("rejects reasons with unknown criteria (machine-readability)", () => {
    expect(
      RankedResultSchema.safeParse({
        offer: validOffer,
        score: 0.9,
        reasons: [{ criterion: "vibes", detail: "felt right" }],
      }).success,
    ).toBe(false);
  });

  it("rejects non-finite scores", () => {
    expect(
      RankedResultSchema.safeParse({
        offer: validOffer,
        score: Number.NaN,
        reasons: [{ criterion: "price", detail: "x" }],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TrustSignal — level + evidence (spec §4 invariant 6)
// ---------------------------------------------------------------------------

describe("TrustSignalSchema", () => {
  it("parses level + evidence", () => {
    const parsed = TrustSignalSchema.parse({
      merchantId: "shop.example.com",
      level: "flagged",
      evidence: [{ source: "seed-heuristic", detail: "unknown merchant, no track record" }],
    });
    expect(parsed.level).toBe("flagged");
    expect(parsed.evidence[0]?.source).toBe("seed-heuristic");
  });

  it("rejects a trust signal without evidence", () => {
    expect(
      TrustSignalSchema.safeParse({ merchantId: "m", level: "trusted", evidence: [] }).success,
    ).toBe(false);
  });

  it("only admits the four defined levels", () => {
    for (const level of ["trusted", "known", "unknown", "flagged"]) {
      expect(
        TrustSignalSchema.safeParse({
          merchantId: "m",
          level,
          evidence: [{ source: "s", detail: "d" }],
        }).success,
      ).toBe(true);
    }
    expect(
      TrustSignalSchema.safeParse({
        merchantId: "m",
        level: "verified-ish",
        evidence: [{ source: "s", detail: "d" }],
      }).success,
    ).toBe(false);
  });

  it("evidence accepts optional fetchedAt + url (re-check pointer) — additive, backward compatible", () => {
    const parsed = TrustSignalSchema.parse({
      merchantId: "www.allbirds.com",
      level: "known",
      evidence: [
        {
          source: "rdap",
          detail: "domain registered 2002-01-09 (RDAP)",
          fetchedAt: "2026-07-11T10:00:00.000Z",
          url: "https://rdap.org/domain/allbirds.com",
        },
        // Old-shape evidence line (no fetchedAt/url) still validates.
        { source: "seed-list", detail: "merchant is on the allow seed list" },
      ],
    });
    expect(parsed.evidence[0]?.fetchedAt).toBe("2026-07-11T10:00:00.000Z");
    expect(parsed.evidence[0]?.url).toBe("https://rdap.org/domain/allbirds.com");
    expect(parsed.evidence[1]?.fetchedAt).toBeUndefined();
  });

  it("rejects a non-datetime fetchedAt and a non-URL url", () => {
    const base = { merchantId: "m", level: "known" };
    expect(
      TrustSignalSchema.safeParse({
        ...base,
        evidence: [{ source: "s", detail: "d", fetchedAt: "yesterday" }],
      }).success,
    ).toBe(false);
    expect(
      TrustSignalSchema.safeParse({
        ...base,
        evidence: [{ source: "s", detail: "d", url: "not a url" }],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PurchaseMandate — AP2-shaped (spec §4 invariant 4)
// ---------------------------------------------------------------------------

const validMandate = {
  id: "mandate-7f3a",
  intent: "Buy Fairphone 5 128GB from Example Shop for at most EUR 604.95 incl. shipping",
  constraints: {
    offerId: "offer-1",
    merchantId: "shop.example.com",
    maxAmount: { amount: 60495, currency: "EUR" },
  },
  issuedAt: "2026-07-04T10:00:00Z",
  expiresAt: "2026-07-04T10:15:00Z",
  nonce: "c2f9d4e8a1b34567",
  signature: {
    algorithm: "ed25519",
    publicKey: "MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=",
    value: "dGhpcy1pcy1hLXNpZ25hdHVyZQ==",
  },
};

describe("PurchaseMandateSchema", () => {
  it("parses an AP2-shaped mandate with intent, constraints, expiry, nonce, signature", () => {
    const parsed = PurchaseMandateSchema.parse(validMandate);
    expect(parsed.constraints.maxAmount).toEqual({ amount: 60495, currency: "EUR" });
    expect(parsed.signature.algorithm).toBe("ed25519");
    expect(parsed.nonce).toBe("c2f9d4e8a1b34567");
  });

  it("rejects a mandate missing any hard-gate field (expiry, nonce, signature, constraints)", () => {
    for (const field of ["expiresAt", "nonce", "signature", "constraints"] as const) {
      const { [field]: _omitted, ...rest } = validMandate;
      expect(PurchaseMandateSchema.safeParse(rest).success).toBe(false);
    }
  });

  it("rejects short nonces (replay-protection entropy floor)", () => {
    expect(
      PurchaseMandateSchema.safeParse({ ...validMandate, nonce: "abc" }).success,
    ).toBe(false);
  });

  it("rejects non-ISO expiry timestamps", () => {
    expect(
      PurchaseMandateSchema.safeParse({ ...validMandate, expiresAt: "tomorrow" }).success,
    ).toBe(false);
  });

  it("rejects a mandate whose expiresAt is not after issuedAt (reversed pair)", () => {
    expect(
      PurchaseMandateSchema.safeParse({
        ...validMandate,
        issuedAt: "2026-07-04T10:15:00Z",
        expiresAt: "2026-07-04T10:00:00Z",
      }).success,
    ).toBe(false);
    // Equal timestamps are also invalid — expiry must be strictly after issuance.
    expect(
      PurchaseMandateSchema.safeParse({
        ...validMandate,
        issuedAt: "2026-07-04T10:00:00Z",
        expiresAt: "2026-07-04T10:00:00Z",
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// StoreError — structured errors
// ---------------------------------------------------------------------------

describe("StoreErrorSchema", () => {
  it("parses a structured store error", () => {
    const parsed = StoreErrorSchema.parse({
      code: "timeout",
      message: "search timed out after 1000ms",
      store: "ebay",
      retryable: true,
    });
    expect(parsed.code).toBe("timeout");
    expect(parsed.retryable).toBe(true);
  });

  it("rejects unknown error codes", () => {
    expect(
      StoreErrorSchema.safeParse({
        code: "oops",
        message: "m",
        store: "s",
        retryable: false,
      }).success,
    ).toBe(false);
  });
});
