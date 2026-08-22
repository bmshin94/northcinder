/**
 * Persisted order records (local UI): every checkout that got PAST mandate
 * verification lands here as one JSONL line, so the dashboard's orders tab
 * shows what was actually bought (or handed off) across sessions — the
 * durable read-model counterpart of the in-memory OrderRecord that
 * complete_checkout returns.
 *
 * Local-only user data (0600, user config dir), append-only like the audit
 * log. Reads go to disk on every call: the MCP client and the dashboard are
 * the same process today, but the file is the source of truth, never a cache.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OrderRecord } from "@northcinder/checkout";
import { forEachLineFromEnd } from "./bounded-tail-reader.js";
import { runFsOp } from "./fs-error-sanitizer.js";

export const ORDERS_FILENAME = "orders.jsonl";
export const LEGACY_CHECKOUT_SOURCE = "legacy_checkout";

type PersistedOrderRecord = Partial<OrderRecord> & {
  mandate?: {
    intent?: unknown;
    constraints?: { maxAmount?: unknown };
  };
};

/**
 * Pre-change checkout lines did not carry sourceStore or productTitle. Keep
 * their bytes append-only, but adapt the read view so display consumers get a
 * complete record. The synthetic source never claims exact decision
 * attribution for history that did not persist it.
 */
function normalizePersistedOrder(value: unknown): OrderRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as PersistedOrderRecord;
  const requiredStrings = [
    record.orderId,
    record.createdAt,
    record.offerId,
    record.merchantId,
    record.merchantDomain,
    record.railId,
    record.mandateId,
  ];
  if (requiredStrings.some((field) => typeof field !== "string" || field.length === 0)) return undefined;
  if (record.status !== "completed" && record.status !== "handed_off") return undefined;
  if (typeof record.mandate !== "object" || record.mandate === null) return undefined;
  if (record.evidence === undefined) return undefined;

  const hasStoredIdentity =
    typeof record.sourceStore === "string" &&
    record.sourceStore.length > 0 &&
    typeof record.productTitle === "string" &&
    record.productTitle.length > 0;
  if (hasStoredIdentity) return record as OrderRecord;

  const intent =
    typeof record.mandate.intent === "string" && record.mandate.intent.trim().length > 0
      ? record.mandate.intent
      : record.offerId!;
  return {
    ...(record as OrderRecord),
    sourceStore: LEGACY_CHECKOUT_SOURCE,
    productTitle: intent,
  };
}

export interface OrderStore {
  readonly path: string;
  /** Appends one order record (JSONL). Throws on I/O failure. */
  append(order: OrderRecord): void;
  /**
   * Orders newest first. Unparsable lines are skipped, never invented.
   * BOUNDED (chunked) reader — see `forEachLineFromEnd`: with no `limit`
   * (the dashboard's call site) it still returns every record, but never
   * loads the whole file as one string/array to do it. An optional `limit`
   * stops the backward scan early once that many records are collected.
   */
  list(opts?: { limit?: number; chunkSize?: number }): OrderRecord[];
}

export function createOrderStore(configDir: string): OrderStore {
  const path = join(configDir, ORDERS_FILENAME);
  return {
    path,
    append(order) {
      // Fail CLOSED but never let the underlying fs error — which typically
      // embeds the absolute configDir/orders-log path — reach a tool-facing
      // error string; import_order calls this via
      // deps.orders.append at server.ts).
      runFsOp(() => {
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
        const existed = existsSync(path);
        appendFileSync(path, `${JSON.stringify(order)}\n`, { mode: 0o600 });
        // appendFileSync's mode is umask-filtered on creation; enforce 0600.
        if (!existed) chmodSync(path, 0o600);
      }, "order store append failed: the order could not be persisted");
    },
    list(opts = {}) {
      const limit = opts.limit ?? Infinity;
      const orders: OrderRecord[] = [];
      forEachLineFromEnd(
        path,
        (line) => {
          if (line.trim().length === 0) return; // blank lines: skipped, never counted/invented
          try {
            const normalized = normalizePersistedOrder(JSON.parse(line));
            if (normalized !== undefined) orders.push(normalized);
          } catch {
            // A corrupt line is skipped for display; the bytes stay on disk untouched.
          }
          if (orders.length >= limit) return false;
        },
        opts.chunkSize,
      );
      return orders;
    },
  };
}
