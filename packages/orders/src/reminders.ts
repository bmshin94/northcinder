/**
 * Return-window reminders: N days before the deadline, PUSHED via the SAME
 * low-level `publishNtfy` transport watch/local UI already share (safety contract law: reuse the
 * notification path, never re-implement it — see @northcinder/watches/notify.ts
 * and the local UI approval push in client/src/main.ts, commit 63a8639).
 *
 * Design decision (recorded for the closing ADRs): this reuses `publishNtfy`
 * directly rather than the full `Notifier`/`formatNotification` path. That
 * path's `formatNotification` hardcodes watch-flavored copy ("price watch
 * ... hit its target") for `WatchNotification`'s price-hit shape; stuffing a
 * return-window reminder into that shape would send text that is factually
 * wrong (there is no price, no target). local UI hit the same mismatch for
 * approval pushes and solved it the same way: compose the message text
 * ourselves, send it over the shared low-level `publishNtfy`/`NtfyMessage`
 * primitive. `NotifyResult` (ok/error shape) is reused unchanged.
 *
 * Dedupe persists on the ReturnWindow record itself (`reminderSentAt`, set
 * via `OrderGraphStore.markReminderSent`) — exactly the watches pattern of
 * marking the dedupe key AFTER a successful send: a crash between send and
 * persist re-notifies (at-least-once), but two clean runs never double up
 * (the acceptance test: two runs, one reminder).
 */
import { publishNtfy, type NotifyResult, type NtfyMessage, type NtfyNotifierOptions } from "@northcinder/watches";
import type { LifecycleReminder, Order, ReturnWindow } from "@northcinder/protocol";
import { BRAND_NAME } from "./brand.js";
import type { OrderGraphStore } from "./store.js";

/** Minimal transport: id + send(NtfyMessage) — the same "id + send" minimalism as watches' Notifier. */
export interface ReturnReminderTransport {
  readonly id: string;
  send(message: NtfyMessage): Promise<NotifyResult>;
}

/** Real push channel: reuses publishNtfy directly (no re-implementation). */
export function createNtfyReturnReminderTransport(options: NtfyNotifierOptions): ReturnReminderTransport {
  return { id: "ntfy", send: (message) => publishNtfy(options, message) };
}

/** Console fallback: always available, no configuration needed. */
export function createStderrReturnReminderTransport(write?: (s: string) => void): ReturnReminderTransport {
  const sink = write ?? ((s: string) => process.stderr.write(s));
  return {
    id: "stderr",
    async send(message) {
      sink(`\n[${BRAND_NAME}-orders] ${message.title}\n${message.body}\n`);
      return { ok: true };
    },
  };
}

export interface ReturnReminderDeps {
  store: OrderGraphStore;
  /** Resolves the Order for a return window's orderId (checkout orders included by the caller if relevant). */
  orderFor(orderId: string): Order | undefined;
  transport: ReturnReminderTransport;
  /** Days before the deadline a reminder should fire. */
  reminderDays: number;
  now?: () => Date;
  claimTiming?: ReminderClaimTiming;
}

export interface ReturnReminderReport {
  orderId: string;
  outcome: "sent" | "deduped" | "in_progress" | "claim_lost" | "not_due" | "no_order" | "notify_failed";
}

/** Bounded lifecycle report; this scheduler never performs the referenced action. */
export interface LifecycleReminderReport {
  kind: LifecycleReminder["kind"];
  reminderId: string;
  orderId: string;
  outcome: "sent" | "deduped" | "in_progress" | "claim_lost" | "not_due" | "notify_failed";
}

/** The default lease exceeds the shared ntfy transport's 10-second bounded send timeout. */
const REMINDER_CLAIM_LEASE_MS = 30_000;
const REMINDER_CLAIM_RENEW_MS = 10_000;

export interface ReminderClaimTiming {
  leaseMs?: number;
  renewEveryMs?: number;
}

function claimTiming(timing: ReminderClaimTiming | undefined): { leaseMs: number; renewEveryMs: number } {
  const leaseMs = timing?.leaseMs ?? REMINDER_CLAIM_LEASE_MS;
  const requestedRenewal = timing?.renewEveryMs ?? REMINDER_CLAIM_RENEW_MS;
  return { leaseMs, renewEveryMs: Math.max(1, Math.min(requestedRenewal, Math.max(1, Math.floor(leaseMs / 2)))) };
}

function startLeaseRenewal(
  renew: (now: Date) => boolean,
  timing: { leaseMs: number; renewEveryMs: number },
): () => void {
  const timer = setInterval(() => {
    try {
      renew(new Date());
    } catch {
      // A transient lock collision cannot clear the owner's persisted claim;
      // the next bounded renewal attempt may still extend it.
    }
  }, timing.renewEveryMs);
  return () => clearInterval(timer);
}

