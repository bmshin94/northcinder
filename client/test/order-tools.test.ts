/**
 * Behavioral coverage for list_orders / get_order / import_order (order graph fix
 * hardening) — earlier tests only asserted these tools were registered
 * (stdio.test.ts tool-count check); this exercises them over a real MCP
 * client/server pair, mirroring watch-tools.test.ts / profile-tools.test.ts.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Offer, SearchRankResponse } from "@northcinder/protocol";
import { loadOrCreateMandateKeypair } from "@northcinder/checkout";
import { createOrderGraphStore } from "@northcinder/orders";
import { createProfileStore } from "@northcinder/profile";
import { createOrderStore } from "../src/order-store.js";
import { createAuditLog } from "../src/audit-log.js";
import { createAuthorizationStore } from "../src/authorization.js";
import { createClientCheckout } from "../src/checkout-wiring.js";
import { createNorthCinderMcpServer } from "../src/server.js";
import type { NorthCinderServiceClient } from "../src/service-client.js";

const service: NorthCinderServiceClient = {
  async search() {
    const data: SearchRankResponse = { results: [], storeStatuses: [] };
    return { ok: true, data };
  },
  async trust(merchant) {
    return { ok: true, data: { merchantId: merchant.id, level: "unknown", evidence: [{ source: "seed-list", detail: "not seeded" }] } };
  },
};

const SHOPIFY_ORDER_EML = [
  'From: "Aurora Outfitters" <no-reply@shop-aurora.myshopify.com>',
  "Subject: Order confirmation #1021 for Buyer Example",
  "Date: Wed, 1 Jul 2026 10:15:00 -0700",
  "Message-ID: <shopify-1021-confirmation@shop-aurora.myshopify.com>",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Order #1021",
  "Placed on July 1, 2026",
  "",
  "1 x Cedar Trail Jacket - $128.00",
  "",
  "Total: $128.00",
  "",
].join("\n");

const RETURN_WINDOW_EML = [
  'From: "Aurora Outfitters" <no-reply@shop-aurora.myshopify.com>',
  "Subject: Your return window for order #1021",
  "Date: Sun, 5 Jul 2026 15:30:00 -0700",
  "Message-ID: <shopify-1021-return-window@shop-aurora.myshopify.com>",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Order #1021 -- you can return items until August 4, 2026 (30 days from delivery on July 5, 2026).",
  "",
].join("\n");

describe("list_orders / get_order / import_order (order graph)", () => {
  const configDir = mkdtempSync(join(tmpdir(), "northcinder-order-tools-"));
  const dropDir = join(configDir, "mail-drop");
  let client: Client;
  let auditPath: string;
  let orderGraph: ReturnType<typeof createOrderGraphStore>;

  beforeAll(async () => {
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const audit = createAuditLog(configDir);
    auditPath = audit.path;
    const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
    orderGraph = createOrderGraphStore(configDir);
    const server = createNorthCinderMcpServer({
      service,
      authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }),
      checkout: checkout.orchestrator,
      audit,
      orderGraph,
      ordersMailDropDir: dropDir,
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

  it("describes and annotates get_order as an idempotent buyer-local calendar refresh", async () => {
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "get_order");
    expect(tool?.title).toContain("refresh");
    expect(tool?.description).toContain("calendar file");
    expect(tool?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("list_orders is honest when empty, and audits orders_listed", async () => {
    const res = await client.callTool({ name: "list_orders", arguments: {} });
    expect(res.isError ?? false).toBe(false);
    expect(res.structuredContent).toEqual({ orders: [], count: 0 });
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("No orders yet");
    expect(auditEvents().some((e) => e.type === "orders_listed" && e.count === 0)).toBe(true);
  });

  it("import_order validates input (rejects an empty merchantName) and hand-enters a well-formed order", async () => {
    const bad = await client.callTool({
      name: "import_order",
      arguments: { merchantName: "", orderDate: "2026-07-01T00:00:00.000Z" },
    });
    expect(bad.isError).toBe(true);

    const ok = await client.callTool({
      name: "import_order",
      arguments: { merchantName: "Local Bakery", orderDate: "2026-07-01T00:00:00.000Z", total: { amount: 2500, currency: "USD" } },
    });
    expect(ok.isError ?? false).toBe(false);
    const structured = ok.structuredContent as { order: { id: string; merchantName: string } };
    expect(structured.order.merchantName).toBe("Local Bakery");
    expect(auditEvents().some((e) => e.type === "order_imported" && e.orderId === structured.order.id)).toBe(true);
  });

  it("get_order returns unknown_order for a nonexistent id", async () => {
    const res = await client.callTool({ name: "get_order", arguments: { orderId: "order_does_not_exist" } });
    expect(res.isError).toBe(true);
    const error = JSON.parse((res.content as Array<{ text: string }>)[0]!.text).error as { code: string; message: string };
    expect(error.code).toBe("unknown_order");
    expect(error.message).toContain("order_does_not_exist");
  });

  it("list_orders picks up a newly dropped .eml (drop-dir re-scan) and get_order returns full detail incl. shipment/return-window, refreshing an .ics file", async () => {
    // Simulate a mail client dropping two .eml files: an order confirmation
    // and its return-window email.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(dropDir, { recursive: true });
    writeFileSync(join(dropDir, "order.eml"), SHOPIFY_ORDER_EML);
    writeFileSync(join(dropDir, "return-window.eml"), RETURN_WINDOW_EML);

    const list = await client.callTool({ name: "list_orders", arguments: {} });
    expect(list.isError ?? false).toBe(false);
    const listStructured = list.structuredContent as { orders: Array<{ orderId: string; orderNumber?: string }>; count: number };
    const emailOrder = listStructured.orders.find((o) => o.orderNumber === "1021");
    expect(emailOrder).toBeDefined();

    const got = await client.callTool({ name: "get_order", arguments: { orderId: emailOrder!.orderId } });
    expect(got.isError ?? false).toBe(false);
    const structured = got.structuredContent as {
      order: { orderNumber: string; merchantName: string };
      shipments: unknown[];
      returnWindow?: { deadline: string };
      calendarWritten?: boolean;
    };
    expect(structured.order.orderNumber).toBe("1021");
    expect(structured.order.merchantName).toBe("Aurora Outfitters");
    expect(structured.returnWindow?.deadline).toBe("2026-08-04");
    expect(structured.calendarWritten).toBe(true);
    expect(JSON.stringify(got)).not.toContain(configDir);
    const calendarPath = join(configDir, "returns", `${emailOrder!.orderId}.ics`);
    expect(existsSync(calendarPath)).toBe(true);
    expect(readFileSync(calendarPath, "utf8")).toContain("SUMMARY:Return window closes for order 1021");
    expect(auditEvents().some((e) => e.type === "order_read" && e.orderId === emailOrder!.orderId)).toBe(true);
  });
});

describe("record_order_outcome", () => {
  it("rejects unknown orders, persists a complete checkout outcome and explicit reminder, and updates exactly one matching decision", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-order-outcome-tools-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const audit = createAuditLog(configDir);
    const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
    const orders = createOrderStore(configDir);
    const orderGraph = createOrderGraphStore(configDir);
    orders.append({
      orderId: "order_checkout_1", createdAt: "2026-08-01T00:00:00.000Z", sourceStore: "ebay", offerId: "offer-1", productTitle: "Trail Shoe", productBrand: "Acme",
      merchantId: "shop.example", merchantDomain: "shop.example", railId: "acp", status: "completed", mandateId: "mandate_1", mandate: { constraints: { maxAmount: { amount: 10000, currency: "USD" } } } as never, evidence: { rail: "acp" } as never,
    });
    expect(orderGraph.getOrder("order_checkout_1", orders.list())).toBeDefined();
    const server = createNorthCinderMcpServer({
      service,
      authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }), checkout: checkout.orchestrator, audit, orders, orderGraph,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-host-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const unknown = await client.callTool({ name: "record_order_outcome", arguments: { orderId: "missing", state: "kept" } });
    expect(unknown.isError).toBe(true);

    // Seed one deliberately bounded matching decision state, as an earlier checkout flow would.
    audit.append({ type: "authorization_requested", searchId: "search_order", decisionState: {
      searchId: "search_order", request: "trail shoe", criteria: { text: "trail shoe" }, candidates: [{ role: "top_fit", roleReason: "fit", rank: 1, sourceStore: "ebay", offerId: "offer-1", title: "Trail Shoe", merchant: { id: "shop.example", name: "Shop" }, price: { amount: 10000, currency: "USD" }, availability: "in_stock", sponsored: false, sellerState: "unknown", freshness: { status: "unknown" }, verificationState: "merchant_verified", decisionStatus: "ready", importantUnknowns: [], decisiveDownside: "none", whyThis: ["fit"], tradeoffs: [] }], coverage: [], unresolvedResearchQuestions: [], readiness: { status: "ready", reasons: [] }, projectionWarnings: [], chosenOffer: { sourceStore: "ebay", offerId: "offer-1" }, outcome: null, profileEffects: { applied: [], overridden: [] },
    } });
    const recorded = await client.callTool({ name: "record_order_outcome", arguments: {
      orderId: "order_checkout_1", state: "kept", fitOrCompatibility: "fit", merchantDelivery: "on_time", merchantSupport: "helpful", wouldChooseAgain: true,
      preferenceReason: "fit", reminders: [{ kind: "warranty", remindOn: "2027-08-01", dueOn: "2027-08-31", detail: "Register warranty." }],
    } });
    expect(recorded.isError ?? false).toBe(false);
    expect((recorded.structuredContent as { outcome: { state: string }; reminders: unknown[]; decisionOutcomeUpdated: boolean }).outcome.state).toBe("kept");
    expect((recorded.structuredContent as { reminders: unknown[] }).reminders).toHaveLength(1);
    expect((recorded.structuredContent as { decisionOutcomeUpdated: boolean }).decisionOutcomeUpdated).toBe(true);
    const detail = await client.callTool({ name: "get_order", arguments: { orderId: "order_checkout_1" } });
    expect((detail.structuredContent as { outcome: { merchantDelivery: string }; lifecycleReminders: unknown[] }).outcome.merchantDelivery).toBe("on_time");
    expect((detail.structuredContent as { lifecycleReminders: unknown[] }).lifecycleReminders).toHaveLength(1);
  });

  it("leaves ambiguous matching decision states unknown instead of attributing an outcome to either one", async () => {
    // Regression: selecting the newest matching decision would rewrite a
    // decision the buyer did not necessarily make.
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-order-outcome-ambiguous-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const audit = createAuditLog(configDir);
    const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
    const orders = createOrderStore(configDir);
    const orderGraph = createOrderGraphStore(configDir);
    orders.append({
      orderId: "order_ambiguous_1", createdAt: "2026-08-01T00:00:00.000Z", sourceStore: "ebay", offerId: "offer-ambiguous", productTitle: "Trail Shoe",
      merchantId: "shop.example", merchantDomain: "shop.example", railId: "acp", status: "completed", mandateId: "mandate_1", mandate: { constraints: { maxAmount: { amount: 10000, currency: "USD" } } } as never, evidence: { rail: "acp" } as never,
    });
    const candidate = { role: "top_fit", roleReason: "fit", rank: 1, sourceStore: "ebay", offerId: "offer-ambiguous", title: "Trail Shoe", merchant: { id: "shop.example", name: "Shop" }, price: { amount: 10000, currency: "USD" }, availability: "in_stock", sponsored: false, sellerState: "unknown", freshness: { status: "unknown" }, verificationState: "merchant_verified", decisionStatus: "ready", importantUnknowns: [], decisiveDownside: "none", whyThis: ["fit"], tradeoffs: [] } as const;
    for (const searchId of ["search_ambiguous_a", "search_ambiguous_b"]) {
      audit.append({ type: "authorization_requested", searchId, decisionState: {
        searchId, request: "trail shoe", criteria: { text: "trail shoe" }, candidates: [candidate], coverage: [], unresolvedResearchQuestions: [], readiness: { status: "ready", reasons: [] }, projectionWarnings: [], chosenOffer: { sourceStore: "ebay", offerId: "offer-ambiguous" }, outcome: null, profileEffects: { applied: [], overridden: [] },
      } });
    }
    const server = createNorthCinderMcpServer({
      service, authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }), checkout: checkout.orchestrator, audit, orders, orderGraph,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-host-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const recorded = await client.callTool({ name: "record_order_outcome", arguments: { orderId: "order_ambiguous_1", state: "kept" } });
    expect(recorded.isError ?? false).toBe(false);
    expect((recorded.structuredContent as { decisionOutcomeUpdated: boolean }).decisionOutcomeUpdated).toBe(false);
    const events = readFileSync(audit.path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const outcomeAudit = events.at(-1)!;
    expect(outcomeAudit).toMatchObject({ type: "order_outcome_recorded", orderId: "order_ambiguous_1", decisionOutcomeUpdated: false });
    expect(outcomeAudit.decisionState).toBeUndefined();
    expect(events.filter((event) => event.decisionState !== undefined).map((event) => (event.decisionState as { outcome: unknown }).outcome)).toEqual([null, null]);
  });

  it("records one outcome-backed brand reaction as a pending proposal without creating a profile entry", async () => {
    // Regression: a single confirmed outcome must not promote itself into a
    // durable inferred brand preference.
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-order-outcome-proposal-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const audit = createAuditLog(configDir);
    const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
    const orders = createOrderStore(configDir);
    const orderGraph = createOrderGraphStore(configDir);
    const profile = createProfileStore({ configDir });
    orders.append({
      orderId: "order_brand_proposal_1", createdAt: "2026-08-01T00:00:00.000Z", sourceStore: "ebay", offerId: "offer-brand", productTitle: "Trail Shoe", productBrand: "Acme",
      merchantId: "shop.example", merchantDomain: "shop.example", railId: "acp", status: "completed", mandateId: "mandate_1", mandate: { constraints: { maxAmount: { amount: 10000, currency: "USD" } } } as never, evidence: { rail: "acp" } as never,
    });
    const server = createNorthCinderMcpServer({
      service, authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }), checkout: checkout.orchestrator, audit, orders, orderGraph, profile,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-host-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const recorded = await client.callTool({ name: "record_order_outcome", arguments: {
      orderId: "order_brand_proposal_1", state: "kept", wouldChooseAgain: true, preferenceReason: "fit",
    } });
    expect(recorded.isError ?? false).toBe(false);
    expect((recorded.structuredContent as { pendingProposal: Record<string, unknown> }).pendingProposal).toMatchObject({
      kind: "brand", brand: "Acme", stance: "allow", reason: "fit", evidenceKeys: ["order:order_brand_proposal_1"],
    });
    expect((recorded.structuredContent as { createdEntry?: unknown }).createdEntry).toBeUndefined();
    expect(profile.list()).toEqual([]);
    expect(profile.listProposals()).toEqual([expect.objectContaining({ kind: "brand", brand: "Acme", stance: "allow", reason: "fit" })]);
    const outcomeAudit = readFileSync(audit.path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>).at(-1)!;
    expect(outcomeAudit).toMatchObject({ type: "order_outcome_recorded", decisionOutcomeUpdated: false });
    expect(outcomeAudit.proposalId).toBe((recorded.structuredContent as { pendingProposal: { id: string } }).pendingProposal.id);
    expect(outcomeAudit.createdEntry).toBeUndefined();
  });
});
