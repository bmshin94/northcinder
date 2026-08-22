/**
 * Reminder dedupe across restarts (acceptance criterion): two separate runs
 * against the SAME persisted store (simulating two process restarts) send
 * exactly ONE reminder.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NotifyResult, NtfyMessage } from "@northcinder/watches";
import { createOrderGraphStore } from "../src/store.js";
import { composeReturnWindowPush, runReturnWindowReminders, runScheduledLifecycleReminders, type ReturnReminderTransport } from "../src/reminders.js";

function collectingTransport(sent: NtfyMessage[]): ReturnReminderTransport {
  return {
    id: "collect",
    async send(message) {
      sent.push(message);
      return { ok: true } as NotifyResult;
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RAW_ORDER_CONFIRMATION = [
  'From: "Aurora Outfitters" <no-reply@shop-aurora.myshopify.com>',
  "To: buyer@example.com",
  "Subject: Order confirmation #1021 for Buyer Example",
  "Date: Wed, 1 Jul 2026 10:15:00 -0700",
  "Message-ID: <shopify-1021-confirmation@shop-aurora.myshopify.com>",
  "MIME-Version: 1.0",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Order #1021",
  "Placed on July 1, 2026",
  "",
  "1 x Cedar Trail Jacket - $128.00",
  "",
  "Total: $128.00",
  "",
].join("\n");

const RAW_RETURN_WINDOW = [
  'From: "Aurora Outfitters" <no-reply@shop-aurora.myshopify.com>',
  "To: buyer@example.com",
  "Subject: Your return window for order #1021",
  "Date: Sun, 5 Jul 2026 15:30:00 -0700",
  "Message-ID: <shopify-1021-return-window@shop-aurora.myshopify.com>",
  "MIME-Version: 1.0",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Order #1021 -- you can return items until July 8, 2026 (30 days from delivery on July 5, 2026).",
  "",
].join("\n");

describe("return-window reminders", () => {
  it("claims a due return reminder before sending so another store instance does not duplicate a clean concurrent delivery", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-return-claim-"));
    const firstStore = createOrderGraphStore(configDir);
    firstStore.ingestEml(RAW_ORDER_CONFIRMATION, "drop_dir");
    firstStore.ingestEml(RAW_RETURN_WINDOW, "drop_dir");
    const [order] = firstStore.listOrders();
    let release!: () => void;
    let began!: () => void;
    const beganSend = new Promise<void>((resolve) => { began = resolve; });
    const blocked: ReturnReminderTransport = {
      id: "blocked",
      async send() {
        began();
        await new Promise<void>((resolve) => { release = resolve; });
        return { ok: true } as NotifyResult;
      },
    };
    const first = runReturnWindowReminders({
      store: firstStore, orderFor: (id) => firstStore.getOrder(id)?.order, transport: blocked, reminderDays: 3,
      now: () => new Date("2026-07-06T12:00:00.000Z"), claimTiming: { leaseMs: 20, renewEveryMs: 5 },
    });
    await beganSend;
    // Hold A beyond the short test lease. Its renewal must prevent both B and C.
    await wait(35);
    const secondStore = createOrderGraphStore(configDir);
    const later = () => new Date("2026-07-06T12:02:00.000Z");
    const bSent: NtfyMessage[] = [];
    const second = await runReturnWindowReminders({
      store: secondStore, orderFor: (id) => secondStore.getOrder(id)?.order, transport: collectingTransport(bSent), reminderDays: 3,
      now: later, claimTiming: { leaseMs: 20, renewEveryMs: 5 },
    });
    expect(second).toEqual([{ orderId: order!.id, outcome: "in_progress" }]);
    const cSent: NtfyMessage[] = [];
    expect(await runReturnWindowReminders({ store: createOrderGraphStore(configDir), orderFor: (id) => firstStore.getOrder(id)?.order, transport: collectingTransport(cSent), reminderDays: 3, now: later, claimTiming: { leaseMs: 20, renewEveryMs: 5 } })).toEqual([{ orderId: order!.id, outcome: "in_progress" }]);
    expect(bSent).toEqual([]);
    expect(cSent).toEqual([]);
    release();
    expect(await first).toEqual([{ orderId: order!.id, outcome: "sent" }]);
  });
  it("a return window with no order match is skipped (no_order), never a crash", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-orders-reminders-"));
    const store = createOrderGraphStore(configDir);
    store.ingestEml(RAW_RETURN_WINDOW, "drop_dir"); // return window arrives with NO matching order confirmation ingested
    const sent: NtfyMessage[] = [];
    const report = await runReturnWindowReminders({
      store,
      orderFor: () => undefined,
      transport: collectingTransport(sent),
      reminderDays: 3,
      now: () => new Date("2026-07-06T00:00:00.000Z"),
    });
    expect(report).toEqual([{ orderId: "order_email_shop_aurora_myshopify_com_1021", outcome: "no_order" }]);
    expect(sent).toHaveLength(0);
  });

  it("dedupes across restarts: run 1 sends, run 2 (fresh store instance, same configDir) is a no-op", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-orders-reminders-"));

    const store1 = createOrderGraphStore(configDir);
    store1.ingestEml(RAW_ORDER_CONFIRMATION, "drop_dir");
    store1.ingestEml(RAW_RETURN_WINDOW, "drop_dir");
    const [order] = store1.listOrders();
    expect(order?.orderNumber).toBe("1021");

    const now = () => new Date("2026-07-06T00:00:00.000Z"); // deadline is 2026-07-08 → 2 days out, within reminderDays=3
    const sent: NtfyMessage[] = [];

    const run1 = await runReturnWindowReminders({
      store: store1,
      orderFor: (id) => store1.getOrder(id)?.order,
      transport: collectingTransport(sent),
      reminderDays: 3,
      now,
    });
    expect(run1).toEqual([{ orderId: order!.id, outcome: "sent" }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toContain("1021");

    // Simulate a restart: a FRESH store instance over the SAME configDir/file.
    const store2 = createOrderGraphStore(configDir);
    const run2 = await runReturnWindowReminders({
      store: store2,
      orderFor: (id) => store2.getOrder(id)?.order,
      transport: collectingTransport(sent),
      reminderDays: 3,
      now,
    });
    expect(run2).toEqual([{ orderId: order!.id, outcome: "deduped" }]);
    expect(sent).toHaveLength(1); // still just the one reminder across both runs
  });

  it("composeReturnWindowPush never claims northcinder files a return itself", () => {
    const order = {
      id: "order_x",
      orderNumber: "1021",
      merchantName: "Aurora Outfitters",
      orderDate: "2026-07-01T00:00:00.000Z",
      items: [],
      status: "delivered" as const,
      source: { kind: "import" as const },
    };
    const returnWindow = { orderId: "order_x", deadline: "2026-08-04", basis: "stated_deadline" as const };
    const msg = composeReturnWindowPush(order, returnWindow);
    expect(msg.body).toContain("never files a return for you");
    expect(msg.title).toBe("northcinder: return window closing soon for order 1021");
  });
});

describe("scheduled lifecycle reminders", () => {
  it("uses the Phoenix buyer-local date, not UTC, at the evening boundary", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-lifecycle-local-date-"));
    const store = createOrderGraphStore(configDir);
    const order = store.importOrder({ merchantName: "Aurora", orderDate: "2026-07-01T00:00:00.000Z" });
    const reminder = store.scheduleLifecycleReminder(order.id, { kind: "warranty", remindOn: "2026-08-01", dueOn: "2026-08-31", detail: "Register it." });
    const sent: NtfyMessage[] = [];
    // 2026-08-01T01:30Z is still 2026-07-31 18:30 in America/Phoenix.
    expect(await runScheduledLifecycleReminders({ store, transport: collectingTransport(sent), now: () => new Date("2026-08-01T01:30:00.000Z") })).toEqual([
      { kind: "warranty", reminderId: reminder.id, orderId: order.id, outcome: "not_due" },
    ]);
    expect(sent).toEqual([]);
  });

  it("renews a lifecycle owner lease during a slow send and rejects stale owner cleanup", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-lifecycle-claim-"));
    const firstStore = createOrderGraphStore(configDir);
    const order = firstStore.importOrder({ merchantName: "Aurora", orderDate: "2026-07-01T00:00:00.000Z" });
    const reminder = firstStore.scheduleLifecycleReminder(order.id, { kind: "maintenance", remindOn: "2026-08-01", dueOn: "2026-08-31", detail: "Clean it." });
    let release!: () => void;
    let began!: () => void;
    const beganSend = new Promise<void>((resolve) => { began = resolve; });
    const blocked: ReturnReminderTransport = { id: "blocked", async send() { began(); await new Promise<void>((resolve) => { release = resolve; }); return { ok: true } as NotifyResult; } };
    const first = runScheduledLifecycleReminders({ store: firstStore, transport: blocked, now: () => new Date("2026-08-10T12:00:00.000Z"), claimTiming: { leaseMs: 20, renewEveryMs: 5 } });
    await beganSend;
    await wait(35);
    const secondStore = createOrderGraphStore(configDir);
    const later = () => new Date("2026-08-10T12:02:00.000Z");
    const bSent: NtfyMessage[] = [];
    expect(await runScheduledLifecycleReminders({ store: secondStore, transport: collectingTransport(bSent), now: later, claimTiming: { leaseMs: 20, renewEveryMs: 5 } })).toEqual([
      { kind: "maintenance", reminderId: reminder.id, orderId: order.id, outcome: "in_progress" },
    ]);
    const cSent: NtfyMessage[] = [];
    expect(await runScheduledLifecycleReminders({ store: createOrderGraphStore(configDir), transport: collectingTransport(cSent), now: later, claimTiming: { leaseMs: 20, renewEveryMs: 5 } })).toEqual([{ kind: "maintenance", reminderId: reminder.id, orderId: order.id, outcome: "in_progress" }]);
    expect(bSent).toEqual([]);
    expect(cSent).toEqual([]);
    release();
    await first;

    const failed = secondStore.scheduleLifecycleReminder(order.id, { kind: "warranty", remindOn: "2026-08-01", dueOn: "2026-08-31", detail: "Register it." });
    const failing: ReturnReminderTransport = { id: "fail", async send() { return { ok: false, error: "down" } as never; } };
    expect(await runScheduledLifecycleReminders({ store: secondStore, transport: failing, now: later, claimTiming: { leaseMs: 20, renewEveryMs: 5 } })).toContainEqual({ kind: "warranty", reminderId: failed.id, orderId: order.id, outcome: "notify_failed" });
    expect(await runScheduledLifecycleReminders({ store: secondStore, transport: collectingTransport(cSent), now: later, claimTiming: { leaseMs: 20, renewEveryMs: 5 } })).toContainEqual({ kind: "warranty", reminderId: failed.id, orderId: order.id, outcome: "sent" });
  });

  it("does not let a stale owner release or complete a newer claimant, while an unrenewed crashed lease is reclaimable", () => {
    const store = createOrderGraphStore(mkdtempSync(join(tmpdir(), "northcinder-reminder-owner-")));
    const order = store.importOrder({ merchantName: "Aurora", orderDate: "2026-07-01T00:00:00.000Z" });
    const lifecycle = store.scheduleLifecycleReminder(order.id, { kind: "warranty", remindOn: "2026-08-01", dueOn: "2026-08-31", detail: "Register it." });
    const first = store.tryClaimLifecycleReminder(lifecycle.id, new Date("2026-08-10T12:00:00.000Z"), 10);
    expect(first).toMatchObject({ state: "claimed", token: expect.any(String) });
    const second = store.tryClaimLifecycleReminder(lifecycle.id, new Date("2026-08-10T12:00:00.020Z"), 10);
    expect(second).toMatchObject({ state: "claimed", token: expect.any(String) });
    expect(store.releaseLifecycleReminderClaim(lifecycle.id, (first as { token: string }).token)).toBe(false);
    expect(store.markLifecycleReminderSent(lifecycle.id, "2026-08-10T12:00:00.021Z", (first as { token: string }).token)).toBeUndefined();
    expect(store.tryClaimLifecycleReminder(lifecycle.id, new Date("2026-08-10T12:00:00.021Z"), 10)).toMatchObject({ state: "in_progress" });

    const returnOrder = store.importOrder({ merchantName: "Return Shop", orderDate: "2026-08-01T00:00:00.000Z" });
    // A direct, unrenewed claim models a process that crashed before its transport returned.
    const crashed = store.tryClaimReturnReminder(returnOrder.id, new Date("2026-08-10T12:00:00.000Z"), 10);
    expect(crashed).toMatchObject({ state: "claimed" });
    expect(store.tryClaimReturnReminder(returnOrder.id, new Date("2026-08-10T12:00:00.020Z"), 10)).toMatchObject({ state: "claimed", token: expect.any(String) });
  });
  it("sends only within the explicit lifecycle window, persists successful delivery, and leaves failed delivery eligible", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-lifecycle-reminders-"));
    const store = createOrderGraphStore(configDir);
    const order = store.importOrder({ merchantName: "Aurora", orderDate: "2026-07-01T00:00:00.000Z" });
    const reminder = store.scheduleLifecycleReminder(order.id, {
      kind: "warranty", remindOn: "2026-08-01", dueOn: "2026-08-31", detail: "Register the warranty.",
    });
    const sent: NtfyMessage[] = [];

    expect(await runScheduledLifecycleReminders({ store, transport: collectingTransport(sent), now: () => new Date("2026-07-31T12:00:00.000Z") })).toEqual([
      { kind: "warranty", reminderId: reminder.id, orderId: order.id, outcome: "not_due" },
    ]);
    expect(await runScheduledLifecycleReminders({ store, transport: collectingTransport(sent), now: () => new Date("2026-08-10T12:00:00.000Z") })).toEqual([
      { kind: "warranty", reminderId: reminder.id, orderId: order.id, outcome: "sent" },
    ]);
    expect(sent).toHaveLength(1);
    expect(await runScheduledLifecycleReminders({ store: createOrderGraphStore(configDir), transport: collectingTransport(sent), now: () => new Date("2026-08-10T12:00:00.000Z") })).toEqual([
      { kind: "warranty", reminderId: reminder.id, orderId: order.id, outcome: "deduped" },
    ]);

    const failed = store.scheduleLifecycleReminder(order.id, {
      kind: "maintenance", remindOn: "2026-08-01", dueOn: "2026-08-31", detail: "Clean the filter.",
    });
    const failing: ReturnReminderTransport = { id: "fail", async send() { return { ok: false, error: "down" } as never; } };
    expect(await runScheduledLifecycleReminders({ store, transport: failing, now: () => new Date("2026-08-10T12:00:00.000Z") })).toContainEqual(
      { kind: "maintenance", reminderId: failed.id, orderId: order.id, outcome: "notify_failed" },
    );
    expect(store.listLifecycleReminders().find((item) => item.id === failed.id)?.reminderSentAt).toBeUndefined();
    expect(await runScheduledLifecycleReminders({ store, transport: collectingTransport(sent), now: () => new Date("2026-09-01T12:00:00.000Z") })).toContainEqual(
      { kind: "maintenance", reminderId: failed.id, orderId: order.id, outcome: "not_due" },
    );
  });
});
