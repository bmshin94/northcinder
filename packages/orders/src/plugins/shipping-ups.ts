import type { OrderParsePlugin, PluginParseResult } from "./types.js";

const UPS_TRACKING = /\b1Z[0-9A-Z]{16}\b/;

/** Shipping-notification emails carrying a UPS tracking number (1Z + 16 chars). */
export const shippingUpsPlugin: OrderParsePlugin = {
  id: "shipping-ups",
  matches(email) {
    return UPS_TRACKING.test(email.textBody) || /carrier:\s*ups/i.test(email.textBody);
  },
  parse(email): PluginParseResult {
    const orderMatch = /order #([^\s.]+)/i.exec(email.textBody);
    if (!orderMatch) return { kind: "unparsed", reason: "UPS shipping email did not contain a recognizable order number" };
    const trackingMatch = UPS_TRACKING.exec(email.textBody);
    if (!trackingMatch) return { kind: "unparsed", reason: "UPS shipping email did not contain a recognizable UPS tracking number" };
    return {
      kind: "shipment",
      orderNumber: orderMatch[1]!,
      merchantDomain: email.fromDomain,
      shipment: {
        carrier: "ups",
        trackingNumber: trackingMatch[0],
        status: "in_transit",
        events: [{ status: "in_transit", at: email.date, description: "shipped" }],
      },
    };
  },
};
