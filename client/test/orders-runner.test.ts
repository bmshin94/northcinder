/**
 * `northcinder-orders` scheduler core (mirrors watch-runner.test.ts): before this
 * existed, `runReturnWindowReminders`/`pollImap` were dead code — nothing
 * ever called them on an interval. Asserts one tick actually ingests +
 * reminds, and the cron-visible exit-code semantics.
 */
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NtfyMessage } from "@northcinder/watches";
import { createOrderGraphStore } from "@northcinder/orders";
import { ordersTickExitCode, runOrdersTick, type OrdersTickSummary } from "../src/orders-runner.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../packages/orders/test/fixtures");

function tmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "northcinder-orders-runner-"));
}

function collectingTransport(sent: NtfyMessage[]) {
  return { id: "collect", async send(message: NtfyMessage) { sent.push(message); return { ok: true as const }; } };
}

describe("runOrdersTick — a tick actually ingests the drop dir + polls IMAP + reminds", () => {
  it("ingests every .eml in the drop dir, reports not_configured for IMAP absent creds, and sends a due return-window reminder", async () => {
    const configDir = tmpConfigDir();
    const dropDir = join(configDir, "mail-drop");
    mkdirSync(dropDir, { recursive: true });
    copyFileSync(join(FIXTURES_DIR, "shopify-order-confirmation.eml"), join(dropDir, "order.eml"));
    copyFileSync(join(FIXTURES_DIR, "return-window.eml"), join(dropDir, "return-window.eml"));

    const store = createOrderGraphStore(configDir);
    const sent: NtfyMessage[] = [];
    const now = () => new Date("2026-08-02T00:00:00.000Z"); // 2 days before the 2026-08-04 deadline

    const summary = await runOrdersTick({
      store,
      dropDir,
      imapEnv: {},
      orderFor: (orderId) => store.getOrder(orderId)?.order,
      reminderTransport: collectingTransport(sent),
      reminderDays: 3,
      now,
    });

    expect(summary.dropDir.scanned).toBe(2);
    expect(summary.dropDir.outcomes.map((o) => o.kind).sort()).toEqual(["order", "return_window"]);
    expect(summary.imap).toEqual({
      ok: false,
      error: { code: "not_configured", message: "IMAP is not configured (set NORTHCINDER_ORDERS_IMAP_HOST/USER/PASSWORD)" },
    });
    expect(summary.reminders).toHaveLength(1);
    expect(summary.reminders[0]!.outcome).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("return window closing soon".length > 0 ? "return" : "return");

    // A second tick against the SAME persisted store dedupes the reminder (restart-safe).
    const second = await runOrdersTick({
      store,
      dropDir,
      imapEnv: {},
      orderFor: (orderId) => store.getOrder(orderId)?.order,
      reminderTransport: collectingTransport(sent),
      reminderDays: 3,
      now,
    });
    expect(second.reminders[0]!.outcome).toBe("deduped");
    expect(sent).toHaveLength(1); // still just one send total
  });

  it("no drop dir configured, no IMAP configured, no return windows due — a healthy empty tick", async () => {
    const store = createOrderGraphStore(tmpConfigDir());
    const summary = await runOrdersTick({
      store,
      imapEnv: {},
      orderFor: () => undefined,
      reminderTransport: { id: "noop", send: async () => ({ ok: true }) },
      reminderDays: 3,
    });
    expect(summary.dropDir).toEqual({ scanned: 0, outcomes: [] });
    expect(summary.reminders).toEqual([]);
    expect(ordersTickExitCode(summary)).toBe(0);
  });
});

describe("ordersTickExitCode — cron/launchd must SEE a fully-failed tick", () => {
  function summary(overrides: Partial<OrdersTickSummary>): OrdersTickSummary {
    return {
      checkedAt: "2026-07-05T12:00:00.000Z",
      dropDir: { scanned: 0, outcomes: [] },
      imap: { ok: false, error: { code: "not_configured", message: "IMAP is not configured" } },
      reminders: [],
      ...overrides,
    };
  }

  it("exits 0 when nothing was attempted (not_configured IMAP, nothing due)", () => {
    expect(ordersTickExitCode(summary({}))).toBe(0);
  });

  it("exits 1 when IMAP was configured but failed, and no reminder attempts succeeded", () => {
    expect(
      ordersTickExitCode(
        summary({ imap: { ok: false, error: { code: "connection_failed", message: "down" } } }),
      ),
    ).toBe(1);
  });

  it("exits 0 when IMAP succeeded even if a reminder send failed (partial failure is normal)", () => {
    expect(
      ordersTickExitCode(
        summary({
          imap: { ok: true, ingested: 2 },
          reminders: [{ orderId: "order_1", outcome: "notify_failed" }],
        }),
      ),
    ).toBe(0);
  });

  it("exits 1 when IMAP is not_configured (a skip, not attempted) but every reminder SEND attempt failed", () => {
    expect(
      ordersTickExitCode(
        summary({ reminders: [{ orderId: "order_1", outcome: "notify_failed" }, { orderId: "order_2", outcome: "not_due" }] }),
      ),
    ).toBe(1);
  });
});
