import { describe, expect, it } from "vitest";
import { deliveryPlugin } from "../src/plugins/delivery.js";
import type { ParsedEmail } from "../src/eml.js";

function email(textBody: string): ParsedEmail {
  return {
    messageId: "m1@example.com",
    subject: "Your order was delivered",
    from: "Shop <no-reply@shop.example.com>",
    fromAddress: "no-reply@shop.example.com",
    fromDomain: "shop.example.com",
    date: new Date().toISOString(),
    textBody,
  };
}

describe("deliveryPlugin — the unknown-${orderNumber} tracking-number fallback", () => {
  it("strips C0 control characters from a crafted order number before it lands in trackingNumber", () => {
    // No tracking-number match in the body, so parse() falls back to
    // `unknown-${orderNumber}` — and the order number itself comes straight
    // from untrusted (unauthenticated) mail. \x07 (BEL) is not `\s`, so the
    // `order #([^\s.]+)` capture happily includes it.
    const evil = "order #1234\x07\x1Bevil";
    const body = `Your package was delivered on January 5, 2026 at 3:00 PM.\n${evil}\n`;
    const result = deliveryPlugin.parse(email(body));
    expect(result.kind).toBe("shipment");
    if (result.kind !== "shipment") throw new Error("expected shipment");
    expect(result.shipment.trackingNumber.startsWith("unknown-")).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1F\x7F]/.test(result.shipment.trackingNumber)).toBe(false);
  });
});
