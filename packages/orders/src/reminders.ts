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
import type { Order, ReturnWindow } from "@northcinder/protocol";
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
}

export interface ReturnReminderReport {
  orderId: string;
  outcome: "sent" | "deduped" | "not_due" | "no_order" | "notify_failed";
}

function daysUntil(deadline: string, now: Date): number {
  const deadlineMs = new Date(`${deadline}T23:59:59Z`).getTime();
  return (deadlineMs - now.getTime()) / (24 * 60 * 60 * 1000);
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

/** One pass over every persisted return window; crash-safe/idempotent — safe to call every scheduler tick. */
export async function runReturnWindowReminders(deps: ReturnReminderDeps): Promise<ReturnReminderReport[]> {
  const now = (deps.now ?? (() => new Date()))();
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
    const sent = await deps.transport.send(composeReturnWindowPush(order, returnWindow));
    if (!sent.ok) {
      reports.push({ orderId: returnWindow.orderId, outcome: "notify_failed" });
      continue;
    }
    deps.store.markReminderSent(returnWindow.orderId, now.toISOString());
    reports.push({ orderId: returnWindow.orderId, outcome: "sent" });
  }
  return reports;
}
