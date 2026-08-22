/**
 * Scheduler core for `northcinder-orders` (mirrors `@northcinder/watches`' scheduler
 * shape / `client/src/watch-runner.ts`'s exit-code convention). Before this
 * existed, `runReturnWindowReminders` and `pollImap` were implemented +
 * tested in `@northcinder/orders` but NOTHING ever called them on an interval —
 * dead code from the running app's point of view. One tick does, in order:
 *
 *   1. ingest the local .eml drop directory (idempotent re-scan)
 *   2. poll IMAP if configured (structured `not_configured` skip if not —
 *      never a fake success, same law as the profile/watch gated paths)
 *   3. run return-window reminders over the (now up to date) order graph
 *
 * Exit-code law (same as `northcinder-watch`): `--once` must be VISIBLE to cron/
 * launchd when the tick could not do ANYTHING useful. "Nothing useful" here
 * means every check that was actually ATTEMPTED failed — an IMAP poll that
 * was configured but couldn't connect, or a reminder send that failed.
 * Drop-dir ingest structurally cannot fail (a missing directory is treated
 * as empty, `ingestEml` never throws), and `not_due`/`deduped`/`no_order`
 * reminders are healthy no-ops, not failures — so an empty/quiet tick (the
 * common case: nothing due yet) exits 0, exactly like an all-healthy or
 * no-active-watches `northcinder-watch` tick.
 */
import type { IngestOutcome, ImapPollResult, ImapTransport, LifecycleReminderReport, OrderGraphStore, ReturnReminderReport } from "@northcinder/orders";
import { ingestDropDir, pollImap, runReturnWindowReminders, runScheduledLifecycleReminders, type ReturnReminderTransport } from "@northcinder/orders";
import type { Order } from "@northcinder/protocol";

export interface OrdersTickSummary {
  checkedAt: string;
  dropDir: { scanned: number; outcomes: IngestOutcome[] };
  imap: ImapPollResult;
  reminders: Array<ReturnReminderReport | LifecycleReminderReport>;
}

export interface OrdersTickDeps {
  store: OrderGraphStore;
  /** Absent (or "0"/"false" per config.ts) disables drop-dir ingest entirely. */
  dropDir?: string;
  imapEnv?: Record<string, string | undefined>;
  /** Injectable for tests; defaults to the real socket transport inside pollImap. */
  imapTransport?: ImapTransport;
  orderFor(orderId: string): Order | undefined;
  reminderTransport: ReturnReminderTransport;
  reminderDays: number;
  now?: () => Date;
}

/** One tick: drop-dir ingest → IMAP poll (if configured) → return-window reminders. */
export async function runOrdersTick(deps: OrdersTickDeps): Promise<OrdersTickSummary> {
  const now = (deps.now ?? (() => new Date()))();

  const dropDir = deps.dropDir ? ingestDropDir(deps.dropDir, deps.store) : { scanned: 0, outcomes: [] };

  const imap = await pollImap(deps.store, {
    ...(deps.imapEnv !== undefined ? { env: deps.imapEnv } : {}),
    ...(deps.imapTransport !== undefined ? { transport: deps.imapTransport } : {}),
  });

  const returnReminders = await runReturnWindowReminders({
    store: deps.store,
    orderFor: deps.orderFor,
    transport: deps.reminderTransport,
    reminderDays: deps.reminderDays,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const lifecycleReminders = await runScheduledLifecycleReminders({
    store: deps.store,
    transport: deps.reminderTransport,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const reminders = [...returnReminders, ...lifecycleReminders];

  return { checkedAt: now.toISOString(), dropDir, imap, reminders };
}

/**
 * Exit code for a `--once` tick: 1 when EVERY check that was actually
 * ATTEMPTED failed outright — an IMAP poll that was configured but failed
 * (never `not_configured`, which is a normal, honest skip), or a reminder
 * send that failed (`notify_failed`, never `deduped`/`not_due`/`no_order`,
 * which are healthy no-ops). A tick with nothing attempted (nothing
 * configured, nothing due) is a healthy quiet tick and exits 0.
 */
export function ordersTickExitCode(summary: OrdersTickSummary): 0 | 1 {
  const attempted: boolean[] = [];
  if (!(summary.imap.ok === false && summary.imap.error.code === "not_configured")) {
    attempted.push(summary.imap.ok === true);
  }
  for (const r of summary.reminders) {
    if (r.outcome === "sent" || r.outcome === "notify_failed") attempted.push(r.outcome === "sent");
  }
  if (attempted.length === 0) return 0;
  return attempted.every((ok) => !ok) ? 1 : 0;
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

export interface OrdersLoopOptions {
  intervalMs: number;
  signal?: AbortSignal;
  onTick?: (summary: OrdersTickSummary) => void;
}

/** Interval loop: immediate first tick, then every intervalMs until aborted (same shape as @northcinder/watches' runWatchesLoop). */
export async function runOrdersLoop(deps: OrdersTickDeps, options: OrdersLoopOptions): Promise<void> {
  for (;;) {
    if (options.signal?.aborted) return;
    const summary = await runOrdersTick(deps);
    options.onTick?.(summary);
    if (options.signal?.aborted) return;
    await sleep(options.intervalMs, options.signal);
  }
}
