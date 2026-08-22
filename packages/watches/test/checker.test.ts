import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Offer, Watch, WatchChannel } from "@northcinder/protocol";
import {
  checkWatch,
  createWatchStore,
  priceBucket,
  runWatchesOnce,
  type Notifier,
  type OfferSource,
  type WatchStore,
  type WatchNotification,
} from "../src/index.js";

const OFFER: Offer = {
  id: "off-1",
  product: { id: "p-1", title: "Fairphone 5 128GB", url: "https://shop.example/p1", attributes: { storage: "128GB" } },
  price: { amount: 59900, currency: "EUR" },
  merchant: { id: "shop.example", name: "Shop Example", domain: "shop.example" },
  availability: "in_stock",
  sourceStore: "reference",
  sponsored: false,
};

function sourceWithPrice(amount: number, overrides: Partial<Offer> = {}): OfferSource {
  return {
    async search() {
      return { ok: true, offers: [{ ...OFFER, price: { amount, currency: "EUR" }, ...overrides }] };
    },
    async getOffer() {
      return { ok: true, offer: { ...OFFER, price: { amount, currency: "EUR" }, ...overrides } };
    },
  };
}

function collectingNotifier(sent: WatchNotification[]): Notifier {
  return {
    id: "collect",
    async send(n) {
      sent.push(n);
      return { ok: true };
    },
  };
}

function deps(dir: string, source: OfferSource, sent: WatchNotification[], now = () => new Date("2026-07-05T12:00:00.000Z")) {
  return {
    store: createWatchStore({ configDir: dir, now }),
    source,
    notifierFor: (_channel: WatchChannel) => collectingNotifier(sent),
    now,
  };
}

function freshWatchDir(): string {
  return mkdtempSync(join(tmpdir(), "northcinder-watches-check-"));
}

function createFairphoneWatch(dir: string, targetAmount = 55000) {
  const store = createWatchStore({ configDir: dir, now: () => new Date("2026-07-05T00:00:00.000Z") });
  return store.create({
    name: "Fairphone below target",
    target: { kind: "offer", offer: OFFER },
    targetPrice: { amount: targetAmount, currency: "EUR" },
  });
}

