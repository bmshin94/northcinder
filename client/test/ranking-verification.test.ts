/**
 * client-side ranking verification — the TAMPER test.
 *
 * The client re-runs the OPEN rankOffers over the offers + trust signals the
 * service returned and compares orders. A fake service that returns a boosted
 * re-order MUST be caught: `rankingVerified: false`, with the exact divergence
 * in both the tool output and the audit log — surfaced loudly, never hidden.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  rankOffers,
  type Offer,
  type SearchRankResponse,
  type TrustSignal,
} from "@northcinder/protocol";
import { loadOrCreateMandateKeypair } from "@northcinder/checkout";
import { createAuditLog } from "../src/audit-log.js";
import { createAuthorizationStore } from "../src/authorization.js";
import { createClientCheckout } from "../src/checkout-wiring.js";
import { createNorthCinderMcpServer, RANKING_TAMPER_WARNING } from "../src/server.js";
import type { NorthCinderServiceClient } from "../src/service-client.js";

function makeOffer(id: string, priceAmount: number, sponsored: boolean): Offer {
  return {
    id,
    product: { id, title: `Sneaker ${id}`, url: `https://mock-merchant.example/${id}`, attributes: {} },
    price: { amount: priceAmount, currency: "USD" },
    merchant: { id: "mock-merchant.example", name: "Mock Merchant", domain: "mock-merchant.example" },
    availability: "in_stock",
    sourceStore: "ebay",
    sponsored,
  };
}

const OFFERS = [makeOffer("cheap", 5000, false), makeOffer("mid", 9000, false), makeOffer("paid", 4000, true)];

const TRUST: Record<string, TrustSignal> = {
  "mock-merchant.example": {
    merchantId: "mock-merchant.example",
    level: "known",
    evidence: [{ source: "seed-list", detail: "merchant seen before" }],
  },
};

function serviceReturning(data: SearchRankResponse): NorthCinderServiceClient {
  return {
    async search() {
      return { ok: true, data };
    },
    async trust() {
      return {
        ok: true,
        data: { merchantId: "mock-merchant.example", level: "known", evidence: [{ source: "seed-list", detail: "x" }] },
      };
    },
  };
}

async function connectedClient(service: NorthCinderServiceClient): Promise<{ client: Client; auditPath: string }> {
  const configDir = mkdtempSync(join(tmpdir(), "northcinder-tamper-"));
  const keypair = loadOrCreateMandateKeypair({ configDir });
  const audit = createAuditLog(configDir);
  const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
  const server = createNorthCinderMcpServer({
    service,
    authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }),
    checkout: checkout.orchestrator,
    audit,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tamper-test-host", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, auditPath: audit.path };
}

function auditSearchLine(auditPath: string): Record<string, unknown> {
  const line = readFileSync(auditPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((l) => l.type === "search");
  expect(line).toBeDefined();
  return line!;
}

const STORE_STATUSES = [{ store: "ebay", ok: true as const, offerCount: 3, durationMs: 5 }];

describe("search_products — client-side re-rank verification", () => {
  it("fails closed before ranking, audit, brief, or seen-offer state when a typed engine strips browser acquisition", async () => {
    const native = makeOffer("native-organic", 9000, false);
    const provenanceStrippedBrowser: Offer = {
      ...makeOffer("browser-stripped", 5000, false),
      sourceStore: "agent_browser",
    };
    const malformed: SearchRankResponse = {
      results: rankOffers([native, provenanceStrippedBrowser], { text: "sneaker" }, { trust: TRUST }),
      storeStatuses: [{ store: "ebay", ok: true, offerCount: 1, durationMs: 5 }, { store: "agent_browser", ok: true, offerCount: 1, durationMs: 5 }],
      trustSignals: TRUST,
    };
    const { client, auditPath } = await connectedClient(serviceReturning(malformed));
    const auditBefore = existsSync(auditPath) ? readFileSync(auditPath, "utf8") : "";

    const result = await client.callTool({ name: "search_products", arguments: { text: "sneaker" } });

    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual({
      error: {
        code: "invalid_service_response",
        message: "configured engine returned an invalid search response",
      },
    });
    expect(existsSync(auditPath) ? readFileSync(auditPath, "utf8") : "").toBe(auditBefore);

    const authorization = await client.callTool({
      name: "request_purchase_authorization",
      arguments: { offerId: provenanceStrippedBrowser.id, sourceStore: provenanceStrippedBrowser.sourceStore },
    });
    expect(JSON.parse((authorization.content as Array<{ text: string }>)[0]!.text)).toMatchObject({
      error: { code: "unknown_offer" },
    });
    await client.close();
  });

  it("an HONEST service is verified: rankingVerified true in output and audit log", async () => {
    const honest: SearchRankResponse = {
      results: rankOffers(OFFERS, { text: "sneaker" }, { trust: TRUST }),
      storeStatuses: STORE_STATUSES,
      trustSignals: TRUST,
    };
    const { client, auditPath } = await connectedClient(serviceReturning(honest));
    const result = await client.callTool({ name: "search_products", arguments: { text: "sneaker" } });
    expect(result.isError ?? false).toBe(false);
    const structured = result.structuredContent as { rankingVerified: unknown; rankingDivergences?: unknown };
    expect(structured.rankingVerified).toBe(true);
    expect(structured.rankingDivergences).toBeUndefined();
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("Ranking verified");
    expect(text).not.toContain(RANKING_TAMPER_WARNING);

    const search = auditSearchLine(auditPath);
    expect(search.rankingVerified).toBe(true);
    await client.close();
  });

  it("TAMPER: a fake service returning a boosted re-order is flagged rankingVerified false with the exact divergence", async () => {
    const ranked = rankOffers(OFFERS, { text: "sneaker" }, { trust: TRUST });
    // Honest order is [cheap, mid, paid] (sponsored strictly last). The tampered
    // service "boosts" the sponsored offer to the top — the classic pay-for-rank.
    expect(ranked.map((r) => r.offer.id)).toEqual(["cheap", "mid", "paid"]);
    const boosted: SearchRankResponse = {
      results: [ranked[2]!, ranked[0]!, ranked[1]!],
      storeStatuses: STORE_STATUSES,
      trustSignals: TRUST,
    };
    const { client, auditPath } = await connectedClient(serviceReturning(boosted));
    const result = await client.callTool({ name: "search_products", arguments: { text: "sneaker" } });
    expect(result.isError ?? false).toBe(false); // results still returned — but loudly flagged

    const structured = result.structuredContent as {
      rankingVerified: unknown;
      rankingDivergences?: Array<{ kind: string; position: number; expected: { offerKey: string }; actual: { offerKey: string } }>;
    };
    expect(structured.rankingVerified).toBe(false);
    expect(structured.rankingDivergences).toBeDefined();
    expect(structured.rankingDivergences![0]).toEqual({
      kind: "order_mismatch",
      position: 1,
      expected: { offerKey: '["ebay","cheap"]', score: ranked[0]!.score },
      actual: { offerKey: '["ebay","paid"]', score: ranked[2]!.score },
    });

    // Loud in the human-readable text too.
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain(RANKING_TAMPER_WARNING);
    expect(text).toContain('["ebay","paid"]');

    // And in the user-auditable trail, with the exact divergence.
    const search = auditSearchLine(auditPath);
    expect(search.rankingVerified).toBe(false);
    const divergences = search.rankingDivergences as Array<{ kind: string; position: number }>;
    expect(divergences.length).toBeGreaterThan(0);
    expect(divergences[0]).toMatchObject({ kind: "order_mismatch", position: 1 });
    await client.close();
  });

  it("a pre-extension service (no trustSignals) is honestly not_applicable, never a fake green", async () => {
    const legacy: SearchRankResponse = {
      results: rankOffers(OFFERS, { text: "sneaker" }, { trust: TRUST }),
      storeStatuses: STORE_STATUSES,
      // no trustSignals — the client cannot recompute deterministically
    };
    const { client, auditPath } = await connectedClient(serviceReturning(legacy));
    const result = await client.callTool({ name: "search_products", arguments: { text: "sneaker" } });
    const structured = result.structuredContent as { rankingVerified: unknown };
    expect(structured.rankingVerified).toBe("not_applicable");
    const search = auditSearchLine(auditPath);
    expect(search.rankingVerified).toBe("not_applicable");
    await client.close();
  });
});
