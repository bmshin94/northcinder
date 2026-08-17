import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rankOffers, type Offer, type SearchRankResponse } from "@northcinder/protocol";
import { createNorthCinderRemoteMcpServer } from "../src/mcp-server.js";
import type { NorthCinderServiceClient } from "../src/service-client.js";

const ORGANIC_OFFER: Offer = {
  id: "item-1",
  product: { id: "item-1", title: "Wool Blend Sneaker", url: "https://mock-merchant.example/item-1", attributes: {} },
  price: { amount: 9800, currency: "USD" },
  merchant: { id: "mock-merchant.example", name: "Mock Merchant", domain: "mock-merchant.example" },
  availability: "in_stock",
  sourceStore: "ebay",
  sponsored: false,
};

const SPONSORED_WORSE_OFFER: Offer = {
  id: "demo-sponsored-offer-1",
  product: {
    id: "demo-sponsored-offer-1",
    title: "[DEMO sponsored placement] sneaker — synthetic paid listing",
    url: "https://demo-sponsored.invalid/offer/demo-sponsored-offer-1",
    attributes: {},
  },
  price: { amount: 1999, currency: "USD" },
  merchant: { id: "demo-sponsored.invalid", name: "Demo Sponsored Merchant", domain: "demo-sponsored.invalid" },
  availability: "in_stock",
  sourceStore: "demo-sponsored",
  sponsored: true,
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
        "demo-sponsored.invalid": {
          merchantId: "demo-sponsored.invalid",
          level: "unknown" as const,
          evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
        },
      };
      const data: SearchRankResponse = {
        trustSignals,
        results: rankOffers([ORGANIC_OFFER, SPONSORED_WORSE_OFFER], query, { trust: trustSignals }),
        storeStatuses: [
          { store: "ebay", ok: true, offerCount: 1, durationMs: 12 },
          { store: "demo-sponsored", ok: true, offerCount: 1, durationMs: 1 },
        ],
      };
      return { ok: true, data };
    },
    async trust(merchant) {
      return {
        ok: true,
        data: {
          merchantId: merchant.id,
          level: "unknown",
          evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
        },
      };
    },
  };
}

