/**
 * Local trust evidence (local trust evidence, spec §5.3): the user's OWN
 * purchase history with a merchant, appended to trust-signal output as
 * DISPLAY-ONLY evidence. It NEVER enters ranking inputs — the service's
 * trust signal is what `rankOffers`/the client's re-rank verification
 * consume, so `rankingVerified` is unaffected by whether local history
 * exists (see local-trust-evidence.test.ts's rankingVerified-unchanged
 * property, and server.test.ts for the search_products end-to-end proof).
 *
 * Two local data sources, two matching rules (decided + documented here,
 * not guessed at the call site):
 *
 *  - Checkout records (`client/src/order-store.ts`'s `orders.jsonl`): each
 *    one was bound to a real `Merchant.id` at authorization time
 *    (`complete_checkout` stamps both values from the authorized offer), so
 *    `(record.merchantDomain, record.merchantId)` is the collision-safe match
 *    for this source. Legacy records without the domain are deliberately not
 *    attributed: an honest missing-history line is safer than a false claim.
 *
 *  - Order-graph entries (`@northcinder/orders`' email-derived/import `Order`s):
 *    email parsers only ever recover the sender's domain, never a
 *    platform-internal merchant id, so these match on
 *    `order.merchantDomain` (case-insensitive) `=== merchant.domain`.
 *    Graph orders whose `source.kind === "checkout"` are EXCLUDED from this
 *    lookup — they are the same purchases already counted via
 *    `checkoutOrders` above (see @northcinder/orders/store.ts's
 *    `orderRecordToOrder`), so counting both would double-count one
 *    purchase and the checkout adapter's synthetic `merchantDomain` (it
 *    reuses `merchantId`, not a real domain) would otherwise pollute the
 *    delivered-date lookup.
 *
 * "Completed" = checkout records with `status === "completed"` (the rail
 * itself made the purchase). `status === "handed_off"` is NOT counted:
 * a handoff means the user's OWN browser session had to finish the
 * purchase, and this client never observes that finishing — counting it
 * would claim a completion we cannot actually verify.
 *
 * "Last delivered" = the most recent `orderDate` among matching order-graph
 * entries whose `status === "delivered"`. If there is no completed checkout
 * order for this merchant (N === 0), NO evidence line is produced at all:
 * absence of local history is never surfaced as either a negative or a
 * padded-positive signal, only ever a fact we can back with a real
 * completed local purchase.
 *
 * Hostile/malformed stored data (a corrupt orders.jsonl line that still
 * parsed as *some* JSON shape, a hand-edited order-graph file, etc.) is
 * sanitized by construction: the evidence `detail` string is built ENTIRELY
 * from code-composed English + our own count/date — it never interpolates
 * a stored merchant name or any other free-text field, so there is no
 * markup-injection surface to defend even though `local-ui.ts` also
 * HTML-escapes at render (defense in depth, not the only layer). Any
 * record that isn't shaped the way we expect is skipped, never thrown on.
 */
import type { LifecycleReminder, Merchant, Order, PurchaseOutcome, TrustEvidence } from "@northcinder/protocol";
import type { OrderRecord } from "@northcinder/checkout";

/** Distinct from every service-side evidence `source` (e.g. "seed-list", "rdap", "tranco"). */
export const LOCAL_TRUST_EVIDENCE_SOURCE = "local-orders";

