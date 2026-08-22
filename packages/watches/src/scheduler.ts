/**
 * Scheduler over the watch store: one-shot (`northcinder-watch --once`, cron-able)
 * and a long-running interval loop. No daemon-manager dependency — cron or
 * launchd owns the process lifecycle (snippets in this package's README).
 *
 * Resume is idempotent by construction: every tick reads the persisted
 * watches fresh from disk, and the checker's dedupe ledger (notifiedBuckets)
 * survives restarts.
 */
import { checkWatch, type CheckDeps, type WatchCheckReport } from "./checker.js";

export interface WatchRunSummary {
  checkedAt: string;
  /** Active watches examined this tick. */
  total: number;
  reports: WatchCheckReport[];
}

/** One tick: checks every ACTIVE watch, sequentially (per-host politeness). */
export async function runWatchesOnce(deps: CheckDeps): Promise<WatchRunSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const active = deps.store.list().filter((w) => w.state === "active");
  const reports: WatchCheckReport[] = [];
  const queryCalls = new Map<string, ReturnType<CheckDeps["source"]["search"]>>();
  const offerCalls = new Map<string, ReturnType<CheckDeps["source"]["getOffer"]>>();
  const unexpectedSourceFailure = () => ({
    ok: false as const,
    error: { code: "source_unavailable", message: "watch source failed unexpectedly" },
  });
  const source = {
    search(query: Parameters<CheckDeps["source"]["search"]>[0]) {
      const key = JSON.stringify(query);
      let call = queryCalls.get(key);
      if (call === undefined) {
        call = Promise.resolve().then(() => deps.source.search(query)).catch(unexpectedSourceFailure);
        queryCalls.set(key, call);
      }
      return call;
    },
    getOffer(store: string, offerId: string) {
      const key = JSON.stringify([store, offerId]);
      let call = offerCalls.get(key);
      if (call === undefined) {
        call = Promise.resolve().then(() => deps.source.getOffer(store, offerId)).catch(unexpectedSourceFailure);
        offerCalls.set(key, call);
      }
      return call;
    },
  };
  for (const watch of active) {
    try {
      reports.push(await checkWatch(watch, { ...deps, source }));
    } catch {
      const error = { code: "watch_check_failed", message: "watch check failed unexpectedly" };
      try {
        deps.store.update(watch.id, {
          lastCheckedAt: now.toISOString(),
          lastFailureAt: now.toISOString(),
          lastStatus: { ok: false, error },
        });
      } catch {
        // The same unexpected store failure may make persistence impossible;
        // the generic report still isolates this watch and contains no detail.
      }
      reports.push({ watchId: watch.id, name: watch.name, outcome: "source_error", error });
    }
  }
  return { checkedAt: now.toISOString(), total: active.length, reports };
}

export interface WatchLoopOptions {
  intervalMs: number;
  signal?: AbortSignal;
  onTick?: (summary: WatchRunSummary) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Interval loop: immediate first tick, then every intervalMs until aborted. */
export async function runWatchesLoop(deps: CheckDeps, options: WatchLoopOptions): Promise<void> {
  for (;;) {
    if (options.signal?.aborted) return;
    const summary = await runWatchesOnce(deps);
    options.onTick?.(summary);
    if (options.signal?.aborted) return;
    await sleep(options.intervalMs, options.signal);
  }
}
