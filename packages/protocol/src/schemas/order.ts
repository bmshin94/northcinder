import { z } from "zod";
import { MoneySchema } from "./core.js";

/**
 * Post-purchase order graph (order graph): the open contract for orders merged from
 * (a) our own checkout records and (b) deterministically parsed order
 * emails. NO LLM parsing anywhere in this graph (determinism law) — every
 * field here is either produced by our own checkout orchestrator or by a
 * deterministic per-merchant/per-format parser plugin + regex fallback.
 * Unparseable mail is NEVER dropped: it lands as an UnparsedEmailRecord
 * (see below), citing the raw subject, so a human can `import_order` what
 * parsing missed.
 */

export const OrderItemSchema = z.object({
  title: z.string().min(1),
  quantity: z.int().positive(),
  /** Unit price if the source stated one (email order confirmations usually do). */
  unitPrice: MoneySchema.optional(),
});
export type OrderItem = z.infer<typeof OrderItemSchema>;

export const OrderStatusSchema = z.enum(["confirmed", "shipped", "delivered", "returned", "unknown"]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/**
 * Provenance of one Order record — never ambiguous about where it came from.
 * "checkout": produced by OUR OWN checkout orchestrator (cites its orderId).
 * "email": produced by a deterministic parser plugin (cites the plugin id
 *   and the source message id, for audit/debugging of parser drift).
 * "import": hand-entered via the `import_order` tool (what parsing missed).
 */
export const OrderSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("checkout"), orderId: z.string().min(1) }),
  z.object({ kind: z.literal("email"), messageId: z.string().min(1), parser: z.string().min(1) }),
  z.object({ kind: z.literal("import") }),
]);
export type OrderSource = z.infer<typeof OrderSourceSchema>;

export const OrderSchema = z.object({
  id: z.string().min(1),
  /** Merchant's own order number/confirmation number, when stated. */
  orderNumber: z.string().min(1).optional(),
  merchantName: z.string().min(1),
  merchantDomain: z.string().min(1).optional(),
  orderDate: z.iso.datetime(),
  items: z.array(OrderItemSchema).default([]),
  /** Order total, when the source stated one. */
  total: MoneySchema.optional(),
  status: OrderStatusSchema,
  source: OrderSourceSchema,
});
export type Order = z.infer<typeof OrderSchema>;

export const CarrierSchema = z.enum(["ups", "usps", "fedex", "dhl", "other"]);
export type Carrier = z.infer<typeof CarrierSchema>;

export const ShipmentStatusSchema = z.enum(["label_created", "in_transit", "out_for_delivery", "delivered", "exception"]);
export type ShipmentStatus = z.infer<typeof ShipmentStatusSchema>;

export const ShipmentEventSchema = z.object({
  status: ShipmentStatusSchema,
  at: z.iso.datetime(),
  location: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});
export type ShipmentEvent = z.infer<typeof ShipmentEventSchema>;

export const ShipmentSchema = z.object({
  id: z.string().min(1),
  /** The order this shipment belongs to (linked by orderNumber match at ingest, see @northcinder/orders). */
  orderId: z.string().min(1).optional(),
  carrier: CarrierSchema,
  trackingNumber: z.string().min(1),
  trackingUrl: z.url().optional(),
  status: ShipmentStatusSchema,
  events: z.array(ShipmentEventSchema).default([]),
});
export type Shipment = z.infer<typeof ShipmentSchema>;

/** What the deadline was computed from — never silently guessed. */
export const ReturnWindowBasisSchema = z.enum(["delivery_date", "order_date", "stated_deadline"]);
export type ReturnWindowBasis = z.infer<typeof ReturnWindowBasisSchema>;

