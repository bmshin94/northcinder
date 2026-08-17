import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createOrderGraphStore } from "../src/store.js";
import { ingestDropDir } from "../src/ingest/drop-dir.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("ingestDropDir", () => {
  it("ingests every .eml file in the drop directory and is idempotent on re-scan", () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-orders-dropdir-"));
    const dropDir = join(configDir, "mail-drop");
    mkdirSync(dropDir, { recursive: true });
    copyFileSync(join(FIXTURES_DIR, "shopify-order-confirmation.eml"), join(dropDir, "shopify-order-confirmation.eml"));
    copyFileSync(join(FIXTURES_DIR, "amazon-order-confirmation.eml"), join(dropDir, "amazon-order-confirmation.eml"));

    const store = createOrderGraphStore(configDir);
    const first = ingestDropDir(dropDir, store);
    expect(first.scanned).toBe(2);
    expect(first.outcomes.map((o) => o.kind).sort()).toEqual(["order", "order"]);
    expect(store.listOrders()).toHaveLength(2);

    // Files are left in place (no destructive move) — a re-scan must not duplicate records.
    const second = ingestDropDir(dropDir, store);
    expect(second.scanned).toBe(2);
    expect(second.outcomes.map((o) => o.kind)).toEqual(["duplicate", "duplicate"]);
    expect(store.listOrders()).toHaveLength(2);
  });

  it("treats a missing drop directory as empty, never an error", () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-orders-dropdir-"));
    const store = createOrderGraphStore(configDir);
    const result = ingestDropDir(join(configDir, "does-not-exist"), store);
    expect(result).toEqual({ scanned: 0, outcomes: [] });
  });
});
