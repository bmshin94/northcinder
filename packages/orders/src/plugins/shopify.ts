import type { OrderParsePlugin, PluginParseResult } from "./types.js";

const ITEM_LINE = /^(\d+) x (.+) - \$([\d.]+)$/gm;

/** Shopify-hosted storefront order confirmations (`*.myshopify.com` sender, or "Powered by Shopify" footer). */
export const shopifyPlugin: OrderParsePlugin = {
  id: "shopify-order-confirmation",
  matches(email) {
    const fromShopify = email.fromDomain.includes("myshopify.com") || /powered by shopify/i.test(email.textBody);
    return fromShopify && /order #\S+/i.test(email.textBody);
  },
  parse(email): PluginParseResult {
    const orderMatch = /order #(\S+)/i.exec(email.textBody);
    if (!orderMatch) return { kind: "unparsed", reason: "Shopify email did not contain a recognizable order number" };
    const placedMatch = /placed on ([^\n]+)/i.exec(email.textBody);
    const orderDate = placedMatch ? new Date(placedMatch[1]!.trim()) : undefined;
    if (placedMatch && Number.isNaN(orderDate?.getTime())) {
      return { kind: "unparsed", reason: `Shopify email order date "${placedMatch[1]}" did not parse` };
    }
    const items = [...email.textBody.matchAll(ITEM_LINE)].map((m) => ({
      quantity: Number.parseInt(m[1]!, 10),
      title: m[2]!.trim(),
      unitPrice: { amount: Math.round(Number.parseFloat(m[3]!) * 100), currency: "USD" as const },
    }));
    const totalMatch = /total:\s*\$([\d.]+)/i.exec(email.textBody);
    return {
      kind: "order",
      order: {
        orderNumber: orderMatch[1]!,
        merchantName: email.from.replace(/<[^>]*>/, "").replace(/"/g, "").trim() || email.fromDomain,
        merchantDomain: email.fromDomain,
        orderDate: (orderDate ?? new Date(email.date)).toISOString(),
        items,
        status: "confirmed",
        ...(totalMatch ? { total: { amount: Math.round(Number.parseFloat(totalMatch[1]!) * 100), currency: "USD" as const } } : {}),
      },
    };
  },
};
