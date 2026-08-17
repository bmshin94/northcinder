import type { OrderParsePlugin, PluginParseResult } from "./types.js";

/**
 * Last-resort plugin: ALWAYS matches (it is the fallback), and only ever
 * returns `unparsed` — it never fabricates an order/shipment/return-window
 * from a low-confidence guess (determinism law: no LLM, and no heuristic
 * silently invents a field a dedicated plugin didn't produce). This is what
 * guarantees no mail is ever silently dropped.
 */
export const genericFallbackPlugin: OrderParsePlugin = {
  id: "generic-fallback",
  matches() {
    return true;
  },
  parse(email): PluginParseResult {
    return {
      kind: "unparsed",
      reason: "no parser plugin recognized this email's merchant/format (subject, sender, and body did not match any known order/shipping/return/delivery pattern)",
    };
  },
};
