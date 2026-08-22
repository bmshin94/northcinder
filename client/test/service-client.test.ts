import { describe, expect, it } from "vitest";
import { createReferenceAdapter } from "@northcinder/protocol";
import { createApp, createOrchestrator, createSeedTrustProvider } from "@northcinder/service";
import { createServiceClient } from "../src/service-client.js";

describe("local MCP service client error boundary", () => {
  it("posts an exact offer request and preserves Retry-After on failure", async () => {
    let path = "";
    const client = createServiceClient({
      serviceUrl: "http://127.0.0.1:8787",
      fetchImpl: async (input) => {
        path = String(input);
        return new Response(JSON.stringify({ code: "rate_limited", message: "busy" }), { status: 429, headers: { "Retry-After": "60" } });
      },
    });
    await expect(client.getOffer("reference", "off-1")).resolves.toEqual({
      ok: false, error: { code: "service_error", message: "configured NorthCinder engine error (HTTP 429)", retryAfterMs: 60_000 },
    });
    expect(path).toBe("http://127.0.0.1:8787/v1/offer");
  });

  it("retains the typed store error fields returned by an exact-offer refresh", async () => {
    const client = createServiceClient({
      serviceUrl: "http://127.0.0.1:8787",
      fetchImpl: async () => new Response(JSON.stringify({
        ok: false, error: { store: "reference", code: "rate_limited", message: "busy", retryable: true, retryAfterMs: 60_000, details: { provider: "fixture" } },
      })),
    });
    await expect(client.getOffer("reference", "off-1")).resolves.toEqual({
      ok: false,
      error: { store: "reference", code: "rate_limited", message: "busy", retryable: true, retryAfterMs: 60_000, details: { provider: "fixture" } },
    });
  });
  it("reaches health through the real client without adding a local Authorization header", async () => {
    let requestUrl = "";
    let requestHeaders: Headers | undefined;
    const client = createServiceClient({
      serviceUrl: "http://127.0.0.1:8787",
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({
          ok: true,
          service: "northcinder",
          version: "0.2.0",
          discoverySources: [
            { store: "amazon", status: "not_configured" },
            { store: "ebay", status: "not_configured" },
            { store: "etsy", status: "not_configured" },
            { store: "shopify", status: "not_configured" },
            { store: "woocommerce", status: "not_configured" },
          ],
        }));
      },
    });
    const health = (client as typeof client & { health?: () => Promise<unknown> }).health;

    expect(health).toBeTypeOf("function");
    if (health === undefined) return;
    const result = await health();

    expect(requestUrl).toBe("http://127.0.0.1:8787/health");
    expect([...requestHeaders!.entries()]).toEqual([]);
    expect(result).toMatchObject({ ok: true, data: { ok: true, service: "northcinder" } });
  });

  it("sends the exact configured bearer key on a self-hosted health request", async () => {
    let requestHeaders: Headers | undefined;
    const client = createServiceClient({
      serviceUrl: "https://engine.example",
      clientKey: "health-test-key-0123456789",
      fetchImpl: async (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({
          ok: true,
          service: "northcinder",
          version: "0.2.0",
          discoverySources: [],
        }));
      },
    });
    const health = (client as typeof client & { health?: () => Promise<unknown> }).health;

    expect(health).toBeTypeOf("function");
    if (health === undefined) return;
    await health();

    expect(requestHeaders!.get("authorization")).toBe("Bearer health-test-key-0123456789");
  });

  it("accepts generic health from a real API-key self-hosted engine without local discovery details", async () => {
    const clientKey = "health-test-key-0123456789";
    const app = createApp({
      orchestrator: createOrchestrator([createReferenceAdapter()]),
      trust: createSeedTrustProvider(),
      auth: { kind: "api-keys", keys: [{ clientId: "health-test", key: clientKey }] },
      discoverySources: [{ store: "private-source", status: "ready" }],
    });
    const client = createServiceClient({
      serviceUrl: "https://engine.example",
      clientKey,
      fetchImpl: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
    });

    await expect(client.health()).resolves.toEqual({
      ok: true,
      data: { ok: true, service: "northcinder", version: "0.2.0" },
    });
  });

  it("omits Authorization for an unauthenticated local engine request", async () => {
    let requestHeaders: Headers | undefined;
    const client = createServiceClient({
      serviceUrl: "http://127.0.0.1:8787",
      fetchImpl: async (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ results: [], storeStatuses: [] }));
      },
    });

    await client.search({ text: "shoes" });

    expect([...requestHeaders!.entries()]).toEqual([["content-type", "application/json"]]);
  });

  it("sends exactly the configured bearer key when one is present", async () => {
    let requestHeaders: Headers | undefined;
    const client = createServiceClient({
      serviceUrl: "http://127.0.0.1:8787",
      clientKey: "test-client-key-0123456789",
      fetchImpl: async (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ results: [], storeStatuses: [] }));
      },
    });

    await client.search({ text: "shoes" });

    expect(requestHeaders!.get("authorization")).toBe("Bearer test-client-key-0123456789");
  });

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

  it("makes one POST attempt and surfaces the typed Retry-After delay", async () => {
    let calls = 0;
    const client = createServiceClient({
      serviceUrl: "https://service.private.example",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ code: "rate_limited", message: "private upstream detail" }), {
          status: 429,
          headers: { "Retry-After": "2" },
        });
      },
    });
    const result = await client.search({ text: "shoes" });
    expect(calls).toBe(1);
    expect(result).toEqual({
      ok: false,
      error: { code: "service_error", message: "configured NorthCinder engine error (HTTP 429)", retryAfterMs: 2_000 },
    });
  });
});
