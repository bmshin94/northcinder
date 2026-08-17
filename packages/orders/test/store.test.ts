import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OrderRecord } from "@northcinder/checkout";
import { createOrderGraphStore } from "../src/store.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

function tmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "northcinder-orders-"));
}

describe("OrderGraphStore — ingest + merge", () => {
  it("ingests an order confirmation, a shipping email, a delivery email, and a return-window email into ONE merged order graph", () => {
    const store = createOrderGraphStore(tmpConfigDir());
    store.ingestEml(fixture("shopify-order-confirmation.eml"), "drop_dir");
    store.ingestEml(fixture("shipping-ups.eml"), "drop_dir");
    store.ingestEml(fixture("delivery.eml"), "drop_dir");
    store.ingestEml(fixture("return-window.eml"), "drop_dir");

    const orders = store.listOrders();
    expect(orders).toHaveLength(1);
    const order = orders[0]!;
    expect(order.orderNumber).toBe("1021");
    expect(order.source).toEqual({
      kind: "email",
      messageId: "shopify-1021-confirmation@shop-aurora.myshopify.com",
      parser: "shopify-order-confirmation",
    });

    const graph = store.getOrder(order.id)!;
    expect(graph.order.id).toBe(order.id);
    expect(graph.shipments).toHaveLength(1);
    expect(graph.shipments[0]!.trackingNumber).toBe("1Z999AA10123456784");
    expect(graph.shipments[0]!.status).toBe("delivered");
    expect(graph.shipments[0]!.events.map((e) => e.status)).toEqual(["in_transit", "delivered"]);
    expect(graph.returnWindow?.deadline).toBe("2026-08-04");
  });

  it("never drops an unparseable email: it lands in listUnparsed() with the raw subject retained", () => {
    const store = createOrderGraphStore(tmpConfigDir());
    const outcome = store.ingestEml(fixture("unparseable-newsletter.eml"), "drop_dir");
    expect(outcome.kind).toBe("unparsed");
    const unparsed = store.listUnparsed();
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0]!.subject).toBe("10 ways to style your new jacket this fall");
    expect(unparsed[0]!.source).toBe("drop_dir");
    expect(unparsed[0]!.reason.length).toBeGreaterThan(0);
  });

  it("dedupes re-ingesting the SAME email (by Message-ID) — no duplicate order/shipment records", () => {
    const store = createOrderGraphStore(tmpConfigDir());
    const raw = fixture("shopify-order-confirmation.eml");
    const first = store.ingestEml(raw, "drop_dir");
    const second = store.ingestEml(raw, "drop_dir");
    expect(first.kind).toBe("order");
    expect(second.kind).toBe("duplicate");
    expect(store.listOrders()).toHaveLength(1);
  });

  it("merges checkout OrderRecords (from @northcinder/checkout) alongside email-derived orders in list_orders/get_order", () => {
    const store = createOrderGraphStore(tmpConfigDir());
    store.ingestEml(fixture("amazon-order-confirmation.eml"), "drop_dir");

    const checkoutOrder: OrderRecord = {
      orderId: "order_checkout_abc123",
      createdAt: "2026-06-15T12:00:00.000Z",
      offerId: "off-1",
      merchantId: "shop.example.com",
      railId: "acp",
      status: "completed",
      mandateId: "mandate-1",
      mandate: {
        id: "mandate-1",
        intent: "Buy the Fairphone 5 128GB",
        constraints: { offerId: "off-1", merchantId: "shop.example.com", maxAmount: { amount: 59900, currency: "EUR" } },
        issuedAt: "2026-06-15T11:59:00.000Z",
        expiresAt: "2026-06-15T12:30:00.000Z",
        nonce: "0123456789abcdef",
        signature: { algorithm: "ed25519", publicKey: "cHVibGlj", value: "c2ln" },
      },
      evidence: { rail: "acp", detail: "acp checkout completed" } as unknown as OrderRecord["evidence"],
    };

    const orders = store.listOrders([checkoutOrder]);
    expect(orders).toHaveLength(2);
    const merged = orders.find((o) => o.id === "order_checkout_abc123")!;
    expect(merged.source).toEqual({ kind: "checkout", orderId: "order_checkout_abc123" });
    expect(merged.total).toEqual({ amount: 59900, currency: "EUR" });
    expect(merged.status).toBe("confirmed");

    const fetched = store.getOrder("order_checkout_abc123", [checkoutOrder])!;
    expect(fetched.order.id).toBe("order_checkout_abc123");
  });

  it("import_order path: a hand-entered order is queryable via list_orders/get_order", () => {
    const store = createOrderGraphStore(tmpConfigDir());
    const imported = store.importOrder({
      merchantName: "Local Bakery",
      orderDate: "2026-07-01T10:00:00.000Z",
      total: { amount: 2500, currency: "USD" },
    });
    expect(imported.source).toEqual({ kind: "import" });
    expect(store.listOrders().map((o) => o.id)).toContain(imported.id);
    expect(store.getOrder(imported.id)!.order.merchantName).toBe("Local Bakery");
  });

  it("sanitizes control characters out of merchantName/orderNumber/item titles before persisting (no injected fake lines into tool output)", () => {
    const store = createOrderGraphStore(tmpConfigDir());
    // An embedded C0 control char (vertical tab) that survives on the SAME
    // header/body line — the realistic injection vector, since a real CRLF
    // would just split into a new header/body line under normal unfolding.
    const raw = [
      'From: "Evil\x0BCorp" <no-reply@shop-aurora.myshopify.com>',
      "Subject: Order confirmation #8001",
      "Date: Wed, 1 Jul 2026 10:15:00 -0700",
      "Message-ID: <control-chars@shop-aurora.myshopify.com>",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "Order #8001",
      "Placed on July 1, 2026",
      "",
      "1 x Evil\x0BInjected Title - $10.00",
      "",
      "Total: $10.00",
      "",
    ].join("\n");
    const outcome = store.ingestEml(raw, "drop_dir");
    expect(outcome.kind).toBe("order");
    if (outcome.kind !== "order") throw new Error("unreachable");
    expect(outcome.order.merchantName).not.toMatch(/[\x00-\x1F\x7F]/);
    for (const item of outcome.order.items) {
      expect(item.title).not.toMatch(/[\x00-\x1F\x7F]/);
    }
  });

  it("import_order sanitizes control characters out of caller-supplied merchantName/orderNumber/item titles too", () => {
    const store = createOrderGraphStore(tmpConfigDir());
    const imported = store.importOrder({
      merchantName: "Local\r\nBakery",
      orderNumber: "ORD\n999",
      orderDate: "2026-07-01T10:00:00.000Z",
      items: [{ title: "Sourdough\r\nLoaf", quantity: 1 }],
    });
    expect(imported.merchantName).not.toMatch(/[\r\n]/);
    expect(imported.orderNumber).not.toMatch(/[\r\n]/);
    expect(imported.items[0]!.title).not.toMatch(/[\r\n]/);
  });

  it("persists the order-graph and unparsed files 0600 in the config dir", () => {
    const configDir = tmpConfigDir();
    const store = createOrderGraphStore(configDir);
    store.ingestEml(fixture("shopify-order-confirmation.eml"), "drop_dir");
    store.ingestEml(fixture("unparseable-newsletter.eml"), "drop_dir");
    const graphStat = statSync(join(configDir, "order-graph.json"));
    const unparsedStat = statSync(join(configDir, "unparsed-emails.jsonl"));
    expect(graphStat.mode & 0o777).toBe(0o600);
    expect(unparsedStat.mode & 0o777).toBe(0o600);
  });
});