/** Calendar date in the buyer process timezone; lifecycle dates are not UTC instants. */
function localCalendarDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function daysUntil(deadline: string, now: Date): number {
  return (Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${localCalendarDate(now)}T00:00:00Z`)) / (24 * 60 * 60 * 1000);
}

export function composeReturnWindowPush(order: Order, returnWindow: ReturnWindow): NtfyMessage {
  const label = order.orderNumber ?? order.id;
  return {
    title: `${BRAND_NAME}: return window closing soon for order ${label}`,
    body:
      `Your order ${label} at ${order.merchantName} can be returned until ${returnWindow.deadline}. ` +
      `This is an informational reminder only — ${BRAND_NAME} never files a return for you.`,
    tags: "calendar",
    priority: "default",
  };
}

export function composeLifecycleReminderPush(reminder: LifecycleReminder): NtfyMessage {
  return {
    title: `${BRAND_NAME}: ${reminder.kind} reminder for order ${reminder.orderId}`,
    body:
      `${reminder.detail} Due ${reminder.dueOn}. ` +
      `This is an informational reminder only — ${BRAND_NAME} never files a warranty claim, performs maintenance, or buys anything for you.`,
    tags: "calendar",
    priority: "default",
  };
}

/** One pass over every persisted return window; clean reruns dedupe, while a crash after an external send remains honestly at-least-once. */
export async function runReturnWindowReminders(deps: ReturnReminderDeps): Promise<ReturnReminderReport[]> {
  const now = (deps.now ?? (() => new Date()))();
  const lease = claimTiming(deps.claimTiming);
  const reports: ReturnReminderReport[] = [];
  for (const returnWindow of deps.store.listReturnWindows()) {
    if (returnWindow.reminderSentAt !== undefined) {
      reports.push({ orderId: returnWindow.orderId, outcome: "deduped" });
      continue;
    }
    const remaining = daysUntil(returnWindow.deadline, now);
    if (remaining > deps.reminderDays || remaining < 0) {
      reports.push({ orderId: returnWindow.orderId, outcome: "not_due" });
      continue;
    }
    const order = deps.orderFor(returnWindow.orderId);
    if (!order) {
      reports.push({ orderId: returnWindow.orderId, outcome: "no_order" });
      continue;
    }
    const claim = deps.store.tryClaimReturnReminder(returnWindow.orderId, new Date(), lease.leaseMs);
    if (claim.state !== "claimed") {
      reports.push({ orderId: returnWindow.orderId, outcome: claim.state === "sent" ? "deduped" : "in_progress" });
      continue;
    }
    const stopRenewal = startLeaseRenewal(
      (at) => deps.store.renewReturnReminderClaim(returnWindow.orderId, claim.token, at, lease.leaseMs),
      lease,
    );
    try {
      const sent = await deps.transport.send(composeReturnWindowPush(order, returnWindow));
      if (!sent.ok) {
        deps.store.releaseReturnReminderClaim(returnWindow.orderId, claim.token);
        reports.push({ orderId: returnWindow.orderId, outcome: "notify_failed" });
        continue;
      }
      const marked = deps.store.markReminderSent(returnWindow.orderId, new Date().toISOString(), claim.token);
      reports.push({ orderId: returnWindow.orderId, outcome: marked ? "sent" : "claim_lost" });
    } finally {
      stopRenewal();
    }
  }
  return reports;
}

/** Sends explicit buyer-local warranty/maintenance reminders only during their stated date window. */
export async function runScheduledLifecycleReminders(deps: {
  store: OrderGraphStore;
  transport: ReturnReminderTransport;
  now?: () => Date;
  claimTiming?: ReminderClaimTiming;
}): Promise<LifecycleReminderReport[]> {
  const now = (deps.now ?? (() => new Date()))();
  const lease = claimTiming(deps.claimTiming);
  const today = localCalendarDate(now);
  const reports: LifecycleReminderReport[] = [];
  for (const reminder of deps.store.listLifecycleReminders()) {
    const report = { kind: reminder.kind, reminderId: reminder.id, orderId: reminder.orderId };
    if (reminder.reminderSentAt !== undefined) {
      reports.push({ ...report, outcome: "deduped" });
      continue;
    }
    if (today < reminder.remindOn || today > reminder.dueOn) {
      reports.push({ ...report, outcome: "not_due" });
      continue;
    }
    const claim = deps.store.tryClaimLifecycleReminder(reminder.id, new Date(), lease.leaseMs);
    if (claim.state !== "claimed") {
      reports.push({ ...report, outcome: claim.state === "sent" ? "deduped" : "in_progress" });
      continue;
    }
    const stopRenewal = startLeaseRenewal(
      (at) => deps.store.renewLifecycleReminderClaim(reminder.id, claim.token, at, lease.leaseMs),
      lease,
    );
    try {
      const sent = await deps.transport.send(composeLifecycleReminderPush(reminder));
      if (!sent.ok) {
        deps.store.releaseLifecycleReminderClaim(reminder.id, claim.token);
        reports.push({ ...report, outcome: "notify_failed" });
        continue;
      }
      const marked = deps.store.markLifecycleReminderSent(reminder.id, new Date().toISOString(), claim.token);
      reports.push({ ...report, outcome: marked ? "sent" : "claim_lost" });
    } finally {
      stopRenewal();
    }
  }
  return reports;
}
