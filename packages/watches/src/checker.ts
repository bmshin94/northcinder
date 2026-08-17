/**
 * The watch checker: re-fetches current offers through a minimal OfferSource
 * (the client wires its EXISTING budgeted service-client path into this — the
 * checker itself opens no network connections), compares against the target,
 * and notifies AT LEAST ONCE per (watchId, priceBucket) with the dedupe
 * ledger persisted on the watch record so restarts never spam.
 *
 * Crash-safety contract:
 *   - lastCheckedAt / lastPrice / lastStatus are persisted on every check.
 *   - the dedupe bucket is persisted only AFTER a notification succeeds —
 *     a crash between send and persist re-notifies (at-least-once, by design);
 *     a failed send is retried next tick.
 *
 * LAW (safety contract): a check can end in a NOTIFICATION and nothing else. There is no
 * checkout dependency and no purchase code path — enforced by the
 * architectural test in test/no-checkout-path.test.ts.
 */
import {
  requiresNativeRevalidation,
  type Money,
  type Offer,
  type SearchQuery,
  type Watch,
  type WatchChannel,
  type WatchCheckOutcome,
} from "@northcinder/protocol";
import type { Notifier } from "./notify.js";
import type { WatchStore } from "./store.js";

/**
 * Where current offers come from. The client adapts its budgeted service
 * client to this; tests and the fixture mode adapt a StoreAdapter. Errors are
 * structured — a source failure never throws and never kills a watch.
 */
export interface OfferSource {
  search(
    query: SearchQuery,
  ): Promise<{ ok: true; offers: Offer[] } | { ok: false; error: { code: string; message: string } }>;
}

export interface CheckDeps {
  store: WatchStore;
  source: OfferSource;
  /** Maps a watch's channel to a concrete Notifier (runner-owned config). */
  notifierFor(channel: WatchChannel): Notifier;
  now?: () => Date;
}

export interface WatchCheckReport {
  watchId: string;
  name: string;
  outcome: WatchCheckOutcome | "source_error";
  currentPrice?: Money;
  error?: { code: string; message: string };
}

/**
 * Dedupe bucket: 1% of the target price wide (≥1 minor unit). Sub-1% price
 * jitter lands in the same bucket (no spam); a real further drop is a new
 * bucket (that IS news). Deterministic and auditable — no model involved.
 */
export function priceBucket(current: Money, target: Money): string {
  const width = Math.max(1, Math.floor(target.amount / 100));
  return `${current.currency}:${Math.floor(current.amount / width)}`;
}

function matchesConstraints(offer: Offer, mustHave: string[]): boolean {
  if (mustHave.length === 0) return true;
  const haystack = `${offer.product.title} ${Object.entries(offer.product.attributes).flat().join(" ")}`.toLowerCase();
  return mustHave.every((attr) => haystack.includes(attr.toLowerCase()));
}

/** The query a check sends through the normal search path. */
function queryFor(watch: Watch): SearchQuery {
  if (watch.target.kind === "query") return watch.target.query;
  return { text: watch.target.offer.product.title, maxResults: 50 };
}

/**
 * Picks the offer this watch is about:
 *   - offer watches: the SAME listing (sourceStore + offer id) — a different
 *     listing is never silently substituted;
 *   - query watches: the cheapest currency-matching offer.
 * Both must satisfy the variant constraints (mustHaveAttributes).
 */
function currentOffer(watch: Watch, offers: Offer[]): Offer | undefined {
  const candidates = offers.filter(
    (o) => o.price.currency === watch.targetPrice.currency && matchesConstraints(o, watch.mustHaveAttributes),
  );
  if (watch.target.kind === "offer") {
    const { offer } = watch.target;
    return candidates.find((o) => o.sourceStore === offer.sourceStore && o.id === offer.id);
  }
  return candidates.reduce<Offer | undefined>(
    (best, o) => (best === undefined || o.price.amount < best.price.amount ? o : best),
    undefined,
  );
}

export async function checkWatch(watch: Watch, deps: CheckDeps): Promise<WatchCheckReport> {
  const now = (deps.now ?? (() => new Date()))();
  const checkedAt = now.toISOString();
  const report = (outcome: WatchCheckReport["outcome"], extra: Partial<WatchCheckReport> = {}): WatchCheckReport => ({
    watchId: watch.id,
    name: watch.name,
    outcome,
    ...extra,
  });

  if (watch.target.kind === "offer" && requiresNativeRevalidation(watch.target.offer)) {
    const error = {
      code: "native_revalidation_required",
      message:
        `agent-observed offers cannot be watched until a native store connection revalidates them; open ${watch.target.offer.product.url}`,
    };
    deps.store.update(watch.id, { lastCheckedAt: checkedAt, lastStatus: { ok: false, error } });
    return report("source_error", { error });
  }

  // Expiry auto-completes the watch — checked BEFORE any network call.
  if (now.getTime() >= Date.parse(watch.expiresAt)) {
    deps.store.update(watch.id, { state: "expired", lastCheckedAt: checkedAt, lastStatus: { ok: true, outcome: "expired" } });
    return report("expired");
  }

  const result = await deps.source.search(queryFor(watch));
  if (!result.ok) {
    // Structured failure: the watch STAYS ACTIVE and is retried next tick.
    deps.store.update(watch.id, { lastCheckedAt: checkedAt, lastStatus: { ok: false, error: result.error } });
    return report("source_error", { error: result.error });
  }

  const offer = currentOffer(watch, result.offers);
  if (offer === undefined) {
    deps.store.update(watch.id, { lastCheckedAt: checkedAt, lastStatus: { ok: true, outcome: "offer_not_found" } });
    return report("offer_not_found");
  }

  const price = offer.price;
  if (price.amount > watch.targetPrice.amount) {
    deps.store.update(watch.id, { lastCheckedAt: checkedAt, lastPrice: price, lastStatus: { ok: true, outcome: "above_target" } });
    return report("above_target", { currentPrice: price });
  }

  // Target hit. Dedupe key = watchId + priceBucket, persisted across restarts.
  const bucket = priceBucket(price, watch.targetPrice);
  const dedupeKey = `${watch.id}:${bucket}`;
  if (watch.notifiedBuckets.includes(bucket)) {
    deps.store.update(watch.id, { lastCheckedAt: checkedAt, lastPrice: price, lastStatus: { ok: true, outcome: "target_hit_deduped" } });
    return report("target_hit_deduped", { currentPrice: price });
  }

  const sent = await deps.notifierFor(watch.channel).send({
    watchId: watch.id,
    watchName: watch.name,
    currentPrice: price,
    targetPrice: watch.targetPrice,
    merchantName: offer.merchant.name,
    merchantId: offer.merchant.id,
    productTitle: offer.product.title,
    url: offer.product.url,
    dedupeKey,
    at: checkedAt,
  });
  if (!sent.ok) {
    // NOT marked delivered — the same bucket retries next tick (at-least-once).
    deps.store.update(watch.id, { lastCheckedAt: checkedAt, lastPrice: price, lastStatus: { ok: false, error: sent.error } });
    return report("notify_failed", { currentPrice: price, error: sent.error });
  }
  deps.store.update(watch.id, {
    lastCheckedAt: checkedAt,
    lastPrice: price,
    lastStatus: { ok: true, outcome: "target_hit_notified" },
    notifiedBuckets: [...watch.notifiedBuckets, bucket],
  });
  return report("target_hit_notified", { currentPrice: price });
}
