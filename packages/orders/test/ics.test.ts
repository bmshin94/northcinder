import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Order, ReturnWindow } from "@northcinder/protocol";
import { generateReturnWindowIcs, validateIcs, writeReturnWindowIcsFile } from "../src/ics.js";

const ORDER: Order = {
  id: "order_email_shop_aurora_myshopify_com_1021",
  orderNumber: "1021",
  merchantName: "Aurora Outfitters",
  merchantDomain: "shop-aurora.myshopify.com",
  orderDate: "2026-07-01T17:15:00.000Z",
  items: [],
  status: "delivered",
  source: { kind: "email", messageId: "m1", parser: "shopify-order-confirmation" },
};

const RETURN_WINDOW: ReturnWindow = {
  orderId: ORDER.id,
  deadline: "2026-08-04",
  policyDays: 30,
  basis: "stated_deadline",
};

describe("ICS export — return-window deadline", () => {
  it("generates a well-formed VCALENDAR/VEVENT with the EXACT computed deadline", () => {
    const ics = generateReturnWindowIcs(ORDER, RETURN_WINDOW, { now: () => new Date("2026-07-06T00:00:00.000Z") });
    const validation = validateIcs(ics);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.dtstart).toBe("2026-08-04");
    expect(ics).toContain("SUMMARY:Return window closes for order 1021 (Aurora Outfitters)");
    expect(ics).toContain(`UID:${ORDER.id}-return@northcinder`);
  });

  it("escapes a bare CR (not just CRLF/LF) in text fields so a stray \\r cannot break the ICS structure", () => {
    const order: Order = { ...ORDER, merchantName: "Aurora\rOutfitters" };
    const ics = generateReturnWindowIcs(order, RETURN_WINDOW, { now: () => new Date("2026-07-06T00:00:00.000Z") });
    expect(ics).not.toMatch(/[^\\]\r(?!\n)/); // no lone, unescaped \r inside a content line
    const validation = validateIcs(ics);
    expect(validation.valid).toBe(true);
  });

  it("flags a malformed ICS (missing END:VEVENT) as invalid", () => {
    const broken = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//northcinder//order-graph//EN\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTAMP:20260706T000000Z\r\nDTSTART;VALUE=DATE:20260804\r\nSUMMARY:x\r\nEND:VCALENDAR\r\n";
    const validation = validateIcs(broken);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("missing/unbalanced BEGIN:VEVENT / END:VEVENT");
  });

  it("writes the ICS to <configDir>/returns/<orderId>.ics, 0600", () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-orders-ics-"));
    const ics = generateReturnWindowIcs(ORDER, RETURN_WINDOW);
    const path = writeReturnWindowIcsFile(configDir, ORDER.id, ics);
    expect(path).toBe(join(configDir, "returns", `${ORDER.id}.ics`));
    expect(readFileSync(path, "utf8")).toBe(ics);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
