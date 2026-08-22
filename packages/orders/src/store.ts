/**
 * The order-graph store: one 0600 JSON file in the user's config dir holding
 * the MERGED view (orders + shipments + return-windows) built from parsed
 * emails, plus an append-only 0600 JSONL "unparsed" inbox that NEVER drops a
 * record (determinism law corollary: a plugin that can't confidently parse
 * an email must not silently vanish it).
 *
 * Design decision (recorded for the closing ADRs): this store is ADJACENT
 * to, not an extension of, the client's local UI `order-store.ts` (checkout
 * OrderRecord, append-only orders.jsonl). The two hold structurally
 * different things — a checkout OrderRecord cites a cryptographic mandate
 * and is intentionally append-only/immutable; an email-derived Order is a
 * best-effort merge target that gets UPDATED as more emails arrive for the
 * same order (shipped → delivered → return-window). Mutating the checkout
 * log to fit that shape would break its audit invariant. Instead,
 * `mergeCheckoutOrders` (below) adapts read-only `OrderRecord`s from
 * @northcinder/checkout into the `Order` shape at query time — the checkout log
 * itself is never touched by this package.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LifecycleReminderInputSchema,
  LifecycleReminderSchema,
  PurchaseOutcomeInputSchema,
  PurchaseOutcomeSchema,
  type LifecycleReminder,
  type LifecycleReminderInput,
  type Order,
  type PurchaseOutcome,
  type PurchaseOutcomeInput,
  type ReturnWindow,
  type Shipment,
  type ShipmentStatus,
  type UnparsedEmailRecord,
  withExclusiveFileLock,
} from "@northcinder/protocol";
import type { OrderRecord } from "@northcinder/checkout";
import { parseEmailToRecord } from "./parser.js";
import { BRAND_NAME } from "./brand.js";
import { sanitizeTextField } from "./sanitize.js";

export const ORDER_GRAPH_FILENAME = "order-graph.json";
export const UNPARSED_FILENAME = "unparsed-emails.jsonl";
export const PROCESSED_MESSAGES_FILENAME = "processed-messages.json";

interface OrderGraphFile {
  version: 1;
  orders: Record<string, Order>;
  shipments: Record<string, Shipment>;
  returnWindows: Record<string, ReturnWindow>;
  outcomes: Record<string, PurchaseOutcome>;
  lifecycleReminders: Record<string, LifecycleReminder>;
  /** Internal, bounded cross-process send leases; never surfaced as order data. */
  reminderClaims: Record<string, { token: string; expiresAt: string }>;
}

const EMPTY_GRAPH: OrderGraphFile = { version: 1, orders: {}, shipments: {}, returnWindows: {}, outcomes: {}, lifecycleReminders: {}, reminderClaims: {} };

function sanitizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function deriveOrderId(merchantKey: string, orderNumber: string): string {
  return `order_email_${sanitizeKey(merchantKey)}_${sanitizeKey(orderNumber)}`;
}

function deriveShipmentId(trackingNumber: string): string {
  return `shipment_${sanitizeKey(trackingNumber)}`;
}

const SHIPMENT_STATUS_RANK: Record<ShipmentStatus, number> = {
  label_created: 0,
  in_transit: 1,
  out_for_delivery: 2,
  delivered: 3,
  exception: 4,
};

export type IngestOutcome =
  | { kind: "order"; order: Order }
  | { kind: "shipment"; shipment: Shipment }
  | { kind: "return_window"; returnWindow: ReturnWindow }
  | { kind: "unparsed"; record: UnparsedEmailRecord }
  | { kind: "duplicate"; messageId: string };

export type ReminderClaimResult =
  | { state: "claimed"; token: string }
  | { state: "sent" | "in_progress" };

export interface ImportOrderInput {
  orderNumber?: string;
  merchantName: string;
  merchantDomain?: string;
  orderDate: string;
  items?: Order["items"];
  total?: Order["total"];
  status?: Order["status"];
}

