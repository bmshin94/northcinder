import { z } from "zod";
import { MoneySchema, OfferSchema, requiresNativeRevalidation, SearchQuerySchema } from "./core.js";

/**
 * Price-watch schemas (watch — the wedge feature). A watch NOTIFIES the user
 * when a target price is hit; it NEVER buys (safety contract law: no code path from a
 * watch to checkout exists — enforced by an architectural test in
 * @northcinder/watches). A notification may deep-link the user to the product
 * page so THEY can start a normal, human-approved purchase authorization.
 */

/** Default watch lifetime: ~6 months (183 days). */
export const WATCH_DEFAULT_TTL_DAYS = 183;

/**
 * What the watch is watching: a specific offer seen in a search (re-checked
 * by re-fetching that store's listing through the normal search path), or a
 * standing query (cheapest constraint-matching offer wins).
 */
const WatchableOfferSchema = OfferSchema.superRefine((offer, context) => {
  if (requiresNativeRevalidation(offer)) {
    context.addIssue({
      code: "custom",
      path: ["acquisition"],
      message:
        `native_revalidation_required: agent-observed offers cannot be watched until a native store connection revalidates them; open ${offer.product.url}`,
    });
  }
});

export const WatchTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offer"), offer: WatchableOfferSchema }),
  z.object({ kind: z.literal("query"), query: SearchQuerySchema }),
]);
export type WatchTarget = z.infer<typeof WatchTargetSchema>;

/**
 * Where a target-hit notification goes. The ntfy topic is a BEARER SECRET
 * (anyone who knows it can read the notifications) — it lives only in the
 * 0600 watches file and is never echoed into tool results or logs.
 */
export const WatchChannelSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ntfy"),
    /** Topic override; defaults to the runner's configured NORTHCINDER_NTFY_TOPIC. */
    topic: z.string().min(8).optional(),
  }),
  z.object({ type: z.literal("stderr") }),
  z.object({
    type: z.literal("file"),
    /** Absolute path override; defaults to <configDir>/notifications.jsonl. */
    path: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("webhook"), url: z.url() }),
]);
export type WatchChannel = z.infer<typeof WatchChannelSchema>;

/**
 * Channels an MCP host may select while creating a watch. Destination details
 * remain scheduler-owned configuration, so model input cannot choose a path,
 * bearer topic, or webhook target.
 */
export const McpWatchChannelSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ntfy") }).strict(),
  z.object({ type: z.literal("stderr") }).strict(),
  z.object({ type: z.literal("file") }).strict(),
]);
export type McpWatchChannel = z.infer<typeof McpWatchChannelSchema>;

export const WatchStateSchema = z.enum(["active", "cancelled", "expired"]);
export type WatchState = z.infer<typeof WatchStateSchema>;

/** Structured outcome of one scheduler tick over one watch. */
export const WatchCheckOutcomeSchema = z.enum([
  "above_target",
  "target_hit_notified",
  "target_hit_deduped",
  "offer_not_found",
  "notify_failed",
  "cooldown_deferred",
  "expired",
]);
export type WatchCheckOutcome = z.infer<typeof WatchCheckOutcomeSchema>;

/**
 * Last check status, persisted so a crashed/restarted scheduler resumes
 * idempotently and the dashboard (local UI) can show watch health honestly.
 */
export const WatchLastStatusSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), outcome: WatchCheckOutcomeSchema }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string().min(1), message: z.string().min(1) }),
  }),
]);
export type WatchLastStatus = z.infer<typeof WatchLastStatusSchema>;

export const WatchSchema = z.object({
  id: z.string().min(1),
  /** Human-readable name shown in every notification. */
  name: z.string().min(1),
  target: WatchTargetSchema,
  /** Notify when the current price is at or below this. */
  targetPrice: MoneySchema,
  /** Variant constraints the matched offer must satisfy (e.g. "128GB"). */
  mustHaveAttributes: z.array(z.string().min(1)).default([]),
  channel: WatchChannelSchema,
  createdAt: z.iso.datetime(),
  /** Watches auto-complete at expiry (default createdAt + ~6 months). */
  expiresAt: z.iso.datetime(),
  state: WatchStateSchema,
  /** Crash-safe scheduler state — persisted after every check. */
  lastCheckedAt: z.iso.datetime().optional(),
  lastPrice: MoneySchema.optional(),
  lastStatus: WatchLastStatusSchema.optional(),
  lastSuccessAt: z.iso.datetime().optional(),
  lastFailureAt: z.iso.datetime().optional(),
  nextEligibleCheckAt: z.iso.datetime().optional(),
  /**
   * At-least-once notification dedupe, persisted across restarts: one entry
   * per already-notified price bucket (see priceBucket in @northcinder/watches).
   * The full dedupe key is watchId + bucket; buckets live on their watch.
   */
  notifiedBuckets: z.array(z.string().min(1)).default([]),
});
export type Watch = z.infer<typeof WatchSchema>;