export const ReturnWindowSchema = z.object({
  orderId: z.string().min(1),
  /** ISO 8601 date (not datetime) — a return deadline is a calendar day. */
  deadline: z.iso.date(),
  policyDays: z.int().nonnegative().optional(),
  basis: ReturnWindowBasisSchema,
  /** Set once the N-days-before reminder has actually been sent (dedupe). */
  reminderSentAt: z.iso.datetime().optional(),
});
export type ReturnWindow = z.infer<typeof ReturnWindowSchema>;

export const PurchaseOutcomeStateSchema = z.enum(["kept", "returned", "cancelled", "failed"]);
export type PurchaseOutcomeState = z.infer<typeof PurchaseOutcomeStateSchema>;

export const FitCompatibilityResultSchema = z.enum(["fit", "did_not_fit", "compatible", "incompatible", "not_assessed"]);
export type FitCompatibilityResult = z.infer<typeof FitCompatibilityResultSchema>;

export const PredictionErrorSchema = z.enum(["fit", "compatibility", "price", "delivery", "quality", "seller", "none"]);
export type PredictionError = z.infer<typeof PredictionErrorSchema>;

export const MerchantDeliveryOutcomeSchema = z.enum(["on_time", "late", "failed", "unknown"]);
export type MerchantDeliveryOutcome = z.infer<typeof MerchantDeliveryOutcomeSchema>;

export const MerchantSupportOutcomeSchema = z.enum(["helpful", "unhelpful", "not_used", "unknown"]);
export type MerchantSupportOutcome = z.infer<typeof MerchantSupportOutcomeSchema>;

export const PurchaseOutcomeInputSchema = z
  .object({
    orderId: z.string().min(1),
    state: PurchaseOutcomeStateSchema,
    fitOrCompatibility: FitCompatibilityResultSchema.optional(),
    predictionError: PredictionErrorSchema.optional(),
    merchantDelivery: MerchantDeliveryOutcomeSchema.optional(),
    merchantSupport: MerchantSupportOutcomeSchema.optional(),
    wouldChooseAgain: z.boolean().optional(),
  })
  .strict();
export type PurchaseOutcomeInput = z.infer<typeof PurchaseOutcomeInputSchema>;

export const PurchaseOutcomeSchema = PurchaseOutcomeInputSchema.extend({ recordedAt: z.iso.datetime() }).strict();
export type PurchaseOutcome = z.infer<typeof PurchaseOutcomeSchema>;

const LifecycleReminderInputShape = {
  kind: z.enum(["warranty", "maintenance"]),
  dueOn: z.iso.date(),
  remindOn: z.iso.date(),
  detail: z.string().min(1).max(500),
};

function rejectInvertedReminderDate(value: { dueOn: string; remindOn: string }, context: z.RefinementCtx): void {
  if (value.remindOn > value.dueOn) {
    context.addIssue({ code: "custom", path: ["remindOn"], message: "remindOn must not be after dueOn" });
  }
}

export const LifecycleReminderInputSchema = z.object(LifecycleReminderInputShape).strict().superRefine(rejectInvertedReminderDate);
export type LifecycleReminderInput = z.infer<typeof LifecycleReminderInputSchema>;

export const LifecycleReminderSchema = z
  .object({
    id: z.string().min(1),
    orderId: z.string().min(1),
    ...LifecycleReminderInputShape,
    createdAt: z.iso.datetime(),
    reminderSentAt: z.iso.datetime().optional(),
  })
  .strict()
  .superRefine(rejectInvertedReminderDate);
export type LifecycleReminder = z.infer<typeof LifecycleReminderSchema>;

/**
 * An email that no parser plugin (including the generic fallback) could
 * confidently parse. NEVER dropped — the raw subject is retained so a human
 * can `import_order` what parsing missed (determinism law: no LLM guesses
 * fill this gap).
 */
export const UnparsedEmailRecordSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  from: z.string().min(1),
  receivedAt: z.iso.datetime(),
  reason: z.string().min(1),
  source: z.enum(["drop_dir", "imap"]),
});
export type UnparsedEmailRecord = z.infer<typeof UnparsedEmailRecordSchema>;
