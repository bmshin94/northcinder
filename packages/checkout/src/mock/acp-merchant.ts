/**
 * In-repo mock ACP merchant: a plain node:http server implementing the
 * merchant side of the Agentic Commerce Protocol checkout-session REST API
 * (spec 2026-04-17, github.com/agentic-commerce-protocol):
 *
 *   POST /checkout_sessions
 *   POST /checkout_sessions/{id}/complete
 *   POST /checkout_sessions/{id}/cancel
 *
 * It records EVERY raw request (headers + body) so tests can assert both
 * well-formedness of what our client sent and the structural absence of any
 * raw card PAN. It also carries a merchant-side tripwire: any 13-19 digit
 * run in a /complete body is rejected as a raw PAN.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

export interface MockCatalogItem {
  name: string;
  unitAmount: number; // minor units
}

export interface MockAcpMerchantOptions {
  /** Item id → price. Line items outside the catalog are rejected. */
  catalog: Record<string, MockCatalogItem>;
  /** Flat tax added to the subtotal, in minor units (default 0). */
  taxMinor?: number;
  /** Bearer key the merchant requires (default "mock_api_key"). */
  apiKey?: string;
  /** Session/total currency the merchant reports (default "usd"; lowercase like the real ACP wire shape). */
  currency?: string;
}

export interface MockAcpMerchant {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Sessions by id with their last status. */
  sessions: Map<string, { status: string; itemIds: string[] }>;
  close(): Promise<void>;
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

function acpError(res: import("node:http").ServerResponse, status: number, type: string, code: string, message: string): void {
  json(res, status, { type, code, message });
}

const PAN_PATTERN = /(?:\d[ -]?){13,19}/;
const RAW_PAYMENT_FIELD_PATTERN = /^(?:card[_-]?number|pan|cvv|cvc|security[_-]?code)$/i;

function containsRawPaymentField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRawPaymentField);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => RAW_PAYMENT_FIELD_PATTERN.test(key) || containsRawPaymentField(nested));
}

