import { describe, expect, it } from "vitest";
import type { OrderRecord } from "@northcinder/checkout";
import type { LifecycleReminder, Order, PurchaseOutcome } from "@northcinder/protocol";
import type { LocalTrustEvidenceInput } from "../src/local-trust-evidence.js";
import { LOCAL_TRUST_EVIDENCE_SOURCE, deriveLocalTrustEvidence } from "../src/local-trust-evidence.js";

const MERCHANT = { id: "shop.example", domain: "shop.example" };

function checkoutOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    orderId: "order_1",
    createdAt: "2026-06-01T00:00:00.000Z",
    offerId: "offer-1",
    merchantId: MERCHANT.id,
    merchantDomain: MERCHANT.domain,
    railId: "acp",
    status: "completed",
    mandateId: "mandate_1",
    mandate: {} as OrderRecord["mandate"],
    evidence: { rail: "acp" } as unknown as OrderRecord["evidence"],
    ...overrides,
  };
}

function graphOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "order_email_1",
    merchantName: "Shop Example",
    merchantDomain: MERCHANT.domain,
    orderDate: "2026-06-10T00:00:00.000Z",
    items: [],
    status: "delivered",
    source: { kind: "email", messageId: "m1", parser: "generic" },
    ...overrides,
  };
}

describe("deriveLocalTrustEvidence — client-local outcome evidence (display-only, local trust evidence)", () => {
  it("does not treat lifecycle reminder activity as evidence about a merchant", () => {
    const reminders: LifecycleReminder[] = [{
      id: "lifecycle_1",
      orderId: "order_1",
      kind: "maintenance",
      dueOn: "2026-09-01",
      remindOn: "2026-08-20",
      detail: "clean",
      createdAt: "2026-08-20T00:00:00.000Z",
    }];
    const lines = deriveLocalTrustEvidence({
      merchant: MERCHANT,
      checkoutOrders: [checkoutOrder()],
      lifecycleReminders: reminders,
    } as unknown as LocalTrustEvidenceInput);

    expect(lines.map((line) => line.detail)).toEqual([
      "your history: 1 completed order from this merchant (local orders)",
    ]);
  });

  it("adds confirmed delivery and support facts for a matching completed checkout without changing the history count", () => {
    const outcome: PurchaseOutcome = { orderId: "order_1", state: "kept", merchantDelivery: "on_time", merchantSupport: "helpful", recordedAt: "2026-08-21T12:00:00.000Z" };
    const lines = deriveLocalTrustEvidence({ merchant: MERCHANT, checkoutOrders: [checkoutOrder()], outcomes: [outcome] });
    expect(lines.map((line) => line.detail)).toEqual([
      "your history: 1 completed order from this merchant (local orders)",
      "your confirmed local outcomes: kept 1; delivery on_time 1; support helpful 1 (local orders)",
    ]);
  });
  it("aggregates all safely matched checkout and domain-matched order outcomes without claiming an unconfirmed handoff completed", () => {
    const outcomes: PurchaseOutcome[] = [
      { orderId: "order_1", state: "kept", merchantDelivery: "on_time", recordedAt: "2026-08-21T12:00:00.000Z" },
      { orderId: "order_email_1", state: "returned", merchantSupport: "unhelpful", recordedAt: "2026-08-21T12:00:00.000Z" },
      { orderId: "handoff", state: "kept", merchantSupport: "helpful", recordedAt: "2026-08-21T12:00:00.000Z" },
      { orderId: "other", state: "kept", merchantDelivery: "failed", recordedAt: "2026-08-21T12:00:00.000Z" },
    ];
    const lines = deriveLocalTrustEvidence({
      merchant: MERCHANT,
      checkoutOrders: [checkoutOrder(), checkoutOrder({ orderId: "handoff", status: "handed_off" })],
      graphOrders: [graphOrder()], outcomes,
    });
    const detail = lines.map((line) => line.detail).join("\n");
    expect(detail).toContain("kept 2; returned 1");
    expect(detail).toContain("delivery on_time 1");
    expect(detail).toContain("support helpful 1; unhelpful 1");
    expect(lines[0]!.detail).toContain("your history: 1 completed order from this merchant");
  });
  it("empty history: no checkout orders at all → zero evidence lines (absence is never asserted)", () => {
    const lines = deriveLocalTrustEvidence({ merchant: MERCHANT, checkoutOrders: [], graphOrders: [] });
    expect(lines).toEqual([]);
  });

  it("a completed order for a DIFFERENT merchant produces no evidence for THIS merchant", () => {
    const lines = deriveLocalTrustEvidence({
      merchant: MERCHANT,
      checkoutOrders: [checkoutOrder({ merchantId: "other.example" })],
      graphOrders: [],
    });
    expect(lines).toEqual([]);
  });

  it("one completed order, no delivered graph entry: states the count only, no delivery date", () => {
    const lines = deriveLocalTrustEvidence({ merchant: MERCHANT, checkoutOrders: [checkoutOrder()], graphOrders: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.source).toBe(LOCAL_TRUST_EVIDENCE_SOURCE);
    expect(lines[0]!.source).not.toBe("seed-list");
    expect(lines[0]!.detail).toBe("your history: 1 completed order from this merchant (local orders)");
    expect(lines[0]!.detail).not.toMatch(/delivered/);
    expect(lines[0]!.fetchedAt).toBeDefined();
  });

  it("multiple completed orders + a matching delivered graph entry: correct N and the LATEST delivered date", () => {
    const lines = deriveLocalTrustEvidence({
      merchant: MERCHANT,
      checkoutOrders: [
        checkoutOrder({ orderId: "order_1", status: "completed" }),
        checkoutOrder({ orderId: "order_2", status: "completed" }),
        checkoutOrder({ orderId: "order_3", status: "completed" }),
      ],
      graphOrders: [
        graphOrder({ id: "g1", orderDate: "2026-05-01T00:00:00.000Z", status: "delivered" }),
        graphOrder({ id: "g2", orderDate: "2026-06-20T00:00:00.000Z", status: "delivered" }), // latest
        graphOrder({ id: "g3", orderDate: "2026-06-25T00:00:00.000Z", status: "shipped" }), // not delivered — ignored
      ],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.detail).toBe(
      "your history: 3 completed orders from this merchant, last delivered 2026-06-20 (local orders)",
    );
  });

  it("status=handed_off checkout orders are NOT counted as completed (we never observed the handoff finish)", () => {
    const lines = deriveLocalTrustEvidence({
      merchant: MERCHANT,
      checkoutOrders: [checkoutOrder({ status: "handed_off" })],
      graphOrders: [],
    });
    expect(lines).toEqual([]);
  });

  it("graph orders sourced from checkout (already counted via checkoutOrders) are excluded from delivery-date lookup to avoid a skewed date from a differently-keyed record", () => {
    const lines = deriveLocalTrustEvidence({
      merchant: MERCHANT,
      checkoutOrders: [checkoutOrder()],
      graphOrders: [
        graphOrder({
          id: "order_1",
          orderDate: "2026-06-10T00:00:00.000Z",
          status: "delivered",
          source: { kind: "checkout", orderId: "order_1" },
        }),
      ],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.detail).not.toMatch(/delivered/);
  });

  it("matching rule: graph-order domain match is case-insensitive", () => {
    const lines = deriveLocalTrustEvidence({
      merchant: MERCHANT,
      checkoutOrders: [checkoutOrder()],
      graphOrders: [graphOrder({ merchantDomain: "SHOP.EXAMPLE", status: "delivered", orderDate: "2026-06-15T00:00:00.000Z" })],
    });
    expect(lines[0]!.detail).toContain("last delivered 2026-06-15");
  });

  it("matching rule: a graph order for a different domain is ignored even with the same merchant name", () => {
    const lines = deriveLocalTrustEvidence({
      merchant: MERCHANT,
      checkoutOrders: [checkoutOrder()],
      graphOrders: [graphOrder({ merchantDomain: "other-shop.example", merchantName: "Shop Example", status: "delivered" })],
    });
    expect(lines[0]!.detail).not.toMatch(/delivered/);
  });

  it("hostile stored merchant names never reach the evidence detail string (the line never interpolates a stored name)", () => {
    const lines = deriveLocalTrustEvidence({
      merchant: MERCHANT,
      checkoutOrders: [checkoutOrder()],
      graphOrders: [
        graphOrder({
          merchantName: '<img src=x onerror=alert(1)> & "quotes" \' <script>alert(2)</script>',
          status: "delivered",
          orderDate: "2026-06-15T00:00:00.000Z",
        }),
      ],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.detail).not.toContain("<img");
    expect(lines[0]!.detail).not.toContain("<script>");
    expect(lines[0]!.detail).not.toContain("onerror");
  });

  it("malformed/hostile stored records (wrong types, null holes) never throw — they are skipped", () => {
    const hostileCheckout = [
      null,
      undefined,
      {},
      { merchantId: 12345 },
      { merchantId: MERCHANT.id, merchantDomain: MERCHANT.domain, status: "completed" }, // otherwise valid-ish minimal shape
    ] as unknown as OrderRecord[];
    const hostileGraph = [
      null,
      { merchantDomain: 42 },
      { merchantDomain: MERCHANT.domain, status: "delivered", orderDate: "not-a-date" },
    ] as unknown as Order[];
    expect(() =>
      deriveLocalTrustEvidence({ merchant: MERCHANT, checkoutOrders: hostileCheckout, graphOrders: hostileGraph }),
    ).not.toThrow();
    const lines = deriveLocalTrustEvidence({ merchant: MERCHANT, checkoutOrders: hostileCheckout, graphOrders: hostileGraph });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.detail).toBe("your history: 1 completed order from this merchant (local orders)");
  });

  it("does not attribute a colliding merchant id from another domain", () => {
    // Two different domains can legitimately share a platform-local id. The
    // persisted checkout record must carry the domain and the local display
    // layer must require both fields before claiming history.
    const collidingId = "12345";
    const lines = deriveLocalTrustEvidence({
      merchant: { id: collidingId, domain: "storeA.example" },
      checkoutOrders: [checkoutOrder({ merchantId: collidingId, merchantDomain: "storeB.example" })],
      graphOrders: [],
    });
    expect(lines).toEqual([]);
  });
});
