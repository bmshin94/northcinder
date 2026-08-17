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
  for (const watch of active) {
    reports.push(await checkWatch(watch, deps));
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
