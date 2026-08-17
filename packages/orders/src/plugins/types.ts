import type { Order, ReturnWindow, Shipment } from "@northcinder/protocol";
import type { ParsedEmail } from "../eml.js";

/**
 * One deterministic parser plugin's verdict on one email. NO LLM anywhere in
 * this path (determinism law) — every plugin is a fixed set of regex/keyword
 * rules over RFC-defined + real-world merchant email structure.
 */
export type PluginParseResult =
  | { kind: "order"; order: Omit<Order, "id" | "source"> }
  | { kind: "shipment"; shipment: Omit<Shipment, "id" | "orderId">; orderNumber: string; merchantDomain?: string }
  | {
      kind: "return_window";
      returnWindow: Omit<ReturnWindow, "orderId">;
      orderNumber: string;
      merchantDomain?: string;
    }
  | { kind: "unparsed"; reason: string };

/**
 * Plugin architecture (brief requirement): per-merchant/per-format plugin
 * table + a generic fallback, checked IN ORDER — the first plugin whose
 * `matches` returns true owns the parse. A plugin that matches but can't
 * confidently extract fields returns `{kind: "unparsed", reason}` rather
 * than guessing — the caller never invents a value a plugin didn't produce.
 */
export interface OrderParsePlugin {
  id: string;
  matches(email: ParsedEmail): boolean;
  parse(email: ParsedEmail): PluginParseResult;
}
