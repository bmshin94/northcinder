import type { OrderParsePlugin, PluginParseResult } from "./types.js";

/**
 * Return-window emails: distinctive "return window" / "you can return"
 * phrasing. Checked BEFORE the order-confirmation plugins since a
 * return-window email typically also mentions "Order #".
 */
export const returnWindowPlugin: OrderParsePlugin = {
  id: "return-window-generic",
  matches(email) {
    const haystack = `${email.subject}\n${email.textBody}`.toLowerCase();
    return haystack.includes("return window") || haystack.includes("you can return");
  },
  parse(email): PluginParseResult {
    const orderMatch = /order #([^\s—-]+)/i.exec(email.textBody);
    if (!orderMatch) return { kind: "unparsed", reason: "return-window email did not contain a recognizable order number" };
    const deadlineMatch = /until ([A-Za-z]+ \d{1,2}, \d{4})/i.exec(email.textBody);
    if (!deadlineMatch) return { kind: "unparsed", reason: "return-window email did not state a parseable deadline date" };
    const deadlineDate = new Date(deadlineMatch[1]!);
    if (Number.isNaN(deadlineDate.getTime())) {
      return { kind: "unparsed", reason: `return-window email deadline "${deadlineMatch[1]}" did not parse as a date` };
    }
    const daysMatch = /(\d+)\s+days/i.exec(email.textBody);
    return {
      kind: "return_window",
      orderNumber: orderMatch[1]!,
      merchantDomain: email.fromDomain,
      returnWindow: {
        deadline: deadlineDate.toISOString().slice(0, 10),
        basis: "stated_deadline",
        ...(daysMatch ? { policyDays: Number.parseInt(daysMatch[1]!, 10) } : {}),
      },
    };
  },
};
