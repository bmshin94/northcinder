import { describe, expect, it } from "vitest";
import {
  BrowserObservationReportSchema,
  SearchRankRequestSchema,
  SearchRankResponseSchema,
  StoreStatusSchema,
  TrustRequestSchema,
  TrustResponseSchema,
} from "../src/schemas/api.js";

describe("HTTP API wire schemas", () => {
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
