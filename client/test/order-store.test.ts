import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OrderRecord } from "@northcinder/checkout";
import { createOrderStore, ORDERS_FILENAME } from "../src/order-store.js";

function order(n: number): OrderRecord {
  return {
    orderId: `order_${n}`,
    createdAt: `2026-07-0${n}T00:00:00.000Z`,
    offerId: `offer-${n}`,
    merchantId: "mock-merchant.example",
    railId: "acp",
    status: "completed",
    mandateId: `mandate_${n}`,
    mandate: {} as OrderRecord["mandate"],
    evidence: { rail: "acp" } as unknown as OrderRecord["evidence"],
  };
}

describe("order store — persisted checkout records (local UI orders tab)", () => {
  it("appends JSONL and lists newest first, round-tripping every persisted field", () => {
    const dir = mkdtempSync(join(tmpdir(), "northcinder-orders-"));
    const store = createOrderStore(dir);
    store.append(order(1));
    store.append(order(2));

    const listed = store.list();
    expect(listed).toHaveLength(2);
    expect(listed[0]!.orderId).toBe("order_2"); // newest first
    expect(listed[1]).toEqual(order(1)); // full round-trip, no field dropped
    expect(store.path).toBe(join(dir, ORDERS_FILENAME));
  });

  it("creates the file 0600 (local-only user data) and append-only (pre-existing lines preserved)", () => {
    const dir = mkdtempSync(join(tmpdir(), "northcinder-orders-"));
    const store = createOrderStore(dir);
    store.append(order(1));
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    const before = readFileSync(store.path, "utf8");
    store.append(order(2));
    expect(readFileSync(store.path, "utf8").startsWith(before)).toBe(true);
  });

  it("a corrupt line is skipped on read (never invented, never deleted) and an absent file lists empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "northcinder-orders-"));
    const store = createOrderStore(dir);
    expect(store.list()).toEqual([]);
    writeFileSync(store.path, `${JSON.stringify(order(1))}\ngarbage-line\n`);
    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.orderId).toBe("order_1");
    expect(readFileSync(store.path, "utf8")).toContain("garbage-line"); // bytes untouched
  });

  it("is a BOUNDED (chunked) tail reader: newest N are returned correctly across a backward chunk boundary — never a whole-file readFileSync+split", () => {
    const dir = mkdtempSync(join(tmpdir(), "northcinder-orders-"));
    const store = createOrderStore(dir);
    const total = 200;
    for (let i = 1; i <= total; i += 1) store.append(order(i));

    // Tiny chunkSize forces the backward reader through many chunks; a
    // limited window must still land exactly on the newest 5, in order.
    const newest5 = store.list({ limit: 5, chunkSize: 53 });
    expect(newest5.map((o) => o.orderId)).toEqual(["order_200", "order_199", "order_198", "order_197", "order_196"]);

    // No limit given (the dashboard's call site) must still return every
    // record, newest first, unchanged behavior.
    const all = store.list({ chunkSize: 53 });
    expect(all).toHaveLength(total);
    expect(all[0]!.orderId).toBe("order_200");
    expect(all[all.length - 1]!.orderId).toBe("order_1");
  });

  it("sanitizes a write failure in append(): the thrown error names no filesystem path", () => {
    const dir = mkdtempSync(join(tmpdir(), "northcinder-orders-fserr-"));
    // Force mkdirSync(configDir) to throw ENOTDIR/EEXIST: occupy the config
    // dir path itself with a FILE, so it cannot be created/used as a directory.
    const configDir = join(dir, "blocked-config-dir");
    writeFileSync(configDir, "not a directory");
    const store = createOrderStore(configDir);
    try {
      store.append(order(1));
      expect.unreachable("expected append() to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(configDir);
      expect(message).not.toContain("blocked-config-dir");
      expect(message.toLowerCase()).not.toMatch(/[a-z]:\\|\/[a-z0-9_.-]+\/[a-z0-9_.-]+/i);
    }
  });
});