export interface OrderGraphStore {
  readonly path: string;
  ingestEml(raw: string, source: "drop_dir" | "imap"): IngestOutcome;
  importOrder(input: ImportOrderInput): Order;
  /** Email-derived + imported orders merged with checkout orders (adapted, never mutated). */
  listOrders(checkoutOrders?: readonly OrderRecord[]): Order[];
  getOrder(
    id: string,
    checkoutOrders?: readonly OrderRecord[],
  ): { order: Order; shipments: Shipment[]; returnWindow?: ReturnWindow; outcome?: PurchaseOutcome; lifecycleReminders?: LifecycleReminder[] } | undefined;
  listUnparsed(): UnparsedEmailRecord[];
  /** Marks a return-window reminder as sent (dedupe persists across restarts). */
  markReminderSent(orderId: string, sentAt: string, claimToken?: string): ReturnWindow | undefined;
  tryClaimReturnReminder(orderId: string, now: Date, leaseMs: number): ReminderClaimResult;
  renewReturnReminderClaim(orderId: string, token: string, now: Date, leaseMs: number): boolean;
  releaseReturnReminderClaim(orderId: string, token: string): boolean;
  listReturnWindows(): ReturnWindow[];
  recordOutcome(input: PurchaseOutcomeInput, checkoutOrders?: readonly OrderRecord[]): PurchaseOutcome;
  /** One locked commit for a confirmed outcome and explicit reminder inputs; identical retries reuse reminder ids. */
  recordOutcomeBatch(input: PurchaseOutcomeInput, reminders: readonly LifecycleReminderInput[], checkoutOrders?: readonly OrderRecord[]): { outcome: PurchaseOutcome; reminders: LifecycleReminder[] };
  getOutcome(orderId: string): PurchaseOutcome | undefined;
  listOutcomes(): PurchaseOutcome[];
  scheduleLifecycleReminder(orderId: string, input: LifecycleReminderInput, checkoutOrders?: readonly OrderRecord[]): LifecycleReminder;
  listLifecycleReminders(): LifecycleReminder[];
  markLifecycleReminderSent(id: string, sentAt: string, claimToken?: string): LifecycleReminder | undefined;
  tryClaimLifecycleReminder(id: string, now: Date, leaseMs: number): ReminderClaimResult;
  renewLifecycleReminderClaim(id: string, token: string, now: Date, leaseMs: number): boolean;
  releaseLifecycleReminderClaim(id: string, token: string): boolean;
}

