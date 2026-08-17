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
import { composeReturnWindowPush, runReturnWindowReminders, type ReturnReminderTransport } from "../src/reminders.js";

function collectingTransport(sent: NtfyMessage[]): ReturnReminderTransport {
  return {
    id: "collect",
    async send(message) {
      sent.push(message);
      return { ok: true } as NotifyResult;
    },
  };
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
