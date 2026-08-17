/**
 * The deterministic parser registry (determinism law: NO LLM parsing
 * anywhere). Plugins are checked IN ORDER; the first whose `matches()`
 * returns true owns the parse. Order matters: return-window and
 * delivery/shipping-tracking phrasing are checked BEFORE the
 * merchant-specific order-confirmation plugins, since a shipping/delivery
 * email from the same merchant domain (e.g. Amazon) would otherwise be
 * misread as another order confirmation. `genericFallbackPlugin` is always
 * last and always matches — it is what guarantees no email is ever silently
 * dropped: unparseable mail becomes a structured UnparsedEmailRecord citing
 * the raw subject.
 */
import { parseEml, type ParsedEmail } from "./eml.js";
import { amazonPlugin } from "./plugins/amazon.js";
import { deliveryPlugin } from "./plugins/delivery.js";
import { genericFallbackPlugin } from "./plugins/generic-fallback.js";
import { returnWindowPlugin } from "./plugins/return-window.js";
import { shippingUpsPlugin } from "./plugins/shipping-ups.js";
import { shippingUspsPlugin } from "./plugins/shipping-usps.js";
import { shopifyPlugin } from "./plugins/shopify.js";
import type { OrderParsePlugin, PluginParseResult } from "./plugins/types.js";

export const ORDER_PARSE_PLUGINS: OrderParsePlugin[] = [
  returnWindowPlugin,
  deliveryPlugin,
  shippingUpsPlugin,
  shippingUspsPlugin,
  shopifyPlugin,
  amazonPlugin,
  genericFallbackPlugin,
];

export interface ParsedEmailRecord {
  email: ParsedEmail;
  parserId: string;
  result: PluginParseResult;
}

/** Runs the plugin table over one raw .eml string. Never throws — a plugin bug degrades to `unparsed`, never a crash. */
export function parseEmailToRecord(raw: string, plugins: OrderParsePlugin[] = ORDER_PARSE_PLUGINS): ParsedEmailRecord {
  const email = parseEml(raw);
  for (const plugin of plugins) {
    let matched = false;
    try {
      matched = plugin.matches(email);
    } catch {
      matched = false;
    }
    if (!matched) continue;
    try {
      return { email, parserId: plugin.id, result: plugin.parse(email) };
    } catch (cause) {
      return {
        email,
        parserId: plugin.id,
        result: { kind: "unparsed", reason: `parser plugin "${plugin.id}" threw: ${cause instanceof Error ? cause.message : String(cause)}` },
      };
    }
  }
  // Unreachable while genericFallbackPlugin (matches() === true) is registered, but fail closed anyway.
  return { email, parserId: "none", result: { kind: "unparsed", reason: "no plugin matched (fallback missing from registry)" } };
}
