/**
 * ICS (RFC 5545) export for a return-window deadline: one all-day VEVENT the
 * user can drop into any calendar app. Generation and validation are both
 * pure/deterministic — no external calendar library needed for this single
 * event shape.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Order, ReturnWindow } from "@northcinder/protocol";
import { BRAND_NAME } from "./brand.js";

function toIcsDate(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

function addOneDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function toIcsTimestamp(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\r\n|\r|\n/g, "\\n"); // CRLF, bare CR, and LF all fold to the RFC 5545 escaped newline
}

export interface GenerateIcsOptions {
  now?: () => Date;
}

/** Generates a single-VEVENT VCALENDAR marking when an order's return window closes. */
export function generateReturnWindowIcs(order: Order, returnWindow: ReturnWindow, options: GenerateIcsOptions = {}): string {
  const now = (options.now ?? (() => new Date()))();
  const label = order.orderNumber ?? order.id;
  const summary = escapeIcsText(`Return window closes for order ${label} (${order.merchantName})`);
  const description = escapeIcsText(
    `Your return window for order ${label} at ${order.merchantName} closes on ${returnWindow.deadline}.` +
      (returnWindow.policyDays !== undefined ? ` (${returnWindow.policyDays}-day policy)` : ""),
  );
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${BRAND_NAME}//order-graph//EN`,
    "BEGIN:VEVENT",
    `UID:${returnWindow.orderId}-return@${BRAND_NAME}`,
    `DTSTAMP:${toIcsTimestamp(now)}`,
    `DTSTART;VALUE=DATE:${toIcsDate(returnWindow.deadline)}`,
    `DTEND;VALUE=DATE:${toIcsDate(addOneDay(returnWindow.deadline))}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.join("\r\n")}\r\n`;
}

export interface IcsValidation {
  valid: boolean;
  errors: string[];
  /** The exact deadline (ISO date) extracted from DTSTART, when valid. */
  dtstart?: string;
}

/** Structural well-formedness check: matched BEGIN/END, required properties present, values parseable. */
export function validateIcs(ics: string): IcsValidation {
  const errors: string[] = [];
  const lines = ics.split(/\r\n/).filter((l) => l.length > 0);
  if (lines[0] !== "BEGIN:VCALENDAR") errors.push("missing BEGIN:VCALENDAR as first line");
  if (lines[lines.length - 1] !== "END:VCALENDAR") errors.push("missing END:VCALENDAR as last line");
  const veventStart = lines.indexOf("BEGIN:VEVENT");
  const veventEnd = lines.indexOf("END:VEVENT");
  if (veventStart === -1 || veventEnd === -1 || veventEnd < veventStart) errors.push("missing/unbalanced BEGIN:VEVENT / END:VEVENT");
  for (const required of ["VERSION:", "PRODID:"]) {
    if (!lines.some((l) => l.startsWith(required))) errors.push(`missing required property ${required}`);
  }
  const veventLines = veventStart !== -1 && veventEnd !== -1 ? lines.slice(veventStart, veventEnd + 1) : [];
  for (const required of ["UID:", "DTSTAMP:", "DTSTART", "SUMMARY:"]) {
    if (!veventLines.some((l) => l.startsWith(required))) errors.push(`VEVENT missing required property ${required}`);
  }
  const dtstartLine = veventLines.find((l) => l.startsWith("DTSTART"));
  let dtstart: string | undefined;
  if (dtstartLine) {
    const m = /(\d{8})$/.exec(dtstartLine);
    if (!m) errors.push("DTSTART value is not a parseable DATE (YYYYMMDD)");
    else dtstart = `${m[1]!.slice(0, 4)}-${m[1]!.slice(4, 6)}-${m[1]!.slice(6, 8)}`;
  }
  return { valid: errors.length === 0, errors, ...(dtstart !== undefined ? { dtstart } : {}) };
}

/** Writes the ICS to <configDir>/returns/<orderId>.ics (0600) — the dashboard download path reads this file. */
export function writeReturnWindowIcsFile(configDir: string, orderId: string, ics: string): string {
  const dir = join(configDir, "returns");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${orderId}.ics`);
  const existed = existsSync(path);
  writeFileSync(path, ics, { mode: 0o600 });
  if (!existed) chmodSync(path, 0o600);
  return path;
}
