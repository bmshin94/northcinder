import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CheckoutOrchestrator } from "@northcinder/checkout";
import { loadOrCreateMandateKeypair } from "@northcinder/checkout";
import type { Offer, SearchRankResponse } from "@northcinder/protocol";
import { createAuditLog } from "../src/audit-log.js";
import { createAuthorizationStore } from "../src/authorization.js";
import { createNorthCinderMcpServer } from "../src/server.js";
import type { NorthCinderServiceClient } from "../src/service-client.js";

// Two DIFFERENT stores each independently mint an offer with the SAME bare
// `offer.id` ("dup-1") — nothing in the protocol guarantees offer ids are
// globally unique across stores, only unique within a store's own catalog.
const STORE_A_OFFER: Offer = {
  id: "dup-1",
  product: { id: "dup-1", title: "Store A Widget", url: "https://store-a.example/dup-1", attributes: {} },
  price: { amount: 1000, currency: "USD" },
  merchant: { id: "store-a-merchant", name: "Store A Merchant", domain: "store-a.example" },
  availability: "in_stock",
  sourceStore: "store-a",
  sponsored: false,
};

const STORE_B_OFFER: Offer = {
  id: "dup-1",
  product: { id: "dup-1", title: "Store B Widget", url: "https://store-b.example/dup-1", attributes: {} },
  price: { amount: 2000, currency: "USD" },
  merchant: { id: "store-b-merchant", name: "Store B Merchant", domain: "store-b.example" },
  availability: "in_stock",
  sourceStore: "store-b",
  sponsored: false,
};

function fakeService(): NorthCinderServiceClient {
  return {
    async search() {
      const data: SearchRankResponse = {
        results: [
          { offer: STORE_A_OFFER, score: 10, reasons: [{ criterion: "price", detail: "cheapest" }] },
          { offer: STORE_B_OFFER, score: 5, reasons: [{ criterion: "price", detail: "pricier" }] },
        ],
        storeStatuses: [
          { store: "store-a", ok: true, offerCount: 1, durationMs: 1 },
          { store: "store-b", ok: true, offerCount: 1, durationMs: 1 },
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

const NEVER_CHECKOUT: CheckoutOrchestrator = {
  async completeCheckout() {
    throw new Error("not exercised in this test");
  },
};

describe("cross-store offer id collisions — request_purchase_authorization must not silently bind to the wrong store's offer", () => {
  const configDir = mkdtempSync(join(tmpdir(), "northcinder-collision-"));
  let client: Client;

  beforeAll(async () => {
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const audit = createAuditLog(configDir);
    const server = createNorthCinderMcpServer({
      service: fakeService(),
      authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }),
      checkout: NEVER_CHECKOUT,
      audit,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-host-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
  });

  it("search_products sees both colliding offers", async () => {
    const result = await client.callTool({ name: "search_products", arguments: { text: "widget" } });
    const structured = result.structuredContent as SearchRankResponse;
    expect(structured.results).toHaveLength(2);
    expect(structured.results.map((r) => r.offer.sourceStore).sort()).toEqual(["store-a", "store-b"]);
  });

  it("a bare offerId that collides across stores is refused as ambiguous, not silently bound to one store", async () => {
    const result = await client.callTool({
      name: "request_purchase_authorization",
      arguments: { offerId: "dup-1", intent: "buy the widget" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("ambiguous_offer");
    expect(JSON.stringify(result.content)).toContain("store-a");
    expect(JSON.stringify(result.content)).toContain("store-b");
  });

  it("passing sourceStore disambiguates and binds to the correct store's offer", async () => {
    const a = await client.callTool({
      name: "request_purchase_authorization",
      arguments: { offerId: "dup-1", sourceStore: "store-a", intent: "buy from store A" },
    });
    expect(a.isError ?? false).toBe(false);
    const aStructured = a.structuredContent as { maxAmount: { amount: number; currency: string } };
    expect(aStructured.maxAmount.amount).toBe(1000);

    const b = await client.callTool({
      name: "request_purchase_authorization",
      arguments: { offerId: "dup-1", sourceStore: "store-b", intent: "buy from store B" },
    });
    expect(b.isError ?? false).toBe(false);
    const bStructured = b.structuredContent as { maxAmount: { amount: number; currency: string } };
    expect(bStructured.maxAmount.amount).toBe(2000);
  });
});
