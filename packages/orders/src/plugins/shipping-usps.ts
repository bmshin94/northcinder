import type { OrderParsePlugin, PluginParseResult } from "./types.js";

const USPS_TRACKING = /\b\d{20,22}\b/;

/** Shipping-notification emails carrying a USPS tracking number (20-22 digits). */
export const shippingUspsPlugin: OrderParsePlugin = {
  id: "shipping-usps",
  matches(email) {
    return USPS_TRACKING.test(email.textBody) || /carrier:\s*usps/i.test(email.textBody);
  },
  parse(email): PluginParseResult {
    const orderMatch = /order #([^\s.]+)/i.exec(email.textBody);
    if (!orderMatch) return { kind: "unparsed", reason: "USPS shipping email did not contain a recognizable order number" };
    const trackingMatch = USPS_TRACKING.exec(email.textBody);
    if (!trackingMatch) return { kind: "unparsed", reason: "USPS shipping email did not contain a recognizable USPS tracking number" };
    return {
      kind: "shipment",
      orderNumber: orderMatch[1]!,
      merchantDomain: email.fromDomain,
      shipment: {
        carrier: "usps",
        trackingNumber: trackingMatch[0],
        status: "in_transit",
        events: [{ status: "in_transit", at: email.date, description: "shipped" }],
      },
    };
  },
};
