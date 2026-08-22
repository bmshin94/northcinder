import { describe, expect, it } from "vitest";
import {
  BrowserObservationReportSchema,
  GetOfferRequestSchema,
  GetOfferResponseSchema,
  SearchRankRequestSchema,
  SearchRankResponseSchema,
  StoreStatusSchema,
  SourceStatusSchema,
  TrustRequestSchema,
  TrustResponseSchema,
} from "../src/schemas/api.js";

describe("HTTP API wire schemas", () => {
  it("accepts only a strict exact-offer request and adapter-result response", () => {
    expect(GetOfferRequestSchema.parse({ store: "reference", offerId: "off-1" })).toEqual({ store: "reference", offerId: "off-1" });
    expect(GetOfferRequestSchema.safeParse({ store: "reference", offerId: "off-1", query: { text: "no" } }).success).toBe(false);
    expect(GetOfferResponseSchema.parse({
      ok: true,
      offer: {
        id: "off-1", product: { id: "p-1", title: "Hub", url: "https://shop.example/p1", attributes: {} },
        price: { amount: 2999, currency: "EUR" }, merchant: { id: "m-1", name: "Shop", domain: "shop.example" },
        availability: "in_stock", sourceStore: "reference", sponsored: false,
      },
    })).toMatchObject({ ok: true, offer: { id: "off-1" } });
  });
  it("accepts a valid search+rank request and rejects a query without text", () => {
    expect(SearchRankRequestSchema.parse({ query: { text: "usb-c hub" } }).query.text).toBe(
      "usb-c hub",
    );
    expect(SearchRankRequestSchema.safeParse({ query: { text: "" } }).success).toBe(false);
    expect(SearchRankRequestSchema.safeParse({}).success).toBe(false);
  });

  it("rejects raw payment fields instead of silently stripping them at the protocol boundary", () => {
    expect(SearchRankRequestSchema.safeParse({ query: { text: "usb-c hub", cardNumber: "4242424242424242" } }).success).toBe(false);
    expect(SearchRankRequestSchema.safeParse({ query: { text: "usb-c hub" }, cvv: "123" }).success).toBe(false);
    expect(TrustRequestSchema.safeParse({
      merchant: { id: "m1", name: "M", domain: "s.example" },
      cvc: "123",
    }).success).toBe(false);
  });

  it("bounds browser handoff items while preserving malformed items for per-item reporting", () => {
    const malformedObservation = { rawHtml: "<main>not accepted as an observation</main>" };
    expect(
      SearchRankRequestSchema.parse({
        query: { text: "usb-c hub" },
        browserObservations: [malformedObservation],
      }).browserObservations,
    ).toEqual([malformedObservation]);
    expect(
      SearchRankRequestSchema.safeParse({
        query: { text: "usb-c hub" },
        browserObservations: Array.from({ length: 51 }, () => ({})),
      }).success,
    ).toBe(false);
  });

  it("keeps per-item browser rejection reports strict and bounded to stable reason codes", () => {
    expect(
      BrowserObservationReportSchema.parse({
        submitted: 2,
        accepted: 1,
        rejected: [{ index: 0, code: "unsafe_content", message: "unsafe content" }],
      }),
    ).toMatchObject({ submitted: 2, accepted: 1 });
    expect(
      BrowserObservationReportSchema.safeParse({
        submitted: 1,
        accepted: 0,
        rejected: [{ index: 0, code: "credential_detected", message: "rejected" }],
      }).success,
    ).toBe(false);
    expect(
      BrowserObservationReportSchema.safeParse({
        submitted: 1,
        accepted: 0,
        rejected: [{ index: 0, code: "invalid_observation", message: "rejected", raw: {} }],
      }).success,
    ).toBe(false);
  });

  it("rejects a browser report whose accepted and rejected totals do not equal submitted", () => {
    expect(
      BrowserObservationReportSchema.safeParse({
        submitted: 2,
        accepted: 2,
        rejected: [{ index: 0, code: "invalid_observation", message: "rejected" }],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate rejected indexes in a browser report", () => {
    expect(
      BrowserObservationReportSchema.safeParse({
        submitted: 2,
        accepted: 0,
        rejected: [
          { index: 0, code: "invalid_observation", message: "rejected" },
          { index: 0, code: "unsafe_content", message: "rejected again" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-range rejected indexes in a browser report", () => {
    expect(
      BrowserObservationReportSchema.safeParse({
        submitted: 1,
        accepted: 0,
        rejected: [{ index: 1, code: "invalid_observation", message: "rejected" }],
      }).success,
    ).toBe(false);
  });

  it("StoreStatus is a discriminated union: ok carries offerCount, error carries a StoreError", () => {
    expect(
      StoreStatusSchema.parse({ store: "reference", ok: true, offerCount: 2, durationMs: 12 }),
    ).toMatchObject({ ok: true, offerCount: 2 });
    expect(
      StoreStatusSchema.parse({
        store: "broken",
        ok: false,
        durationMs: 1500,
        error: { code: "timeout", message: "timed out after 1500ms", store: "broken", retryable: true },
      }),
    ).toMatchObject({ ok: false, error: { code: "timeout" } });
    // ok:false without a structured error is invalid.
    expect(
      StoreStatusSchema.safeParse({ store: "broken", ok: false, durationMs: 1 }).success,
    ).toBe(false);
  });

  it("keeps successful child-source rows strict while preserving structured retry detail", () => {
    expect(SourceStatusSchema.parse({ source: "shop.example", ok: true, offerCount: 2 })).toMatchObject({ ok: true });
    expect(SourceStatusSchema.parse({
      source: "down.example", ok: false,
      error: { store: "shopify", code: "rate_limited", message: "source rate limit reached", retryable: true, retryAfterMs: 250 },
    })).toMatchObject({ ok: false, error: { retryAfterMs: 250 } });
    expect(SourceStatusSchema.safeParse({ source: "down.example", ok: false }).success).toBe(false);
    expect(SourceStatusSchema.safeParse({ source: "shop.example", ok: true, offerCount: 1, headers: {} }).success).toBe(false);
    expect(SourceStatusSchema.safeParse({
      source: "down.example", ok: false,
      error: { store: "shopify", code: "timeout", message: "timed out", retryable: true, details: { authorization: "Bearer secret", rawBody: "secret", profileUrl: "https://secret.example" } },
    }).success).toBe(false);
    expect(SourceStatusSchema.safeParse({
      source: "down.example", ok: false,
      error: { store: "shopify", code: "timeout", message: "Authorization: Bearer secret", retryable: true },
    }).success).toBe(false);
    for (const source of ["*.example.com", "HTTPS://shop.example/path", "user@shop.example", "Shop.Example", `${"a".repeat(64)}.example`]) {
      expect(SourceStatusSchema.safeParse({ source, ok: true, offerCount: 0 }).success).toBe(false);
    }
  });

  it("search response requires ranked results with reasons and per-store statuses", () => {
    const res = SearchRankResponseSchema.parse({
      results: [
        {
          offer: {
            id: "o1",
            product: { id: "p1", title: "Hub", url: "https://s.example/p1", attributes: {} },
            price: { amount: 2999, currency: "EUR" },
            merchant: { id: "m1", name: "M", domain: "s.example" },
            availability: "in_stock",
            sourceStore: "reference",
            sponsored: false,
          },
          score: 45,
          reasons: [{ criterion: "price", detail: "lowest price: 2999 EUR" }],
        },
      ],
      storeStatuses: [{ store: "reference", ok: true, offerCount: 1, durationMs: 3 }],
    });
    expect(res.results[0]!.reasons[0]!.criterion).toBe("price");
    // Empty reasons must fail.
    expect(
      SearchRankResponseSchema.safeParse({
        results: [{ ...res.results[0]!, reasons: [] }],
        storeStatuses: res.storeStatuses,
      }).success,
    ).toBe(false);
    expect(
      SearchRankResponseSchema.safeParse({
        results: [res.results[0]!, res.results[0]!],
        storeStatuses: res.storeStatuses,
      }).success,
    ).toBe(false);

    const manyResults = Array.from({ length: 25 }, (_, index) => ({
      ...res.results[0]!,
      offer: {
        ...res.results[0]!.offer,
        id: `offer-${index}`,
        product: {
          ...res.results[0]!.offer.product,
          id: `product-${index}`,
          url: `https://s.example/p${index}`,
        },
      },
    }));
    expect(
      SearchRankResponseSchema.safeParse({ results: manyResults, storeStatuses: res.storeStatuses }).success,
    ).toBe(true);
    expect(
      SearchRankResponseSchema.safeParse({
        results: Array.from({ length: 1_001 }, (_, index) => ({
          ...manyResults[0]!,
          offer: { ...manyResults[0]!.offer, id: `offer-${index}` },
        })),
        storeStatuses: res.storeStatuses,
      }).success,
    ).toBe(false);
  });

  it("trust request takes a merchant; response is a TrustSignal with non-empty evidence", () => {
    expect(
      TrustRequestSchema.parse({ merchant: { id: "m1", name: "M", domain: "s.example" } }).merchant
        .domain,
    ).toBe("s.example");
    expect(
      TrustResponseSchema.safeParse({ merchantId: "m1", level: "flagged", evidence: [] }).success,
    ).toBe(false);
  });
});