export async function startMockAcpMerchant(options: MockAcpMerchantOptions): Promise<MockAcpMerchant> {
  const apiKey = options.apiKey ?? "mock_api_key";
  const taxMinor = options.taxMinor ?? 0;
  const currency = options.currency ?? "usd";
  const requests: RecordedRequest[] = [];
  const sessions = new Map<string, { status: string; itemIds: string[] }>();
  // Idempotency-Key dedup (ACP spec 2026-04-17): a retried POST with the SAME
  // key on the SAME path must return the exact response the first attempt
  // produced, never re-run the request logic against now-mutated session
  // state (which would otherwise surface a spurious invalid_state error on
  // an honest client retry after e.g. a dropped response).
  const idempotencyCache = new Map<string, { status: number; text: string }>();
  let counter = 0;

  function sessionBody(id: string, itemIds: string[], status: string, order?: unknown): Record<string, unknown> {
    const lineItems = itemIds.map((itemId, i) => {
      const item = options.catalog[itemId]!;
      return {
        id: `line_item_${i}`,
        item: { id: itemId },
        quantity: 1,
        name: item.name,
        unit_amount: item.unitAmount,
        totals: [
          { type: "subtotal", display_text: "Subtotal", amount: item.unitAmount },
          { type: "total", display_text: "Total", amount: item.unitAmount },
        ],
      };
    });
    const subtotal = itemIds.reduce((sum, itemId) => sum + options.catalog[itemId]!.unitAmount, 0);
    return {
      id,
      protocol: { version: "2026-04-17" },
      capabilities: {
        payment: {
          handlers: [
            {
              id: "card_tokenized",
              name: "dev.acp.tokenized.card",
              version: "2026-01-22",
              requires_delegate_payment: true,
              psp: "stripe",
            },
          ],
        },
        interventions: { supported: [], required: [], enforcement: "conditional" },
      },
      status,
      currency,
      line_items: lineItems,
      totals: [
        { type: "subtotal", display_text: "Subtotal", amount: subtotal },
        { type: "tax", display_text: "Tax", amount: taxMinor },
        { type: "total", display_text: "Total", amount: subtotal + taxMinor },
      ],
      fulfillment_options: [],
      messages: [],
      links: [],
      ...(order !== undefined ? { order } : {}),
    };
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const path = req.url ?? "/";
      requests.push({ method: req.method ?? "", path, headers: { ...req.headers }, rawBody });

      if (req.method !== "POST") return acpError(res, 405, "invalid_request", "method_not_allowed", "POST only");
      if (req.headers.authorization !== `Bearer ${apiKey}`) {
        return acpError(res, 401, "invalid_request", "unauthorized", "missing or wrong Authorization bearer key");
      }
      const idempotencyKey = req.headers["idempotency-key"];
      if (!idempotencyKey) {
        return acpError(res, 400, "invalid_request", "idempotency_key_required", "Idempotency-Key header is required");
      }
      if (!req.headers["api-version"]) {
        return acpError(res, 400, "invalid_request", "api_version_required", "API-Version header is required");
      }

      // Dedup keyed by (path, Idempotency-Key): a retry replays the FIRST
      // response verbatim, never re-executing the request against whatever
      // the session's state has since become.
      const cacheKey = `${path}|${String(idempotencyKey)}`;
      const cached = idempotencyCache.get(cacheKey);
      if (cached) {
        res.writeHead(cached.status, { "content-type": "application/json" });
        res.end(cached.text);
        return;
      }
      // Record whatever THIS handler writes, keyed by cacheKey, so a later
      // retry with the same key replays it. Scoped to this one response
      // object (fresh per request), so no cross-request leakage.
      const originalWriteHead = res.writeHead.bind(res);
      const originalEnd = res.end.bind(res);
      let capturedStatus = 200;
      res.writeHead = ((status: number, ...rest: unknown[]) => {
        capturedStatus = status;
        return (originalWriteHead as (...a: unknown[]) => typeof res)(status, ...rest);
      }) as typeof res.writeHead;
      res.end = ((chunk?: unknown, ...rest: unknown[]) => {
        if (typeof chunk === "string") idempotencyCache.set(cacheKey, { status: capturedStatus, text: chunk });
        return (originalEnd as (...a: unknown[]) => typeof res)(chunk, ...rest);
      }) as typeof res.end;

      let body: unknown;
      try {
        body = rawBody === "" ? {} : JSON.parse(rawBody);
      } catch {
        return acpError(res, 400, "invalid_request", "invalid_json", "request body is not valid JSON");
      }

      if (path === "/checkout_sessions") {
        const items = (body as { line_items?: Array<{ id?: string; quantity?: number }> }).line_items;
        if (!Array.isArray(items) || items.length === 0 || items.some((i) => typeof i?.id !== "string")) {
          return acpError(res, 400, "invalid_request", "invalid_line_items", "line_items must be a non-empty array of {id}");
        }
        const itemIds = items.map((i) => i.id as string);
        const unknown = itemIds.find((id) => !options.catalog[id]);
        if (unknown !== undefined) {
          return acpError(res, 400, "invalid_request", "unknown_item", `item ${unknown} is not in the catalog`);
        }
        counter += 1;
        const id = `checkout_session_${counter}`;
        sessions.set(id, { status: "ready_for_payment", itemIds });
        return json(res, 201, sessionBody(id, itemIds, "ready_for_payment"));
      }

      const complete = path.match(/^\/checkout_sessions\/([^/]+)\/complete$/);
      if (complete) {
        const id = complete[1]!;
        const session = sessions.get(id);
        if (!session) return acpError(res, 404, "invalid_request", "not_found", `no such checkout session ${id}`);
        if (session.status !== "ready_for_payment") {
          return acpError(res, 400, "invalid_request", "invalid_state", `session is ${session.status}`);
        }
        // Merchant-side raw-PAN tripwire: delegated tokens only, never card numbers.
        if (PAN_PATTERN.test(rawBody)) {
          return acpError(res, 400, "invalid_request", "raw_pan_rejected", "raw card number detected — delegated payment tokens only");
        }
        if (containsRawPaymentField(body)) {
          return acpError(res, 400, "invalid_request", "raw_payment_field_rejected", "raw PAN/CVV fields are forbidden — delegated payment tokens only");
        }
        const credential = (body as {
          payment_data?: { instrument?: { credential?: { type?: string; token?: string } } };
        }).payment_data?.instrument?.credential;
        if (
          credential?.type !== "spt" ||
          typeof credential.token !== "string" ||
          credential.token.length === 0 ||
          Object.keys(credential).some((key) => key !== "type" && key !== "token")
        ) {
          return acpError(res, 400, "invalid_request", "invalid_payment_data", "payment_data.instrument.credential {type: spt, token} is required");
        }
        session.status = "completed";
        const order = {
          type: "order",
          id: `ord_${id}`,
          checkout_session_id: id,
          permalink_url: `https://merchant.example/orders/ord_${id}`,
          status: "confirmed",
        };
        return json(res, 200, sessionBody(id, session.itemIds, "completed", order));
      }

      const cancel = path.match(/^\/checkout_sessions\/([^/]+)\/cancel$/);
      if (cancel) {
        const id = cancel[1]!;
        const session = sessions.get(id);
        if (!session) return acpError(res, 404, "invalid_request", "not_found", `no such checkout session ${id}`);
        session.status = "canceled";
        return json(res, 200, sessionBody(id, session.itemIds, "canceled"));
      }

      return acpError(res, 404, "invalid_request", "not_found", `no route for ${path}`);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    sessions,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