describe("watch checker + scheduler (crash-safe, at-least-once with dedupe)", () => {
  it("exact offer watches call getOffer only, and equal watches share that one call per tick", async () => {
    const dir = freshWatchDir();
    const first = createFairphoneWatch(dir);
    createWatchStore({ configDir: dir, now: () => new Date("2026-07-05T00:00:00.000Z") }).create({ name: "same", target: first.target, targetPrice: first.targetPrice });
    let searches = 0;
    let gets = 0;
    const source: OfferSource = {
      async search() { searches += 1; return { ok: true, offers: [] }; },
      async getOffer(store, offerId) { gets += 1; expect([store, offerId]).toEqual(["reference", "off-1"]); return { ok: true, offer: OFFER }; },
    };
    await runWatchesOnce(deps(dir, source, []));
    expect(searches).toBe(0);
    expect(gets).toBe(1);
  });

  it("contains a rejected coalesced exact refresh so every active watch receives a persisted source error", async () => {
    const dir = freshWatchDir();
    const first = createFairphoneWatch(dir);
    const second = createWatchStore({ configDir: dir, now: () => new Date("2026-07-05T00:00:00.000Z") }).create({ name: "same failing offer", target: first.target, targetPrice: first.targetPrice });
    let calls = 0;
    const source: OfferSource = {
      async search() { return { ok: true, offers: [] }; },
      getOffer() { calls += 1; throw new Error("private upstream detail"); },
    };
    const summary = await runWatchesOnce(deps(dir, source, []));
    expect(calls).toBe(1);
    expect(summary.reports).toEqual([
      expect.objectContaining({ watchId: first.id, outcome: "source_error", error: { code: "source_unavailable", message: "watch source failed unexpectedly" } }),
      expect.objectContaining({ watchId: second.id, outcome: "source_error", error: { code: "source_unavailable", message: "watch source failed unexpectedly" } }),
    ]);
    for (const id of [first.id, second.id]) {
      expect(createWatchStore({ configDir: dir }).get(id)).toMatchObject({
        lastFailureAt: "2026-07-05T12:00:00.000Z",
        lastStatus: { ok: false, error: { code: "source_unavailable", message: "watch source failed unexpectedly" } },
      });
    }
  });

  it("coalesces identical normalized query watches once per tick without getOffer", async () => {
    const dir = freshWatchDir();
    const store = createWatchStore({ configDir: dir, now: () => new Date("2026-07-05T00:00:00.000Z") });
    store.create({ name: "first query", target: { kind: "query", query: { text: "fairphone" } }, targetPrice: { amount: 55000, currency: "EUR" } });
    store.create({ name: "second query", target: { kind: "query", query: { text: "fairphone" } }, targetPrice: { amount: 55000, currency: "EUR" } });
    let searches = 0;
    let gets = 0;
    const source: OfferSource = {
      async search() { searches += 1; return { ok: true, offers: [OFFER] }; },
      async getOffer() { gets += 1; return { ok: true, offer: OFFER }; },
    };
    const summary = await runWatchesOnce(deps(dir, source, []));
    expect(searches).toBe(1);
    expect(gets).toBe(0);
    expect(summary.reports).toHaveLength(2);
    expect(summary.reports.every((report) => report.outcome === "above_target")).toBe(true);
  });

  it("defers a rate-limited watch without source or notifier I/O until eligibility", async () => {
    const dir = freshWatchDir();
    const watch = createFairphoneWatch(dir);
    let calls = 0;
    const limited: OfferSource = { async search() { return { ok: true, offers: [] }; }, async getOffer() { calls += 1; return { ok: false, error: { code: "rate_limited", message: "busy", retryAfterMs: 60_000 } }; } };
    const atFailure = () => new Date("2026-07-05T12:00:00.000Z");
    await runWatchesOnce(deps(dir, limited, [], atFailure));
    const persisted = createWatchStore({ configDir: dir }).get(watch.id)!;
    expect(persisted).toMatchObject({ lastFailureAt: "2026-07-05T12:00:00.000Z", nextEligibleCheckAt: "2026-07-05T12:01:00.000Z" });
    const deferred = await runWatchesOnce(deps(dir, limited, [], () => new Date("2026-07-05T12:00:30.000Z")));
    expect(deferred.reports[0]?.outcome).toBe("cooldown_deferred");
    expect(calls).toBe(1);
    const recovered = await runWatchesOnce(deps(dir, sourceWithPrice(59900), [], () => new Date("2026-07-05T12:01:00.000Z")));
    expect(recovered.reports[0]?.outcome).toBe("above_target");
    const afterRecovery = createWatchStore({ configDir: dir }).get(watch.id)!;
    expect(afterRecovery).toMatchObject({
      lastFailureAt: "2026-07-05T12:00:00.000Z",
      lastSuccessAt: "2026-07-05T12:01:00.000Z",
    });
    expect(afterRecovery.nextEligibleCheckAt).toBeUndefined();
  });
  it("keeps evaluating a successful partial query while persisting its cooldown", async () => {
    const dir = freshWatchDir();
    const store = createWatchStore({ configDir: dir, now: () => new Date("2026-07-05T00:00:00.000Z") });
    const watch = store.create({
      name: "partial query",
      target: { kind: "query", query: { text: "fairphone" } },
      targetPrice: { amount: 60000, currency: "EUR" },
    });
    let sourceCalls = 0;
    const sent: WatchNotification[] = [];
    const partial: OfferSource = {
      async search() { sourceCalls += 1; return { ok: true, offers: [OFFER], retryAfterMs: 60_000 }; },
      async getOffer() { return { ok: true, offer: OFFER }; },
    };
    const first = await runWatchesOnce(deps(dir, partial, sent, () => new Date("2026-07-05T12:00:00.000Z")));
    expect(first.reports[0]).toMatchObject({ watchId: watch.id, outcome: "target_hit_notified" });
    expect(sent).toHaveLength(1);
    expect(createWatchStore({ configDir: dir }).get(watch.id)).toMatchObject({
      lastSuccessAt: "2026-07-05T12:00:00.000Z",
      nextEligibleCheckAt: "2026-07-05T12:01:00.000Z",
    });
    const deferred = await runWatchesOnce(deps(dir, partial, sent, () => new Date("2026-07-05T12:00:30.000Z")));
    expect(deferred.reports[0]).toMatchObject({ outcome: "cooldown_deferred" });
    expect(sourceCalls).toBe(1);
    expect(sent).toHaveLength(1);
  });
  it("saturates an oversized cooldown to expiry without skipping a later watch or doing early I/O", async () => {
    const dir = freshWatchDir();
    const first = createFairphoneWatch(dir);
    const secondOffer = { ...OFFER, id: "off-2", product: { ...OFFER.product, id: "p-2" } };
    const second = createWatchStore({ configDir: dir, now: () => new Date("2026-07-05T00:00:00.000Z") }).create({
      name: "second offer",
      target: { kind: "offer", offer: secondOffer },
      targetPrice: { amount: 55000, currency: "EUR" },
    });
    const calls: string[] = [];
    const source: OfferSource = {
      async search() { return { ok: true, offers: [] }; },
      async getOffer(_store, offerId) {
        calls.push(offerId);
        return offerId === "off-1"
          ? { ok: false, error: { code: "rate_limited", message: "busy", retryAfterMs: 9_000_000_000_000_000 } }
          : { ok: true, offer: secondOffer };
      },
    };
    const firstRun = await runWatchesOnce(deps(dir, source, [], () => new Date("2026-07-05T12:00:00.000Z")));
    expect(firstRun.reports).toEqual([
      expect.objectContaining({ watchId: first.id, outcome: "source_error", error: expect.objectContaining({ code: "rate_limited" }) }),
      expect.objectContaining({ watchId: second.id, outcome: "above_target" }),
    ]);
    expect(createWatchStore({ configDir: dir }).get(first.id)).toMatchObject({
      lastFailureAt: "2026-07-05T12:00:00.000Z",
      nextEligibleCheckAt: first.expiresAt,
    });
    expect(createWatchStore({ configDir: dir }).get(second.id)).toMatchObject({ lastSuccessAt: "2026-07-05T12:00:00.000Z" });
    expect(calls).toEqual(["off-1", "off-2"]);

    const later = await runWatchesOnce(deps(dir, source, [], () => new Date("2026-07-06T12:00:00.000Z")));
    expect(later.reports).toEqual([
      expect.objectContaining({ watchId: first.id, outcome: "cooldown_deferred" }),
      expect.objectContaining({ watchId: second.id, outcome: "above_target" }),
    ]);
    expect(calls).toEqual(["off-1", "off-2", "off-2"]);
    const atExpiry = await runWatchesOnce(deps(dir, source, [], () => new Date(first.expiresAt)));
    expect(atExpiry.reports[0]).toMatchObject({ watchId: first.id, outcome: "expired" });
    expect(createWatchStore({ configDir: dir }).get(first.id)?.state).toBe("expired");
    expect(calls).toEqual(["off-1", "off-2", "off-2"]);
  });

  it("isolates an unexpected per-watch exception and persists a generic failure before continuing", async () => {
    const dir = freshWatchDir();
    const first = createFairphoneWatch(dir);
    const secondOffer = { ...OFFER, id: "off-2", product: { ...OFFER.product, id: "p-2" } };
    const second = createWatchStore({ configDir: dir, now: () => new Date("2026-07-05T00:00:00.000Z") }).create({
      name: "second offer",
      target: { kind: "offer", offer: secondOffer },
      targetPrice: { amount: 55000, currency: "EUR" },
    });
    const baseStore = createWatchStore({ configDir: dir });
    let threw = false;
    const store: WatchStore = {
      ...baseStore,
      update(id, patch) {
        if (id === first.id && !threw) {
          threw = true;
          throw new Error("private profile and provider detail");
        }
        return baseStore.update(id, patch);
      },
    };
    const summary = await runWatchesOnce({
      ...deps(dir, {
        async search() { return { ok: true, offers: [] }; },
        async getOffer(_store, offerId) { return { ok: true, offer: offerId === "off-1" ? OFFER : secondOffer }; },
      }, []),
      store,
    });
    expect(summary.reports).toEqual([
      { watchId: first.id, name: first.name, outcome: "source_error", error: { code: "watch_check_failed", message: "watch check failed unexpectedly" } },
      expect.objectContaining({ watchId: second.id, outcome: "above_target" }),
    ]);
    expect(createWatchStore({ configDir: dir }).get(first.id)).toMatchObject({
      lastFailureAt: "2026-07-05T12:00:00.000Z",
      lastStatus: { ok: false, error: { code: "watch_check_failed", message: "watch check failed unexpectedly" } },
    });
    expect(createWatchStore({ configDir: dir }).get(second.id)).toMatchObject({ lastSuccessAt: "2026-07-05T12:00:00.000Z" });
    expect(JSON.stringify(summary)).not.toContain("private profile");
  });
  it("above target: no notification, lastCheckedAt/lastPrice persisted (crash-safe resume state)", async () => {
    const dir = freshWatchDir();
    const watch = createFairphoneWatch(dir, 55000);
    const sent: WatchNotification[] = [];
    const summary = await runWatchesOnce(deps(dir, sourceWithPrice(59900), sent));
    expect(sent).toEqual([]);
    expect(summary.reports).toEqual([
      expect.objectContaining({ watchId: watch.id, outcome: "above_target", currentPrice: { amount: 59900, currency: "EUR" } }),
    ]);
    const persisted = createWatchStore({ configDir: dir }).get(watch.id)!;
    expect(persisted.lastCheckedAt).toBe("2026-07-05T12:00:00.000Z");
    expect(persisted.lastPrice).toEqual({ amount: 59900, currency: "EUR" });
    expect(persisted.state).toBe("active");
  });

  it("KEY: target-hit notifies exactly once per price bucket ACROSS RESTARTS (dedupe persisted)", async () => {
    const dir = freshWatchDir();
    const watch = createFairphoneWatch(dir, 55000);
    const sent: WatchNotification[] = [];

    // Run 1 — price hits the target: one notification.
    const run1 = await runWatchesOnce(deps(dir, sourceWithPrice(54900), sent));
    expect(run1.reports[0]).toMatchObject({ watchId: watch.id, outcome: "target_hit_notified" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      watchId: watch.id,
      watchName: "Fairphone below target",
      currentPrice: { amount: 54900, currency: "EUR" },
      targetPrice: { amount: 55000, currency: "EUR" },
      merchantName: "Shop Example",
      url: "https://shop.example/p1",
    });

    // Run 2 — SIMULATED RESTART: brand-new store instance over the same dir,
    // same price bucket → deduped, NO second notification.
    const run2 = await runWatchesOnce(deps(dir, sourceWithPrice(54900), sent));
    expect(run2.reports[0]).toMatchObject({ watchId: watch.id, outcome: "target_hit_deduped" });
    expect(sent).toHaveLength(1);

    // Run 3 — price drops much further (a NEW bucket): that IS news → notify again.
    const run3 = await runWatchesOnce(deps(dir, sourceWithPrice(49000), sent));
    expect(run3.reports[0]).toMatchObject({ watchId: watch.id, outcome: "target_hit_notified" });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.currentPrice).toEqual({ amount: 49000, currency: "EUR" });
  });

  it("failed notification is NOT recorded as delivered — next run retries (at-least-once)", async () => {
    const dir = freshWatchDir();
    const watch = createFairphoneWatch(dir, 55000);
    const sent: WatchNotification[] = [];
    const failing: Notifier = {
      id: "fail",
      async send() {
        return { ok: false, error: { code: "notifier_unreachable", message: "connection refused" } };
      },
    };
    const failDeps = { ...deps(dir, sourceWithPrice(54900), sent), notifierFor: () => failing };
    const run1 = await runWatchesOnce(failDeps);
    expect(run1.reports[0]).toMatchObject({ watchId: watch.id, outcome: "notify_failed" });

    // Recovery run with a working notifier: the SAME bucket still notifies.
    const run2 = await runWatchesOnce(deps(dir, sourceWithPrice(54900), sent));
    expect(run2.reports[0]).toMatchObject({ outcome: "target_hit_notified" });
    expect(sent).toHaveLength(1);
  });

  it("adapter/source failure: watch stays ACTIVE with a structured error status, retried next tick", async () => {
    const dir = freshWatchDir();
    const watch = createFairphoneWatch(dir);
    const sent: WatchNotification[] = [];
    const broken: OfferSource = {
      async search() {
        return { ok: false, error: { code: "service_unreachable", message: "northcinder service unreachable (network)" } };
      },
      async getOffer() { return { ok: false, error: { code: "service_unreachable", message: "northcinder service unreachable (network)" } }; },
    };
    const run = await runWatchesOnce(deps(dir, broken, sent));
    expect(run.reports[0]).toMatchObject({
      watchId: watch.id,
      outcome: "source_error",
      error: { code: "service_unreachable" },
    });
    const persisted = createWatchStore({ configDir: dir }).get(watch.id)!;
    expect(persisted.state).toBe("active");
    expect(persisted.lastStatus).toEqual({
      ok: false,
      error: { code: "service_unreachable", message: "northcinder service unreachable (network)" },
    });
    expect(sent).toEqual([]);

    // Next tick with a healthy source: normal check resumes.
    const recovered = await runWatchesOnce(deps(dir, sourceWithPrice(59900), sent));
    expect(recovered.reports[0]).toMatchObject({ outcome: "above_target" });
  });

  it("rejects a programmatic agent-observed target before calling its source or notifier", async () => {
    const productUrl = "https://observed-shop.example/products/fairphone-5";
    const observedOffer: Offer = {
      ...OFFER,
      product: { ...OFFER.product, url: productUrl },
      price: { amount: 100, currency: "EUR" },
      sourceStore: "agent_browser",
    };
    const watch: Watch = {
      id: "watch_programmatic_observation",
      name: "Observed Fairphone",
      target: { kind: "offer", offer: observedOffer },
      targetPrice: { amount: 55000, currency: "EUR" },
      mustHaveAttributes: [],
      channel: { type: "stderr" },
      createdAt: "2026-08-16T10:02:00.000Z",
      expiresAt: "2027-02-15T10:02:00.000Z",
      state: "active",
      notifiedBuckets: [],
    };
    let sourceCalls = 0;
    let notifierCalls = 0;
    let persistedPatch: Parameters<WatchStore["update"]>[1] | undefined;
    const store: WatchStore = {
      path: "/unused",
      list: () => [watch],
      get: () => watch,
      create: () => watch,
      cancel: () => ({ ok: false, reason: "not_active" }),
      update: (_id, patch) => {
        persistedPatch = patch;
        return watch;
      },
    };
    const source: OfferSource = {
      async search() {
        sourceCalls += 1;
        return { ok: true, offers: [observedOffer] };
      },
      async getOffer() { return { ok: true, offer: observedOffer }; },
    };

    const result = await checkWatch(watch, {
      store,
      source,
      notifierFor: () => {
        notifierCalls += 1;
        return collectingNotifier([]);
      },
      now: () => new Date("2026-08-16T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      watchId: watch.id,
      outcome: "source_error",
      error: {
        code: "native_revalidation_required",
        message: expect.stringContaining(productUrl),
      },
    });
    expect(sourceCalls).toBe(0);
    expect(notifierCalls).toBe(0);
    expect(persistedPatch?.lastStatus).toMatchObject({
      ok: false,
      error: { code: "native_revalidation_required", message: expect.stringContaining(productUrl) },
    });
  });

  it("expiry auto-completes the watch (state=expired, never checked again, no notification)", async () => {
    const dir = freshWatchDir();
    const watch = createFairphoneWatch(dir);
    const sent: WatchNotification[] = [];
    const afterExpiry = () => new Date("2027-02-01T00:00:00.000Z");
    const run = await runWatchesOnce(deps(dir, sourceWithPrice(100), sent, afterExpiry));
    expect(run.reports[0]).toMatchObject({ watchId: watch.id, outcome: "expired" });
    expect(sent).toEqual([]);
    expect(createWatchStore({ configDir: dir }).get(watch.id)!.state).toBe("expired");

    // Expired watches are not active — the next run does not touch them.
    const next = await runWatchesOnce(deps(dir, sourceWithPrice(100), sent, afterExpiry));
    expect(next.reports).toEqual([]);
  });

  it("re-fetched offers that are the WRONG listing (different store/id) do not count", async () => {
    const dir = freshWatchDir();
    const watch = createFairphoneWatch(dir);
    const sent: WatchNotification[] = [];
    const impostor = sourceWithPrice(100, { id: "different-offer", sourceStore: "ebay" });
    const run = await runWatchesOnce(deps(dir, impostor, sent));
    expect(run.reports[0]).toMatchObject({ watchId: watch.id, outcome: "offer_not_found" });
    expect(sent).toEqual([]);
    expect(createWatchStore({ configDir: dir }).get(watch.id)!.state).toBe("active");
  });

  it("variant constraints: an offer missing a mustHaveAttribute never triggers the watch", async () => {
    const dir = freshWatchDir();
    const store = createWatchStore({ configDir: dir, now: () => new Date("2026-07-05T00:00:00.000Z") });
    store.create({
      name: "256GB only",
      target: { kind: "query", query: { text: "fairphone" } },
      targetPrice: { amount: 60000, currency: "EUR" },
      mustHaveAttributes: ["256GB"],
    });
    const sent: WatchNotification[] = [];
    const run = await runWatchesOnce(deps(dir, sourceWithPrice(100), sent)); // fixture is 128GB
    expect(run.reports[0]).toMatchObject({ outcome: "offer_not_found" });
    expect(sent).toEqual([]);
  });

  it("query watches pick the CHEAPEST currency-matching offer", async () => {
    const dir = freshWatchDir();
    const store = createWatchStore({ configDir: dir, now: () => new Date("2026-07-05T00:00:00.000Z") });
    const watch = store.create({
      name: "any fairphone",
      target: { kind: "query", query: { text: "fairphone" } },
      targetPrice: { amount: 55000, currency: "EUR" },
    });
    const sent: WatchNotification[] = [];
    const multi: OfferSource = {
      async search() {
        return {
          ok: true,
          offers: [
            { ...OFFER, id: "pricey", price: { amount: 59900, currency: "EUR" } },
            { ...OFFER, id: "cheap", price: { amount: 52000, currency: "EUR" } },
            { ...OFFER, id: "wrong-currency", price: { amount: 100, currency: "USD" } },
          ],
        };
      },
      async getOffer() { return { ok: true, offer: OFFER }; },
    };
    const run = await runWatchesOnce(deps(dir, multi, sent));
    expect(run.reports[0]).toMatchObject({ watchId: watch.id, outcome: "target_hit_notified" });
    expect(sent[0]!.currentPrice).toEqual({ amount: 52000, currency: "EUR" });
  });

  it("priceBucket is deterministic and 1%-of-target wide (tiny jitter dedupes, real drops re-notify)", () => {
    const target = { amount: 55000, currency: "EUR" };
    expect(priceBucket({ amount: 54900, currency: "EUR" }, target)).toBe(
      priceBucket({ amount: 54901, currency: "EUR" }, target),
    );
    expect(priceBucket({ amount: 54900, currency: "EUR" }, target)).not.toBe(
      priceBucket({ amount: 49000, currency: "EUR" }, target),
    );
    expect(priceBucket({ amount: 54900, currency: "EUR" }, target)).toMatch(/^EUR:\d+$/);
  });
});
