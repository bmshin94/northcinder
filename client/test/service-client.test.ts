import { describe, expect, it } from "vitest";
import { createServiceClient } from "../src/service-client.js";

describe("local MCP service client error boundary", () => {
  it("passes normalized browser observations to the buyer-run engine with the bound query", async () => {
    let requestBody: unknown;
    const client = createServiceClient({
      serviceUrl: "http://127.0.0.1:8787",
      clientKey: "test-client-key-0123456789",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ results: [], storeStatuses: [], registeredStores: [] }));
      },
    });

    const observations = [
      {
        productUrl: "https://shop.example/products/fairphone-5",
        title: "Fairphone 5",
        price: { amount: 59900, currency: "EUR" },
        availability: "in_stock" as const,
        merchantName: "Example Shop",
        placement: "organic" as const,
        observedAt: "2026-08-16T10:00:00.000Z",
      },
    ];
    const result = await client.search({ text: "repairable phone" }, { browserObservations: observations });

    expect(result.ok).toBe(true);
    expect(requestBody).toEqual({ query: { text: "repairable phone" }, browserObservations: observations });
  });

  it("forwards mixed-validity browser items unchanged and verifies the engine's per-item report", async () => {
    let requestBody: unknown;
    const browserObservationReport = {
      submitted: 2,
      accepted: 1,
      rejected: [{ index: 0, code: "invalid_observation" as const, message: "observation does not match the browser handoff schema" }],
    };
    const client = createServiceClient({
      serviceUrl: "http://127.0.0.1:8787",
      clientKey: "test-client-key-0123456789",
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ results: [], storeStatuses: [], browserObservationReport }));
      },
    });
    const validObservation = {
      productUrl: "https://shop.example/products/fairphone-5",
      title: "Fairphone 5",
      price: { amount: 59900, currency: "EUR" },
      availability: "in_stock",
      merchantName: "Example Shop",
      placement: "organic",
      observedAt: "2026-08-16T10:00:00.000Z",
    };
    const observations: unknown[] = [{ ...validObservation, score: 999, trust: "trusted" }, validObservation];

    const result = await client.search({ text: "repairable phone" }, { browserObservations: observations });

    expect(result).toEqual({
      ok: true,
      data: { results: [], storeStatuses: [], browserObservationReport },
    });
    expect(requestBody).toEqual({ query: { text: "repairable phone" }, browserObservations: observations });
  });

  it("does not return the configured service coordinate to the MCP host", async () => {
    const privateServiceUrl = "https://service.private.example:8443/internal";
    const client = createServiceClient({
      serviceUrl: privateServiceUrl,
      clientKey: "test-client-key-0123456789",
      timeoutMs: 10,
      fetchImpl: async () => { throw new Error("offline"); },
    });

    const result = await client.search({ text: "shoes" });
    expect(result).toEqual({
      ok: false,
      error: { code: "service_unreachable", message: "configured NorthCinder engine unavailable" },
    });
    expect(JSON.stringify(result)).not.toContain(privateServiceUrl);
    expect(JSON.stringify(result)).not.toContain("service.private.example");
  });

  it("does not return an upstream error body to the MCP host", async () => {
    const privateDetail = "database shard and operator account details";
    const client = createServiceClient({
      serviceUrl: "https://service.private.example",
      clientKey: "test-client-key-0123456789",
      fetchImpl: async () => new Response(JSON.stringify({ code: "internal", message: privateDetail }), { status: 500 }),
    });

    const result = await client.search({ text: "shoes" });
    expect(result).toEqual({
      ok: false,
      error: { code: "service_error", message: "configured NorthCinder engine error (HTTP 500)" },
    });
    expect(JSON.stringify(result)).not.toContain(privateDetail);
  });
});