async function connectedClient(service: NorthCinderServiceClient): Promise<Client> {
  const server = createNorthCinderRemoteMcpServer({ service });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-remote-host", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("remote MCP server — read-only tool surface", () => {
  it("tools/list shows EXACTLY search_products and get_trust_signal — no checkout/approval/watch/profile/orders tools", async () => {
    const client = await connectedClient(fakeService());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_trust_signal", "search_products"]);

    // Architectural assertion (watch-style): the forbidden surface is ABSENT,
    // not merely unused.
    const forbidden = [
      "request_purchase_authorization",
      "approve_purchase",
      "decline_purchase",
      "complete_checkout",
      "create_watch",
      "list_watches",
      "cancel_watch",
      "get_profile",
      "update_profile",
      "record_feedback",
      "list_orders",
      "get_order",
      "import_order",
      "get_buyers_brief",
    ];
    for (const name of forbidden) {
      expect(names).not.toContain(name);
    }
  });

  it("search_products returns ranked results + brief + interpretedQuery + rankingVerified: true against the reference/fake service", async () => {
    const client = await connectedClient(fakeService());
    const result = await client.callTool({ name: "search_products", arguments: { text: "sneakers" } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      results: Array<{ offer: { id: string; sponsored: boolean } }>;
      brief: { finalists: unknown[] };
      interpretedQuery: { criteria: { text: string } };
      rankingVerified: boolean | "not_applicable";
    };
    expect(structured.results.map((r) => r.offer.id)).toEqual(["item-1", "demo-sponsored-offer-1"]);
    expect(structured.results[1]?.offer.sponsored).toBe(true);
    expect(structured.brief.finalists.length).toBeGreaterThan(0);
    expect(structured.interpretedQuery.criteria.text).toBe("sneakers");
    expect(structured.rankingVerified).toBe(true);
  });

  it("search_products surfaces a divergence when the service tampers with the ranking (re-verifies like the local client)", async () => {
    const tamperedService: NorthCinderServiceClient = {
      async search(query) {
        const trustSignals = {
          "mock-merchant.example": {
            merchantId: "mock-merchant.example",
            level: "unknown" as const,
            evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
          },
          "demo-sponsored.invalid": {
            merchantId: "demo-sponsored.invalid",
            level: "unknown" as const,
            evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
          },
        };
        const correct = rankOffers([ORGANIC_OFFER, SPONSORED_WORSE_OFFER], query, { trust: trustSignals });
        // Tamper: reverse the correct order (boost the sponsored offer to #1).
        return {
          ok: true,
          data: {
            trustSignals,
            results: [...correct].reverse(),
            storeStatuses: [
              { store: "ebay", ok: true, offerCount: 1, durationMs: 12 },
              { store: "demo-sponsored", ok: true, offerCount: 1, durationMs: 1 },
            ],
          },
        };
      },
      trust: fakeService().trust,
    };
    const client = await connectedClient(tamperedService);
    const result = await client.callTool({ name: "search_products", arguments: { text: "sneakers" } });
    const structured = result.structuredContent as { rankingVerified: boolean | "not_applicable" };
    expect(structured.rankingVerified).toBe(false);
  });

  it("search_products independently exposes missing, duplicate, and unexpected registered-store coverage", async () => {
    const coverageBrokenService: NorthCinderServiceClient = {
      async search(query) {
        const base = await fakeService().search(query);
        if (!base.ok) throw new Error("fixture unexpectedly failed");
        return {
          ok: true,
          data: {
            ...base.data,
            registeredStores: ["reference", "missing-store"],
            storeStatuses: [
              { store: "reference", ok: true, offerCount: 1, durationMs: 3 },
              { store: "reference", ok: true, offerCount: 0, durationMs: 1 },
              { store: "unexpected-store", ok: true, offerCount: 0, durationMs: 1 },
            ],
          },
        };
      },
      trust: fakeService().trust,
    };
    const client = await connectedClient(coverageBrokenService);
    const result = await client.callTool({ name: "search_products", arguments: { text: "sneakers" } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      coverageVerified: boolean | "not_applicable";
      coverageMissing: string[];
      coverageUnexpected: string[];
    };
    expect(structured).toMatchObject({
      coverageVerified: false,
      coverageMissing: ["missing-store"],
      coverageUnexpected: ["reference", "unexpected-store"],
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("STORE COVERAGE VERIFICATION FAILED");
  });

  it("get_trust_signal returns the trust signal for a merchant object", async () => {
    const client = await connectedClient(fakeService());
    const result = await client.callTool({
      name: "get_trust_signal",
      arguments: { merchant: { id: "mock-merchant.example", name: "Mock Merchant", domain: "mock-merchant.example" } },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      merchantId: "mock-merchant.example",
      level: "unknown",
      evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
    });
  });

  it("get_trust_signal fails structured when neither merchant nor merchantId (with a prior search) is given", async () => {
    const client = await connectedClient(fakeService());
    const result = await client.callTool({ name: "get_trust_signal", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("search_products does NOT leak the upstream service URL or body when the upstream is unreachable", async () => {
    const secretBase = "https://internal-northcinder-service.corp-vpc.example:8443";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unreachableService: NorthCinderServiceClient = {
      async search() {
        return {
          ok: false,
          error: { code: "service_unreachable", message: `northcinder service unreachable (timeout) at ${secretBase}/v1/search` },
        };
      },
      trust: fakeService().trust,
    };
    const client = await connectedClient(unreachableService);
    const result = await client.callTool({ name: "search_products", arguments: { text: "sneakers" } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).not.toContain(secretBase);
    expect(text).not.toContain("internal-northcinder-service");
    expect(text).not.toContain("/v1/search");
    const parsed = JSON.parse(text) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("service_unreachable");
    expect(parsed.error.message).toBe("configured engine unavailable");
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain(secretBase);
    errorSpy.mockRestore();
  });

  it("get_trust_signal does NOT leak the upstream error body when the upstream returns an HTTP error", async () => {
    const secretBody = "internal stack trace: db-shard-7 connection pool exhausted at 192.0.2.22:5432";
    const erroringService: NorthCinderServiceClient = {
      search: fakeService().search,
      async trust() {
        return {
          ok: false,
          error: { code: "service_error", message: `service HTTP 500: ${secretBody}` },
        };
      },
    };
    const client = await connectedClient(erroringService);
    const result = await client.callTool({
      name: "get_trust_signal",
      arguments: { merchant: { id: "mock-merchant.example", name: "Mock Merchant", domain: "mock-merchant.example" } },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).not.toContain(secretBody);
    expect(text).not.toContain("192.0.2.22");
    const parsed = JSON.parse(text) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("service_error");
    expect(parsed.error.message).toBe("configured engine error");
  });
});
