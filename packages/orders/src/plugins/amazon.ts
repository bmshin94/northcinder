import type { OrderParsePlugin, PluginParseResult } from "./types.js";

/** Amazon.com order-confirmation emails (not shipping — those are caught by the tracking-number plugins first). */
export const amazonPlugin: OrderParsePlugin = {
  id: "amazon-order-confirmation",
  matches(email) {
    return email.fromDomain.endsWith("amazon.com") && /order total/i.test(email.textBody) && /order #\S+/i.test(email.textBody);
  },
  parse(email): PluginParseResult {
    const orderMatch = /order #(\S+)/i.exec(email.textBody);
    if (!orderMatch) return { kind: "unparsed", reason: "Amazon email did not contain a recognizable order number" };
    const placedMatch = /order placed:\s*([^\n]+)/i.exec(email.textBody);
    const orderDate = placedMatch ? new Date(placedMatch[1]!.trim()) : undefined;
    if (placedMatch && Number.isNaN(orderDate?.getTime())) {
      return { kind: "unparsed", reason: `Amazon email order date "${placedMatch[1]}" did not parse` };
    }
    const itemMatch = /quantity:\s*(\d+)\s+(.+)/i.exec(email.textBody);
    const priceMatch = /item price:\s*\$([\d.]+)/i.exec(email.textBody);
    const totalMatch = /order total:\s*\$([\d.]+)/i.exec(email.textBody);
    const items = itemMatch
      ? [
          {
            quantity: Number.parseInt(itemMatch[1]!, 10),
            title: itemMatch[2]!.trim(),
            ...(priceMatch ? { unitPrice: { amount: Math.round(Number.parseFloat(priceMatch[1]!) * 100), currency: "USD" as const } } : {}),
          },
        ]
      : [];
    return {
      kind: "order",
      order: {
        orderNumber: orderMatch[1]!,
        merchantName: "Amazon.com",
        merchantDomain: email.fromDomain,
        orderDate: (orderDate ?? new Date(email.date)).toISOString(),
        items,
        status: "confirmed",
        ...(totalMatch ? { total: { amount: Math.round(Number.parseFloat(totalMatch[1]!) * 100), currency: "USD" as const } } : {}),
      },
    };
  },
};
