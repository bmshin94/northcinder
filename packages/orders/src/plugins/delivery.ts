import type { OrderParsePlugin, PluginParseResult } from "./types.js";
import { sanitizeTextField } from "../sanitize.js";

/**
 * Delivery confirmation emails: "was delivered on <date> at <time>". `matches`
 * requires the ACTUAL delivery-date signal `parse()` extracts below (a loose
 * "delivered" substring check previously misrouted order confirmations that
 * merely mention delivery in passing — e.g. "your order will be delivered
 * within 3-5 business days" — since this plugin runs BEFORE the merchant
 * order-confirmation plugins in the registry).
 */
const DELIVERED_ON_DATE = /delivered\s+on\s+[A-Za-z]+\s+\d{1,2},\s*\d{4}/i;

export const deliveryPlugin: OrderParsePlugin = {
  id: "delivery-generic",
  matches(email) {
    const haystack = `${email.subject}\n${email.textBody}`;
    return DELIVERED_ON_DATE.test(haystack);
  },
  parse(email): PluginParseResult {
    const orderMatch = /order #([^\s.]+)/i.exec(email.textBody);
    if (!orderMatch) return { kind: "unparsed", reason: "delivery email did not contain a recognizable order number" };
    const deliveredMatch = /delivered on ([A-Za-z]+ \d{1,2}, \d{4})(?: at ([\d:]+ ?[AP]M))?/i.exec(email.textBody);
    if (!deliveredMatch) return { kind: "unparsed", reason: "delivery email did not state a parseable delivery date" };
    const at = new Date(deliveredMatch[2] ? `${deliveredMatch[1]} ${deliveredMatch[2]}` : deliveredMatch[1]!);
    if (Number.isNaN(at.getTime())) {
      return { kind: "unparsed", reason: `delivery email date "${deliveredMatch[1]}" did not parse` };
    }
    const trackingMatch = /tracking\s*(?:number)?\s*:?\s*\(?\b(1Z[0-9A-Z]{16}|\d{20,22})\b\)?/i.exec(email.textBody);
    const carrier = trackingMatch?.[1]?.startsWith("1Z") ? "ups" : trackingMatch ? "usps" : "other";
    return {
      kind: "shipment",
      orderNumber: orderMatch[1]!,
      merchantDomain: email.fromDomain,
      shipment: {
        carrier,
        // The tracking-number FALLBACK embeds the order number verbatim —
        // and unlike the real `store.ts` merge path (which runs every
        // persisted field through `sanitizeTextField`), this fallback value
        // is built here, before the order-number capture ([^\s.]+, which
        // admits any non-whitespace C0 control byte) is ever sanitized.
        // Route it through the same sanitizer so a crafted order number
        // can't smuggle control bytes into trackingNumber.
        trackingNumber: trackingMatch?.[1] ?? sanitizeTextField(`unknown-${orderMatch[1]}`),
        status: "delivered",
        events: [{ status: "delivered", at: at.toISOString(), description: "delivered" }],
      },
    };
  },
};
