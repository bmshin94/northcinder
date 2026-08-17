import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { rankOffers, type Offer, type SearchRankResponse } from "@northcinder/protocol";
import { createRemoteHttpServer } from "../src/http-server.js";
import { createTokenBucketLimiter } from "../src/rate-limiter.js";
import type { NorthCinderServiceClient } from "../src/service-client.js";

const ORGANIC_OFFER: Offer = {
  id: "item-1",
  product: { id: "item-1", title: "Wool Blend Sneaker", url: "https://mock-merchant.example/item-1", attributes: {} },
  price: { amount: 9800, currency: "USD" },
  merchant: { id: "mock-merchant.example", name: "Mock Merchant", domain: "mock-merchant.example" },
  availability: "in_stock",
  sourceStore: "reference",
  sponsored: false,
};

function fakeService(): NorthCinderServiceClient {
  return {
    async search(query) {
      const trustSignals = {
        "mock-merchant.example": {
          merchantId: "mock-merchant.example",
          level: "unknown" as const,
          evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
        },
      };
      const data: SearchRankResponse = {
        trustSignals,
        results: rankOffers([ORGANIC_OFFER], query, { trust: trustSignals }),
        storeStatuses: [{ store: "reference", ok: true, offerCount: 1, durationMs: 3 }],
      };
      return { ok: true, data };
    },
    async trust(merchant) {
      return { ok: true, data: { merchantId: merchant.id, level: "unknown", evidence: [] } };
    },
  };
}

const CLIENT_ID = "acme";
const VALID_KEY = "a".repeat(20);

describe("remote MCP bridge — real Streamable HTTP handshake", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const httpServer = createRemoteHttpServer({
      apiKeys: [{ clientId: CLIENT_ID, key: VALID_KEY }],
      // Generous bucket for the handshake tests below (initialize + tools/list
      // + tools/call each cost one token) — the dedicated rate-limit test
      // further down spins up its OWN tightly-capped server instead of
      // relying on exhausting this shared one under real wall-clock timing.
      rateLimiter: createTokenBucketLimiter({ capacity: 50, refillPerSec: 1000 }),
      service: fakeService(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    stop = () => new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  afterAll(async () => {
    await stop();
  });

  it("GET /health returns ok without auth", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "northcinder-remote", version: "0.1.0" });
  });

  it("rejects an unauthenticated MCP request", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { data: { code: string } } };
    expect(body.error.data.code).toBe("unauthorized");
  });

  it("does a real MCP handshake over Streamable HTTP and lists exactly the read-only tools", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${VALID_KEY}` } },
    });
    const client = new Client({ name: "e2e-test-host", version: "0.0.1" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_trust_signal", "search_products"]);

    const result = await client.callTool({ name: "search_products", arguments: { text: "sneakers" } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { results: Array<{ offer: { id: string } }>; rankingVerified: unknown };
    expect(structured.results.map((r) => r.offer.id)).toEqual(["item-1"]);
    expect(structured.rankingVerified).toBe(true);
    await client.close();
  });

  it("enforces the per-key rate limit with a structured 429 once the bucket is exhausted", async () => {
    // Dedicated server with a tightly-capped, near-zero-refill bucket so the
    // second request is deterministically rejected regardless of real
    // wall-clock timing between requests.
    const limitedServer = createRemoteHttpServer({
      apiKeys: [{ clientId: CLIENT_ID, key: VALID_KEY }],
      rateLimiter: createTokenBucketLimiter({ capacity: 1, refillPerSec: 0.0001 }),
      service: fakeService(),
    });
    await new Promise<void>((resolve) => limitedServer.listen(0, "127.0.0.1", resolve));
    const { port } = limitedServer.address() as AddressInfo;
    const limitedBaseUrl = `http://127.0.0.1:${port}`;
    try {
      const makeRequest = () =>
        fetch(`${limitedBaseUrl}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${VALID_KEY}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        });
      const first = await makeRequest();
      expect(first.status).not.toBe(429);
      const second = await makeRequest();
      expect(second.status).toBe(429);
      const body = (await second.json()) as { error: { data: { code: string } } };
      expect(body.error.data.code).toBe("rate_limited");
      expect(second.headers.get("retry-after")).not.toBeNull();
    } finally {
      await new Promise<void>((resolve) => limitedServer.close(() => resolve()));
    }
  });

  it("rejects an oversized POST /mcp body with a structured 413, without invoking the MCP transport", async () => {
    const oversizedBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search_products", arguments: { text: "x".repeat(2_000_000) } },
    });
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${VALID_KEY}`,
      },
      body: oversizedBody,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { data: { code: string } } };
    expect(body.error.data.code).toBe("payload_too_large");
  });

  it("shutdown closes the listener: a formerly healthy endpoint refuses a new connection", async () => {
    const server = createRemoteHttpServer({
      apiKeys: [{ clientId: CLIENT_ID, key: VALID_KEY }],
      rateLimiter: createTokenBucketLimiter({ capacity: 2, refillPerSec: 1 }), service: fakeService(),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
