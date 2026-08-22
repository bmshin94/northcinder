import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rankOffers, type Offer, type SearchRankResponse } from "@northcinder/protocol";
import { loadOrCreateMandateKeypair } from "@northcinder/checkout";
import { createWatchStore, WATCHES_FILENAME } from "@northcinder/watches";
import { createAuditLog } from "../src/audit-log.js";
import { createAuthorizationStore } from "../src/authorization.js";
import { createClientCheckout } from "../src/checkout-wiring.js";
import { createNorthCinderMcpServer } from "../src/server.js";
import type { NorthCinderServiceClient } from "../src/service-client.js";
import { createChannelNotifierFor } from "../src/watch-runner.js";

const OFFER: Offer = {
  id: "item-1",
  product: {
    id: "item-1",
    title: "Fairphone 5 128GB",
    url: "https://mock-merchant.example/item-1",
    attributes: { storage: "128GB" },
  },
  price: { amount: 59900, currency: "EUR" },
  merchant: { id: "mock-merchant.example", name: "Mock Merchant", domain: "mock-merchant.example" },
  availability: "in_stock",
  sourceStore: "ebay",
  sponsored: false,
};

const TRUST = {
  "mock-merchant.example": {
    merchantId: "mock-merchant.example",
    level: "unknown" as const,
    evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
  },
};

const service: NorthCinderServiceClient = {
  async search(query, options) {
    const browserOffers: Offer[] = (options?.browserObservations ?? []).map((observation, index) => ({
      id: `browser-observed-${index + 1}`,
      product: {
        id: `browser-product-${index + 1}`,
        title: observation.title,
        url: observation.productUrl,
        attributes: observation.attributes ?? {},
      },
      price: observation.price,
      merchant: {
        id: new URL(observation.productUrl).hostname,
        name: observation.merchantName,
        domain: new URL(observation.productUrl).hostname,
      },
      availability: observation.availability,
      sourceStore: "agent_browser",
      sponsored: observation.placement !== "organic",
      fetchedAt: observation.observedAt,
      acquisition: {
        kind: "agent_observed",
        observedAt: observation.observedAt,
        receivedAt: "2026-08-16T10:01:00.000Z",
        placement: observation.placement,
      },
    }));
    const trust = {
      ...TRUST,
      ...(browserOffers.length > 0
        ? {
            "shop.example": {
              merchantId: "shop.example",
              level: "unknown" as const,
              evidence: [{ source: "seed-list", detail: "not seeded" }],
            },
          }
        : {}),
    };
    const data: SearchRankResponse = {
      trustSignals: trust,
      results: rankOffers([OFFER, ...browserOffers], query, { trust }),
      storeStatuses: [
        { store: "ebay", ok: true, offerCount: 1, durationMs: 5 },
        ...(browserOffers.length > 0
          ? [{ store: "agent_browser", ok: true as const, offerCount: browserOffers.length, durationMs: 1 }]
          : []),
      ],
      ...(browserOffers.length > 0
        ? { browserObservationReport: { submitted: browserOffers.length, accepted: browserOffers.length, rejected: [] } }
        : {}),
    };
    return { ok: true, data };
  },
  async trust(merchant) {
    return {
      ok: true,
      data: { merchantId: merchant.id, level: "unknown", evidence: [{ source: "seed-list", detail: "not seeded" }] },
    };
  },
};

