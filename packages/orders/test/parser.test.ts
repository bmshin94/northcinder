/**
 * Fixture .eml battery (acceptance criterion): each of the six real-format
 * samples parses to EXACT Order/Shipment fields — never "truthy"/length
 * assertions.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEmailToRecord } from "../src/parser.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

describe("parseEmailToRecord — deterministic parser plugins", () => {
  it("parses a Shopify order confirmation to exact Order fields", () => {
    const { result, parserId } = parseEmailToRecord(fixture("shopify-order-confirmation.eml"));
    expect(parserId).toBe("shopify-order-confirmation");
    expect(result.kind).toBe("order");
    if (result.kind !== "order") throw new Error("unreachable");
    expect(result.order.orderNumber).toBe("1021");
    expect(result.order.merchantDomain).toBe("shop-aurora.myshopify.com");
    expect(result.order.orderDate).toBe(new Date("July 1, 2026").toISOString());
    expect(result.order.items).toEqual([
      { title: "Cedar Trail Jacket", quantity: 1, unitPrice: { amount: 12800, currency: "USD" } },
      { title: "Merino Wool Socks", quantity: 2, unitPrice: { amount: 1800, currency: "USD" } },
    ]);
    expect(result.order.total).toEqual({ amount: 17200, currency: "USD" });
    expect(result.order.status).toBe("confirmed");
  });

  it("parses an Amazon order confirmation to exact Order fields", () => {
    const { result, parserId } = parseEmailToRecord(fixture("amazon-order-confirmation.eml"));
    expect(parserId).toBe("amazon-order-confirmation");
    expect(result.kind).toBe("order");
    if (result.kind !== "order") throw new Error("unreachable");
    expect(result.order.orderNumber).toBe("000-0000000-0000000");
    expect(result.order.merchantName).toBe("Amazon.com");
    expect(result.order.orderDate).toBe(new Date("July 2, 2026").toISOString());
    expect(result.order.items).toEqual([{ title: "Anker PowerCore 10000 Portable Charger", quantity: 1, unitPrice: { amount: 2599, currency: "USD" } }]);
    expect(result.order.total).toEqual({ amount: 2599, currency: "USD" });
  });

  it("parses a UPS shipping email to an exact in-transit Shipment", () => {
    const { result, parserId } = parseEmailToRecord(fixture("shipping-ups.eml"));
    expect(parserId).toBe("shipping-ups");
    expect(result.kind).toBe("shipment");
    if (result.kind !== "shipment") throw new Error("unreachable");
    expect(result.orderNumber).toBe("1021");
    expect(result.shipment.carrier).toBe("ups");
    expect(result.shipment.trackingNumber).toBe("1Z999AA10123456784");
    expect(result.shipment.status).toBe("in_transit");
    expect(result.shipment.events).toEqual([{ status: "in_transit", at: new Date("Thu, 2 Jul 2026 14:00:00 -0700").toISOString(), description: "shipped" }]);
  });

  it("parses a USPS shipping email to an exact in-transit Shipment", () => {
    const { result, parserId } = parseEmailToRecord(fixture("shipping-usps.eml"));
    expect(parserId).toBe("shipping-usps");
    expect(result.kind).toBe("shipment");
    if (result.kind !== "shipment") throw new Error("unreachable");
    expect(result.orderNumber).toBe("000-0000000-0000000");
    expect(result.shipment.carrier).toBe("usps");
    expect(result.shipment.trackingNumber).toBe("9400111899223197428490");
    expect(result.shipment.status).toBe("in_transit");
  });

  it("parses a delivery email to an exact delivered Shipment event", () => {
    const { result, parserId } = parseEmailToRecord(fixture("delivery.eml"));
    expect(parserId).toBe("delivery-generic");
    expect(result.kind).toBe("shipment");
    if (result.kind !== "shipment") throw new Error("unreachable");
    expect(result.orderNumber).toBe("1021");
    expect(result.shipment.carrier).toBe("ups");
    expect(result.shipment.trackingNumber).toBe("1Z999AA10123456784");
    expect(result.shipment.status).toBe("delivered");
    expect(result.shipment.events).toEqual([
      { status: "delivered", at: new Date("July 5, 2026 2:14 PM").toISOString(), description: "delivered" },
    ]);
  });

  it("parses a return-window email to an exact deadline", () => {
    const { result, parserId } = parseEmailToRecord(fixture("return-window.eml"));
    expect(parserId).toBe("return-window-generic");
    expect(result.kind).toBe("return_window");
    if (result.kind !== "return_window") throw new Error("unreachable");
    expect(result.orderNumber).toBe("1021");
    expect(result.returnWindow.deadline).toBe("2026-08-04");
    expect(result.returnWindow.policyDays).toBe(30);
    expect(result.returnWindow.basis).toBe("stated_deadline");
  });

  it("never drops an unparseable email — lands as `unparsed` with the raw subject retained", () => {
    const { result, email } = parseEmailToRecord(fixture("unparseable-newsletter.eml"));
    expect(result.kind).toBe("unparsed");
    expect(email.subject).toBe("10 ways to style your new jacket this fall");
    if (result.kind !== "unparsed") throw new Error("unreachable");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("an order confirmation with incidental 'delivered' copy parses as an ORDER, not unparsed (delivery.matches must require the actual delivery-date signal)", () => {
    const { result, parserId } = parseEmailToRecord(fixture("shopify-order-confirmation-delivery-copy.eml"));
    expect(parserId).toBe("shopify-order-confirmation");
    expect(result.kind).toBe("order");
    if (result.kind !== "order") throw new Error("unreachable");
    expect(result.order.orderNumber).toBe("1099");
    expect(result.order.total).toEqual({ amount: 8800, currency: "USD" });
  });
});

describe("hostile-input handling — never crashes, never smuggles control characters", () => {
  it("a missing Message-ID synthesizes a dedup key instead of crashing", () => {
    const raw = [
      'From: "Aurora Outfitters" <no-reply@shop-aurora.myshopify.com>',
      "Subject: Order confirmation #7001",
      "Date: Wed, 1 Jul 2026 10:15:00 -0700",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "Order #7001",
      "Placed on July 1, 2026",
      "",
    ].join("\n");
    const { email, result } = parseEmailToRecord(raw);
    expect(email.messageId.length).toBeGreaterThan(0);
    expect(email.messageId).toMatch(/^no-id-/);
    expect(result.kind).toBe("order");
  });

  it("a base64 body that fails to decode falls back to the raw body instead of crashing", () => {
    const raw = [
      'From: "Aurora Outfitters" <no-reply@shop-aurora.myshopify.com>',
      "Subject: Order confirmation #7002",
      "Date: Wed, 1 Jul 2026 10:15:00 -0700",
      "Message-ID: <bad-base64@shop-aurora.myshopify.com>",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      "%%%not-valid-base64%%%",
      "",
    ].join("\n");
    expect(() => parseEmailToRecord(raw)).not.toThrow();
    const { email } = parseEmailToRecord(raw);
    expect(email.textBody.length).toBeGreaterThan(0);
  });

  it("a quoted-printable body with a malformed escape falls back without crashing", () => {
    const raw = [
      'From: "Aurora Outfitters" <no-reply@shop-aurora.myshopify.com>',
      "Subject: Order confirmation #7003",
      "Date: Wed, 1 Jul 2026 10:15:00 -0700",
      "Message-ID: <bad-qp@shop-aurora.myshopify.com>",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Order #7003 costs =ZZ dollars",
      "",
    ].join("\n");
    expect(() => parseEmailToRecord(raw)).not.toThrow();
  });

  it("a multipart email with no text or html part yields an empty body, never a crash", () => {
    const raw = [
      'From: "Aurora Outfitters" <no-reply@shop-aurora.myshopify.com>',
      "Subject: Your receipt attachment",
      "Date: Wed, 1 Jul 2026 10:15:00 -0700",
      "Message-ID: <no-text-part@shop-aurora.myshopify.com>",
      'Content-Type: multipart/mixed; boundary="XYZ"',
      "",
      "--XYZ",
      "Content-Type: application/octet-stream",
      "Content-Transfer-Encoding: base64",
      "",
      "AAAA",
      "--XYZ--",
      "",
    ].join("\n");
    const { email, result } = parseEmailToRecord(raw);
    expect(email.textBody).toBe("");
    expect(result.kind).toBe("unparsed");
  });

  it("a header-injection attempt (CR/LF in the From/Subject headers) cannot inject a fake extra header/line — folding rules keep it inside the header value", () => {
    const raw = [
      'From: "Evil Corp" <evil@example.com>',
      "X-Injected: should-not-appear-as-a-real-header",
      "Subject: Order confirmation #7004",
      "Date: Wed, 1 Jul 2026 10:15:00 -0700",
      "Message-ID: <injection@example.com>",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "Order #7004",
      "Placed on July 1, 2026",
      "",
    ].join("\n");
    const { email } = parseEmailToRecord(raw);
    expect(email.subject).toBe("Order confirmation #7004");
    expect(email.subject).not.toContain("\n");
    expect(email.subject).not.toContain("\r");
  });
});
