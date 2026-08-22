import { describe, expect, it } from "vitest";
import { LifecycleReminderInputSchema, LifecycleReminderSchema, PurchaseOutcomeInputSchema, PurchaseOutcomeSchema } from "../src/index.js";

describe("purchase outcomes and lifecycle reminders", () => {
  it("accepts complete buyer-confirmed outcomes and lifecycle reminders", () => {
    expect(PurchaseOutcomeInputSchema.parse({
      orderId: "order_123",
      state: "returned",
      fitOrCompatibility: "did_not_fit",
      predictionError: "fit",
      merchantDelivery: "late",
      merchantSupport: "helpful",
      wouldChooseAgain: false,
    })).toMatchObject({ state: "returned", wouldChooseAgain: false });
    expect(PurchaseOutcomeSchema.parse({ orderId: "order_123", state: "kept", recordedAt: "2026-08-21T12:00:00.000Z" }).recordedAt).toBe(
      "2026-08-21T12:00:00.000Z",
    );
    expect(LifecycleReminderSchema.parse({
      id: "reminder_123",
      orderId: "order_123",
      kind: "warranty",
      dueOn: "2027-08-21",
      remindOn: "2027-08-01",
      detail: "Register the warranty before it expires.",
      createdAt: "2026-08-21T12:00:00.000Z",
    }).id).toBe("reminder_123");
  });

  it("rejects an inverted lifecycle reminder date", () => {
    expect(LifecycleReminderInputSchema.safeParse({
      kind: "maintenance",
      dueOn: "2026-08-21",
      remindOn: "2026-08-22",
      detail: "Replace the filter.",
    }).success).toBe(false);
  });
});