describe("watch tools (watch): create_watch / list_watches / cancel_watch", () => {
  const configDir = mkdtempSync(join(tmpdir(), "northcinder-watch-tools-"));
  let client: Client;
  let auditPath: string;

  beforeAll(async () => {
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const audit = createAuditLog(configDir);
    auditPath = audit.path;
    const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
    const server = createNorthCinderMcpServer({
      service,
      authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }),
      checkout: checkout.orchestrator,
      audit,
      watches: createWatchStore({ configDir }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-host-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  function auditEvents(): Array<Record<string, unknown>> {
    return readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("tool descriptions state the law: watches notify, never buy", async () => {
    const tools = await client.listTools();
    const create = tools.tools.find((t) => t.name === "create_watch")?.description ?? "";
    expect(create).toContain("NEVER buys");
    expect(create).toContain("no code path from a watch to checkout");
    expect(create).toContain("normal purchase authorization");
  });

  it("annotates watch, approval, checkout, and calendar-refresh tools with their real side effects", async () => {
    const tools = (await client.listTools()).tools;
    const annotations = (name: string) => tools.find((tool) => tool.name === name)?.annotations;

    expect(annotations("create_watch")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(annotations("cancel_watch")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(annotations("request_purchase_authorization")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(annotations("approve_purchase")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(annotations("decline_purchase")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(annotations("complete_checkout")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("create_watch rejects caller-selected topics, paths, and webhooks at the MCP input boundary", async () => {
    const unsafeChannels = [
      { type: "ntfy", topic: "caller-selected-secret-topic" },
      { type: "file", path: "/tmp/caller-selected-notifications.jsonl" },
      { type: "webhook", url: "https://attacker.example/hook" },
    ];

    for (const [index, channel] of unsafeChannels.entries()) {
      const name = `unsafe-channel-${index}`;
      const result = await client.callTool({
        name: "create_watch",
        arguments: {
          name,
          query: { text: "fairphone" },
          targetPrice: { amount: 55000, currency: "EUR" },
          channel,
        },
      });
      expect.soft(result.isError, JSON.stringify(channel)).toBe(true);
      expect.soft(createWatchStore({ configDir }).list().some((watch) => watch.name === name)).toBe(false);
    }
  });

  it("create_watch refuses an offerId that was never returned in this session", async () => {
    const res = await client.callTool({
      name: "create_watch",
      arguments: { name: "bogus", offerId: "never-seen", targetPrice: { amount: 100, currency: "EUR" } },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content as Array<{ text: string }>)[0]!.text).error.code).toBe("unknown_offer");
  });

  it("refuses an unattended watch for an agent-observed offer and returns its product URL", async () => {
    const initial = await client.callTool({ name: "search_products", arguments: { text: "repairable phone" } });
    const searchId = (initial.structuredContent as { searchId: string }).searchId;
    const continued = await client.callTool({
      name: "submit_browser_observations",
      arguments: {
        searchId,
        observations: [
          {
            productUrl: "https://shop.example/products/repairable-phone",
            title: "Repairable Phone",
            price: { amount: 49900, currency: "EUR" },
            availability: "in_stock",
            merchantName: "Example Shop",
            placement: "organic",
            observedAt: "2026-08-16T10:00:00.000Z",
          },
        ],
      },
    });
    const browserOffer = (continued.structuredContent as SearchRankResponse).results.find(
      (result) => result.offer.sourceStore === "agent_browser",
    )!.offer;

    const res = await client.callTool({
      name: "create_watch",
      arguments: {
        name: "unsafe browser watch",
        offerId: browserOffer.id,
        sourceStore: browserOffer.sourceStore,
        targetPrice: { amount: 45000, currency: "EUR" },
      },
    });

    expect(res.isError).toBe(true);
    const error = JSON.parse((res.content as Array<{ text: string }>)[0]!.text).error as {
      code: string;
      productUrl: string;
    };
    expect(error).toMatchObject({
      code: "native_revalidation_required",
      productUrl: "https://shop.example/products/repairable-phone",
    });
    expect(createWatchStore({ configDir }).list().some((watch) => watch.name === "unsafe browser watch")).toBe(false);
  });

  it("create_watch requires exactly one of offerId / query", async () => {
    const neither = await client.callTool({
      name: "create_watch",
      arguments: { name: "x", targetPrice: { amount: 100, currency: "EUR" } },
    });
    expect(neither.isError).toBe(true);
    expect(JSON.parse((neither.content as Array<{ text: string }>)[0]!.text).error.code).toBe("invalid_target");
    const both = await client.callTool({
      name: "create_watch",
      arguments: {
        name: "x",
        offerId: "item-1",
        query: { text: "fairphone" },
        targetPrice: { amount: 100, currency: "EUR" },
      },
    });
    expect(both.isError).toBe(true);
    expect(JSON.parse((both.content as Array<{ text: string }>)[0]!.text).error.code).toBe("invalid_target");
  });

  it("create_watch rejects a targetPrice whose currency can never match the offer (permanently-dead watch)", async () => {
    const search = await client.callTool({ name: "search_products", arguments: { text: "fairphone" } });
    expect(search.isError ?? false).toBe(false);
    const res = await client.callTool({
      name: "create_watch",
      arguments: { name: "doomed", offerId: "item-1", targetPrice: { amount: 55000, currency: "USD" } },
    });
    expect(res.isError).toBe(true);
    const error = JSON.parse((res.content as Array<{ text: string }>)[0]!.text).error as { code: string; message: string };
    expect(error.code).toBe("currency_mismatch");
    expect(error.message).toContain("USD");
    expect(error.message).toContain("EUR");
    // Nothing was persisted for the doomed watch.
    expect(createWatchStore({ configDir }).list().some((w) => w.name === "doomed")).toBe(false);
  });

  it("create_watch rejects a query watch whose maxPrice currency contradicts the targetPrice currency", async () => {
    const res = await client.callTool({
      name: "create_watch",
      arguments: {
        name: "doomed-query",
        query: { text: "fairphone", maxPrice: { amount: 60000, currency: "USD" } },
        targetPrice: { amount: 55000, currency: "EUR" },
      },
    });
    expect(res.isError).toBe(true);
    const error = JSON.parse((res.content as Array<{ text: string }>)[0]!.text).error as { code: string; message: string };
    expect(error.code).toBe("currency_mismatch");
    expect(error.message).toContain("USD");
    expect(error.message).toContain("EUR");
  });

  it("create_watch rejects a past expiresAt with its own invalid_expiry code (not watches_unreadable)", async () => {
    const res = await client.callTool({
      name: "create_watch",
      arguments: {
        name: "already-over",
        query: { text: "fairphone" },
        targetPrice: { amount: 55000, currency: "EUR" },
        expiresAt: "2020-01-01T00:00:00.000Z",
      },
    });
    expect(res.isError).toBe(true);
    const error = JSON.parse((res.content as Array<{ text: string }>)[0]!.text).error as { code: string; message: string };
    expect(error.code).toBe("invalid_expiry");
    expect(error.message).toContain("2020-01-01T00:00:00.000Z");
  });

  let offerWatchId: string;

  it("create_watch binds an offer watch to a searched offer (matching currency), persists it, audits it", async () => {
    const search = await client.callTool({ name: "search_products", arguments: { text: "fairphone" } });
    expect(search.isError ?? false).toBe(false);

    const res = await client.callTool({
      name: "create_watch",
      arguments: {
        name: "Fairphone below 550",
        offerId: "item-1",
        targetPrice: { amount: 55000, currency: "EUR" },
        channel: { type: "ntfy" },
      },
    });
    expect(res.isError ?? false).toBe(false);
    const structured = res.structuredContent as {
      watchId: string;
      state: string;
      targetKind: string;
      channelType: string;
      expiresAt: string;
      targetDescription: string;
    };
    offerWatchId = structured.watchId;
    expect(structured.state).toBe("active");
    expect(structured.targetKind).toBe("offer");
    expect(structured.channelType).toBe("ntfy");
    expect(structured.targetDescription).toContain("Fairphone 5 128GB");
    expect(structured.targetDescription).toContain("ebay:item-1");

    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("NEVER buys");
    expect(text).toContain("northcinder-watch");

    // The watch really persisted to the 0600 store (a separate process reads it).
    const persisted = createWatchStore({ configDir }).get(structured.watchId)!;
    expect(persisted.name).toBe("Fairphone below 550");
    expect(persisted.targetPrice).toEqual({ amount: 55000, currency: "EUR" });
    expect(persisted.channel).toEqual({ type: "ntfy" });

    const created = auditEvents().find((e) => e.type === "watch_created")!;
    expect(created.watchId).toBe(structured.watchId);
    expect(created.channelType).toBe("ntfy");
  });

  it("MCP-created ntfy watches persist no caller-selected bearer topic", async () => {
    const list = await client.callTool({ name: "list_watches", arguments: {} });
    expect(JSON.stringify(list)).not.toContain("topic");
    expect(readFileSync(auditPath, "utf8")).not.toContain("topic");
    expect(readFileSync(join(configDir, WATCHES_FILENAME), "utf8")).not.toContain('"topic"');
  });

  it("create_watch accepts a standing query watch", async () => {
    const res = await client.callTool({
      name: "create_watch",
      arguments: {
        name: "any fairphone deal",
        query: { text: "fairphone 5" },
        targetPrice: { amount: 50000, currency: "EUR" },
        mustHaveAttributes: ["128GB"],
      },
    });
    expect(res.isError ?? false).toBe(false);
    const structured = res.structuredContent as { targetKind: string; targetDescription: string; channelType: string };
    expect(structured.targetKind).toBe("query");
    expect(structured.targetDescription).toBe('query "fairphone 5"');
    expect(structured.channelType).toBe("stderr"); // default channel
  });

  it("list_watches lists both watches with redacted channel info", async () => {
    createWatchStore({ configDir }).update(offerWatchId, {
      lastSuccessAt: "2026-07-05T12:00:00.000Z",
      lastFailureAt: "2026-07-05T11:00:00.000Z",
      nextEligibleCheckAt: "2026-07-05T13:00:00.000Z",
    });
    const res = await client.callTool({ name: "list_watches", arguments: {} });
    expect(res.isError ?? false).toBe(false);
    const structured = res.structuredContent as { watches: Array<Record<string, unknown>>; activeCount: number };
    expect(structured.watches).toHaveLength(2);
    expect(structured.activeCount).toBe(2);
    expect(structured.watches[0]).not.toHaveProperty("channel");
    expect(structured.watches[0]!.channelType).toBe("ntfy");
    expect(structured.watches[0]).toMatchObject({
      lastSuccessAt: "2026-07-05T12:00:00.000Z",
      lastFailureAt: "2026-07-05T11:00:00.000Z",
      nextEligibleCheckAt: "2026-07-05T13:00:00.000Z",
    });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("Fairphone below 550");
    expect(text).toContain("550.00 EUR");
    expect(text).toContain("never checked yet");
  });

  it("cancel_watch voids the watch; cancelling again reports watch_not_active; unknown id reports unknown_watch", async () => {
    const res = await client.callTool({ name: "cancel_watch", arguments: { watchId: offerWatchId } });
    expect(res.isError ?? false).toBe(false);
    expect(res.structuredContent).toEqual({ watchId: offerWatchId, state: "cancelled" });
    expect(createWatchStore({ configDir }).get(offerWatchId)!.state).toBe("cancelled");
    expect(auditEvents().some((e) => e.type === "watch_cancelled" && e.watchId === offerWatchId)).toBe(true);

    const again = await client.callTool({ name: "cancel_watch", arguments: { watchId: offerWatchId } });
    expect(again.isError).toBe(true);
    expect(JSON.parse((again.content as Array<{ text: string }>)[0]!.text).error.code).toBe("watch_not_active");

    const unknown = await client.callTool({ name: "cancel_watch", arguments: { watchId: "watch_nope" } });
    expect(unknown.isError).toBe(true);
    expect(JSON.parse((unknown.content as Array<{ text: string }>)[0]!.text).error.code).toBe("unknown_watch");
  });

  it("notifier wiring: an ntfy channel without any topic fails STRUCTURED, naming the missing setting only", async () => {
    const notifierFor = createChannelNotifierFor({ configDir });
    const result = await notifierFor({ type: "ntfy" }).send({
      watchId: "w",
      watchName: "n",
      currentPrice: { amount: 1, currency: "EUR" },
      targetPrice: { amount: 1, currency: "EUR" },
      merchantName: "m",
      merchantId: "m",
      productTitle: "t",
      url: "https://x.example/p",
      dedupeKey: "w:EUR:0",
      at: "2026-07-05T00:00:00.000Z",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ntfy_topic_missing");
      expect(result.error.message).toContain("NORTHCINDER_NTFY_TOPIC");
    }
  });
});