export interface LocalTrustEvidenceInput {
  merchant: Pick<Merchant, "id" | "domain">;
  /** From `OrderStore.list()` — this session's/user's persisted checkout records. */
  checkoutOrders: readonly OrderRecord[];
  /**
   * From `OrderGraphStore.listOrders()` — email/import-derived order-graph
   * entries. Pass the RAW graph (not merged with checkoutOrders) or filter
   * out `source.kind === "checkout"` entries yourself; this function also
   * defensively skips them itself (belt + suspenders — see module doc).
   */
  graphOrders?: readonly Order[];
  /** Confirmed buyer-local outcomes linked only through a matching completed checkout order id. */
  outcomes?: readonly PurchaseOutcome[];
  lifecycleReminders?: readonly LifecycleReminder[];
  now?: () => Date;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** ISO date (YYYY-MM-DD) from epoch millis — plain, no locale formatting. */
function isoDateFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function deriveLocalTrustEvidence(input: LocalTrustEvidenceInput): TrustEvidence[] {
  try {
    const { merchant, checkoutOrders, graphOrders = [], outcomes = [], lifecycleReminders = [] } = input;
    if (!isNonEmptyString(merchant?.id) || !isNonEmptyString(merchant?.domain)) return [];

    let completedCount = 0;
    const matchingCompletedOrderIds = new Set<string>();
    const outcomeEligibleOrderIds = new Set<string>();
    for (const record of checkoutOrders) {
      if (!record || typeof record !== "object") continue; // malformed line: skip, never throw
      if (!isNonEmptyString((record as OrderRecord).merchantId)) continue;
      if (!isNonEmptyString((record as OrderRecord).merchantDomain)) continue;
      if ((record as OrderRecord).merchantId !== merchant.id) continue;
      if ((record as OrderRecord).merchantDomain.toLowerCase() !== merchant.domain.toLowerCase()) continue;
      outcomeEligibleOrderIds.add((record as OrderRecord).orderId);
      if ((record as OrderRecord).status === "completed") {
        completedCount += 1;
        matchingCompletedOrderIds.add((record as OrderRecord).orderId);
      }
    }
    for (const order of graphOrders) {
      if (!order || typeof order !== "object" || order.source?.kind === "checkout") continue;
      if (isNonEmptyString(order.merchantDomain) && order.merchantDomain.toLowerCase() === merchant.domain.toLowerCase()) {
        outcomeEligibleOrderIds.add(order.id);
      }
    }

    const merchantDomainLower = merchant.domain.toLowerCase();
    let lastDeliveredMs: number | undefined;
    for (const order of graphOrders) {
      if (!order || typeof order !== "object") continue;
      if (order.source?.kind === "checkout") continue; // already counted above; avoid double-count + synthetic domain
      if (!isNonEmptyString(order.merchantDomain)) continue;
      if (order.merchantDomain.toLowerCase() !== merchantDomainLower) continue;
      if (order.status !== "delivered") continue;
      const ms = Date.parse(order.orderDate);
      if (!Number.isFinite(ms)) continue;
      if (lastDeliveredMs === undefined || ms > lastDeliveredMs) lastDeliveredMs = ms;
    }

    const orderWord = completedCount === 1 ? "order" : "orders";
    const detail =
      lastDeliveredMs !== undefined
        ? `your history: ${completedCount} completed ${orderWord} from this merchant, last delivered ${isoDateFromMs(lastDeliveredMs)} (local orders)`
        : `your history: ${completedCount} completed ${orderWord} from this merchant (local orders)`;

    const now = input.now ?? (() => new Date());
    const evidence: TrustEvidence[] = completedCount === 0 ? [] : [{ source: LOCAL_TRUST_EVIDENCE_SOURCE, detail, fetchedAt: now().toISOString() }];
    const confirmed = outcomes.filter((outcome) => outcome && outcomeEligibleOrderIds.has(outcome.orderId)).slice(0, 20);
    if (confirmed.length > 0) {
      const count = (selector: (outcome: PurchaseOutcome) => string | undefined): string => {
        const counts = new Map<string, number>();
        for (const outcome of confirmed) {
          const value = selector(outcome);
          if (value !== undefined && value !== "unknown" && value !== "not_used") counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, total]) => `${value} ${total}`).join("; ");
      };
      const states = count((outcome) => outcome.state);
      const delivery = count((outcome) => outcome.merchantDelivery);
      const support = count((outcome) => outcome.merchantSupport);
      evidence.push({ source: LOCAL_TRUST_EVIDENCE_SOURCE, detail: `your confirmed local outcomes: ${states}${delivery ? `; delivery ${delivery}` : ""}${support ? `; support ${support}` : ""} (local orders)`, fetchedAt: now().toISOString() });
    }
    const matchedLifecycle = lifecycleReminders.filter((reminder) => outcomeEligibleOrderIds.has(reminder.orderId)).slice(0, 20);
    if (matchedLifecycle.length > 0) {
      const sent = matchedLifecycle.filter((reminder) => reminder.reminderSentAt !== undefined).length;
      evidence.push({ source: LOCAL_TRUST_EVIDENCE_SOURCE, detail: `your lifecycle reminders: ${matchedLifecycle.length - sent} pending; ${sent} sent (local orders)`, fetchedAt: now().toISOString() });
    }
    if (evidence.length === 0) return [];
    return evidence;
  } catch {
    // Never let hostile/malformed stored data throw across this boundary —
    // display-only evidence degrades to "nothing to say", never a crash.
    return [];
  }
}