export function createOrderGraphStore(configDir: string): OrderGraphStore {
  const path = join(configDir, ORDER_GRAPH_FILENAME);
  const unparsedPath = join(configDir, UNPARSED_FILENAME);
  const processedPath = join(configDir, PROCESSED_MESSAGES_FILENAME);

  function loadGraph(): OrderGraphFile {
    if (!existsSync(path)) return { ...EMPTY_GRAPH, orders: {}, shipments: {}, returnWindows: {}, outcomes: {}, lifecycleReminders: {}, reminderClaims: {} };
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as OrderGraphFile;
      return {
        version: 1,
        orders: raw.orders ?? {},
        shipments: raw.shipments ?? {},
        returnWindows: raw.returnWindows ?? {},
        outcomes: raw.outcomes ?? {},
        lifecycleReminders: raw.lifecycleReminders ?? {},
        reminderClaims: raw.reminderClaims ?? {},
      };
    } catch {
      throw new Error(`${BRAND_NAME} orders: ${path} is not valid JSON — refusing to touch it (fix or remove the file)`);
    }
  }

  function persistGraph(graph: OrderGraphFile): void {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(graph, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }

  /**
   * Serializes the complete graph read-modify-write transaction across
   * processes. Atomic rename alone prevents torn JSON, but not one process
   * replacing another process's newer snapshot. O_EXCL makes this lock
   * acquisition the cross-process commit boundary; contention fails visibly
   * and immediately rather than waiting indefinitely.
   */
  function mutateGraph<T>(mutation: (graph: OrderGraphFile) => T): T {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    return withExclusiveFileLock(`${path}.lock`, { errorPrefix: `${BRAND_NAME} orders`, resource: "order graph" }, () => {
      const graph = loadGraph();
      const result = mutation(graph);
      persistGraph(graph);
      return result;
    });
  }

  function loadProcessed(): Set<string> {
    if (!existsSync(processedPath)) return new Set();
    try {
      const raw = JSON.parse(readFileSync(processedPath, "utf8")) as { messageIds: string[] };
      return new Set(raw.messageIds ?? []);
    } catch {
      return new Set();
    }
  }

  function persistProcessed(ids: Set<string>): void {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const tmp = `${processedPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, messageIds: [...ids] }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, processedPath);
  }

  function appendUnparsed(record: UnparsedEmailRecord): void {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const existed = existsSync(unparsedPath);
    appendFileSync(unparsedPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (!existed) chmodSync(unparsedPath, 0o600);
  }

  /** Strips control chars from the free-text fields a hostile mail/caller can influence (leak/injection discipline — see sanitize.ts). */
function sanitizeOrderText(order: Order): Order {
  return {
    ...order,
    merchantName: sanitizeTextField(order.merchantName),
    ...(order.orderNumber !== undefined ? { orderNumber: sanitizeTextField(order.orderNumber) } : {}),
    items: order.items.map((item) => ({ ...item, title: sanitizeTextField(item.title) })),
  };
}

function orderRecordToOrder(record: OrderRecord): Order {
    return sanitizeOrderText({
      id: record.orderId,
      merchantName: record.merchantId,
      merchantDomain: record.merchantDomain,
      orderDate: record.createdAt,
      items: [{ title: record.productTitle, quantity: 1 }],
      total: record.mandate.constraints.maxAmount,
      status: record.status === "completed" ? "confirmed" : "unknown",
      source: { kind: "checkout", orderId: record.orderId },
    });
  }

  function assertKnownOrder(graph: OrderGraphFile, orderId: string, checkoutOrders: readonly OrderRecord[]): void {
    const knownCheckoutOrder = checkoutOrders.some((record) => record.orderId === orderId);
    if (graph.orders[orderId] === undefined && !knownCheckoutOrder) {
      throw new Error(`${BRAND_NAME} orders: unknown order ${orderId}`);
    }
  }

  function tryClaim(graph: OrderGraphFile, key: string, alreadySent: boolean, now: Date, leaseMs: number): ReminderClaimResult {
    if (alreadySent) return { state: "sent" };
    const existing = graph.reminderClaims[key];
    if (existing !== undefined && Date.parse(existing.expiresAt) > now.getTime()) return { state: "in_progress" };
    const token = randomUUID();
    graph.reminderClaims[key] = { token, expiresAt: new Date(now.getTime() + leaseMs).toISOString() };
    return { state: "claimed", token };
  }

  function renewClaim(graph: OrderGraphFile, key: string, token: string, now: Date, leaseMs: number): boolean {
    const existing = graph.reminderClaims[key];
    if (existing === undefined || existing.token !== token || Date.parse(existing.expiresAt) <= now.getTime()) return false;
    graph.reminderClaims[key] = { token, expiresAt: new Date(now.getTime() + leaseMs).toISOString() };
    return true;
  }

  function ownsActiveClaim(graph: OrderGraphFile, key: string, token: string | undefined, at: Date): boolean {
    const existing = graph.reminderClaims[key];
    if (token === undefined) return existing === undefined;
    return existing !== undefined && existing.token === token && Date.parse(existing.expiresAt) > at.getTime();
  }

  return {
    path,
    ingestEml(raw, source) {
      const parsed = parseEmailToRecord(raw);
      const processed = loadProcessed();
      if (processed.has(parsed.email.messageId)) {
        return { kind: "duplicate", messageId: parsed.email.messageId };
      }

      const { result } = parsed;
      if (result.kind === "unparsed") {
        const record: UnparsedEmailRecord = {
          id: `unparsed_${randomUUID()}`,
          subject: parsed.email.subject,
          from: parsed.email.from,
          receivedAt: parsed.email.date,
          reason: result.reason,
          source,
        };
        appendUnparsed(record);
        processed.add(parsed.email.messageId);
        persistProcessed(processed);
        return { kind: "unparsed", record };
      }

      if (result.kind === "order") {
        const order = mutateGraph((graph) => {
          const merchantKey = result.order.merchantDomain ?? result.order.merchantName;
          const id = deriveOrderId(merchantKey, result.order.orderNumber ?? parsed.email.messageId);
          const existing = graph.orders[id];
          const next: Order = sanitizeOrderText({
            ...existing,
            ...result.order,
            id,
            source: { kind: "email", messageId: parsed.email.messageId, parser: parsed.parserId },
          });
          graph.orders[id] = next;
          return next;
        });
        processed.add(parsed.email.messageId);
        persistProcessed(processed);
        return { kind: "order", order };
      }

      if (result.kind === "shipment") {
        const shipment = mutateGraph((graph) => {
          const orderId = deriveOrderId(result.merchantDomain ?? result.orderNumber, result.orderNumber);
          const id = deriveShipmentId(result.shipment.trackingNumber);
          const existing = graph.shipments[id];
          const events = existing ? [...existing.events, ...result.shipment.events] : [...result.shipment.events];
          const status =
            existing && SHIPMENT_STATUS_RANK[existing.status] > SHIPMENT_STATUS_RANK[result.shipment.status]
              ? existing.status
              : result.shipment.status;
          const next: Shipment = { ...existing, ...result.shipment, id, orderId, events, status };
          graph.shipments[id] = next;
          return next;
        });
        processed.add(parsed.email.messageId);
        persistProcessed(processed);
        return { kind: "shipment", shipment };
      }

      // result.kind === "return_window"
      const returnWindow = mutateGraph((graph) => {
        const orderId = deriveOrderId(result.merchantDomain ?? result.orderNumber, result.orderNumber);
        const existing = graph.returnWindows[orderId];
        const next: ReturnWindow = { ...existing, ...result.returnWindow, orderId };
        graph.returnWindows[orderId] = next;
        return next;
      });
      processed.add(parsed.email.messageId);
      persistProcessed(processed);
      return { kind: "return_window", returnWindow };
    },

    importOrder(input) {
      return mutateGraph((graph) => {
        const id = `order_import_${randomUUID()}`;
        const order: Order = sanitizeOrderText({
          id,
          ...(input.orderNumber !== undefined ? { orderNumber: input.orderNumber } : {}),
          merchantName: input.merchantName,
          ...(input.merchantDomain !== undefined ? { merchantDomain: input.merchantDomain } : {}),
          orderDate: input.orderDate,
          items: input.items ?? [],
          ...(input.total !== undefined ? { total: input.total } : {}),
          status: input.status ?? "unknown",
          source: { kind: "import" },
        });
        graph.orders[id] = order;
        return order;
      });
    },

    listOrders(checkoutOrders = []) {
      const graph = loadGraph();
      const emailOrders = Object.values(graph.orders);
      const checkoutAsOrders = checkoutOrders.map(orderRecordToOrder);
      return [...emailOrders, ...checkoutAsOrders].sort((a, b) => Date.parse(b.orderDate) - Date.parse(a.orderDate));
    },

    getOrder(id, checkoutOrders = []) {
      const graph = loadGraph();
      const order = graph.orders[id] ?? checkoutOrders.map(orderRecordToOrder).find((o) => o.id === id);
      if (!order) return undefined;
      const shipments = Object.values(graph.shipments).filter((s) => s.orderId === id);
      const returnWindow = graph.returnWindows[id];
      const outcome = graph.outcomes[id];
      const lifecycleReminders = Object.values(graph.lifecycleReminders).filter((reminder) => reminder.orderId === id);
      return {
        order,
        shipments,
        ...(returnWindow !== undefined ? { returnWindow } : {}),
        ...(outcome !== undefined ? { outcome } : {}),
        ...(lifecycleReminders.length > 0 ? { lifecycleReminders } : {}),
      };
    },

    listUnparsed() {
      if (!existsSync(unparsedPath)) return [];
      return readFileSync(unparsedPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as UnparsedEmailRecord);
    },

    markReminderSent(orderId, sentAt, claimToken) {
      return mutateGraph((graph) => {
        const existing = graph.returnWindows[orderId];
        if (!existing) return undefined;
        if (!ownsActiveClaim(graph, `return:${orderId}`, claimToken, new Date(sentAt))) return undefined;
        const updated: ReturnWindow = { ...existing, reminderSentAt: sentAt };
        graph.returnWindows[orderId] = updated;
        delete graph.reminderClaims[`return:${orderId}`];
        return updated;
      });
    },

    tryClaimReturnReminder(orderId, now, leaseMs) {
      return mutateGraph((graph) => tryClaim(graph, `return:${orderId}`, graph.returnWindows[orderId]?.reminderSentAt !== undefined, now, leaseMs));
    },

    renewReturnReminderClaim(orderId, token, now, leaseMs) {
      return mutateGraph((graph) => renewClaim(graph, `return:${orderId}`, token, now, leaseMs));
    },

    releaseReturnReminderClaim(orderId, token) {
      return mutateGraph((graph) => {
        const key = `return:${orderId}`;
        if (graph.reminderClaims[key]?.token !== token) return false;
        delete graph.reminderClaims[key];
        return true;
      });
    },

    listReturnWindows() {
      return Object.values(loadGraph().returnWindows);
    },

    recordOutcome(input, checkoutOrders = []) {
      const parsedInput = PurchaseOutcomeInputSchema.parse(input);
      return mutateGraph((graph) => {
        assertKnownOrder(graph, parsedInput.orderId, checkoutOrders);
        const outcome = PurchaseOutcomeSchema.parse({ ...parsedInput, recordedAt: new Date().toISOString() });
        graph.outcomes[outcome.orderId] = outcome;
        return outcome;
      });
    },

    recordOutcomeBatch(input, rawReminders, checkoutOrders = []) {
      const parsedInput = PurchaseOutcomeInputSchema.parse(input);
      const parsedReminders = rawReminders.map((reminder) => LifecycleReminderInputSchema.parse(reminder));
      return mutateGraph((graph) => {
        assertKnownOrder(graph, parsedInput.orderId, checkoutOrders);
        const outcome = PurchaseOutcomeSchema.parse({ ...parsedInput, recordedAt: new Date().toISOString() });
        const remindersById = new Map<string, LifecycleReminder>();
        for (const reminder of parsedReminders) {
          const existing = Object.values(graph.lifecycleReminders).find(
            (candidate) => candidate.orderId === outcome.orderId && candidate.kind === reminder.kind && candidate.dueOn === reminder.dueOn && candidate.remindOn === reminder.remindOn && candidate.detail === reminder.detail,
          );
          if (existing !== undefined) {
            remindersById.set(existing.id, existing);
            continue;
          }
          const created = LifecycleReminderSchema.parse({ ...reminder, id: `lifecycle_reminder_${randomUUID()}`, orderId: outcome.orderId, createdAt: new Date().toISOString() });
          graph.lifecycleReminders[created.id] = created;
          remindersById.set(created.id, created);
        }
        const reminders = [...remindersById.values()];
        graph.outcomes[outcome.orderId] = outcome;
        return { outcome, reminders };
      });
    },

    getOutcome(orderId) {
      return loadGraph().outcomes[orderId];
    },

    listOutcomes() {
      return Object.values(loadGraph().outcomes);
    },

    scheduleLifecycleReminder(orderId, input, checkoutOrders = []) {
      const parsedInput = LifecycleReminderInputSchema.parse(input);
      return mutateGraph((graph) => {
        assertKnownOrder(graph, orderId, checkoutOrders);
        let id: string;
        do {
          id = `lifecycle_reminder_${randomUUID()}`;
        } while (graph.lifecycleReminders[id] !== undefined);
        const reminder = LifecycleReminderSchema.parse({ ...parsedInput, id, orderId, createdAt: new Date().toISOString() });
        graph.lifecycleReminders[id] = reminder;
        return reminder;
      });
    },

    listLifecycleReminders() {
      return Object.values(loadGraph().lifecycleReminders);
    },

    markLifecycleReminderSent(id, sentAt, claimToken) {
      return mutateGraph((graph) => {
        const existing = graph.lifecycleReminders[id];
        if (!existing) return undefined;
        if (!ownsActiveClaim(graph, `lifecycle:${id}`, claimToken, new Date(sentAt))) return undefined;
        const updated = LifecycleReminderSchema.parse({ ...existing, reminderSentAt: sentAt });
        graph.lifecycleReminders[id] = updated;
        delete graph.reminderClaims[`lifecycle:${id}`];
        return updated;
      });
    },

    tryClaimLifecycleReminder(id, now, leaseMs) {
      return mutateGraph((graph) => tryClaim(graph, `lifecycle:${id}`, graph.lifecycleReminders[id]?.reminderSentAt !== undefined, now, leaseMs));
    },

    renewLifecycleReminderClaim(id, token, now, leaseMs) {
      return mutateGraph((graph) => renewClaim(graph, `lifecycle:${id}`, token, now, leaseMs));
    },

    releaseLifecycleReminderClaim(id, token) {
      return mutateGraph((graph) => {
        const key = `lifecycle:${id}`;
        if (graph.reminderClaims[key]?.token !== token) return false;
        delete graph.reminderClaims[key];
        return true;
      });
    },
  };
}
