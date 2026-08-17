import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import {
  BrowserObservationSchema,
  rankOffers,
  trustKey,
  SearchRankRequestSchema,
  TrustRequestSchema,
  type SearchRankResponse,
  type ServiceError,
  type TrustSignal,
  type Offer,
} from "@northcinder/protocol";
import { containsUnsafeAgentFacingText, type Orchestrator } from "../orchestrator/orchestrator.js";
import type { TrustProvider } from "../trust/seed-trust.js";

/** Per-client static API key (MVP auth; env-configured in main.ts). */
export interface ApiClientKey {
  clientId: string;
  key: string;
}

export interface ServiceDeps {
  orchestrator: Orchestrator;
  trust: TrustProvider;
  apiKeys: ApiClientKey[];
  limits?: Partial<ServiceLimits>;
}

export interface ServiceLimits {
  /** Authenticated JSON request cap; service routes never need large bodies. */
  maxBodyBytes: number;
  /** Authenticated request-body completion deadline; releases admission slots. */
  bodyReadTimeoutMs: number;
  /** Fixed-window request budget per API client, per process. */
  requestsPerMinute: number;
  /** Maximum in-flight service calls per API client, per process. */
  maxConcurrentPerClient: number;
}

const DEFAULT_LIMITS: ServiceLimits = {
  maxBodyBytes: 65_536,
  bodyReadTimeoutMs: 5_000,
  requestsPerMinute: 60,
  maxConcurrentPerClient: 4,
};

type Env = { Variables: { clientId: string } };

function serviceError(c: Context, status: 400 | 401 | 404 | 408 | 413 | 429 | 500, err: ServiceError): Response {
  return c.json(err, status);
}

type BodyResult = { ok: true; value: unknown } | { ok: false; code: "payload_too_large" | "invalid_request" | "request_timeout" };

async function readJsonBody(c: Context, maxBytes: number, timeoutMs: number): Promise<BodyResult> {
  const declared = c.req.header("content-length");
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return { ok: false, code: "payload_too_large" };
  }
  const reader = c.req.raw.body?.getReader();
  if (reader === undefined) return { ok: false, code: "invalid_request" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await reader.cancel().catch(() => {});
        return { ok: false, code: "request_timeout" };
      }
      const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), remaining); });
      const next = await Promise.race([reader.read(), timeout]);
      if (timer) clearTimeout(timer);
      if (next === "timeout") {
        await reader.cancel().catch(() => {});
        return { ok: false, code: "request_timeout" };
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, code: "payload_too_large" };
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, code: "invalid_request" };
  } finally {
    reader.releaseLock();
  }
}

/** Constant-time key comparison via digest equality (no length leak). */
function keyMatches(presented: string, configured: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(configured).digest();
  return timingSafeEqual(a, b);
}

function offerFromBrowserObservation(
  observation: ReturnType<typeof BrowserObservationSchema.parse>,
  receivedAt: string,
): Offer {
  const url = new URL(observation.productUrl);
  url.hash = "";
  url.searchParams.sort();
  const productUrl = url.toString();
  const domain = url.hostname.toLowerCase();
  const id = createHash("sha256").update(productUrl).digest("hex").slice(0, 24);
  return {
    id: `browser-${id}`,
    product: {
      id: `browser-product-${id}`,
      title: observation.title,
      url: productUrl,
      ...(observation.brand !== undefined ? { brand: observation.brand } : {}),
      attributes: observation.attributes ?? {},
    },
    price: observation.price,
    merchant: { id: domain, name: observation.merchantName, domain },
    availability: observation.availability,
    ...(observation.shipping !== undefined ? { shipping: observation.shipping } : {}),
    sourceStore: "agent_browser",
    sponsored: observation.placement !== "organic",
    fetchedAt: observation.observedAt,
    ...(observation.condition !== undefined ? { condition: observation.condition } : {}),
    acquisition: {
      kind: "agent_observed",
      observedAt: observation.observedAt,
      receivedAt,
      placement: observation.placement,
    },
  };
}

export function createApp(deps: ServiceDeps): Hono<Env> {
  const app = new Hono<Env>();
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const requests = new Map<string, { startedAt: number; count: number }>();
  const inFlight = new Map<string, number>();

  app.get("/health", (c) => c.json({ ok: true, service: "northcinder", version: "0.1.0" }));

  // --- per-client key auth on every /v1 route ---
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const client =
      presented.length > 0 ? deps.apiKeys.find((k) => keyMatches(presented, k.key)) : undefined;
    if (client === undefined) {
      return serviceError(c, 401, {
        code: "unauthorized",
        message: "missing or invalid API key (Authorization: Bearer <key>)",
      });
    }
    c.set("clientId", client.clientId);
    const now = Date.now();
    const prior = requests.get(client.clientId);
    const window = prior !== undefined && now - prior.startedAt < 60_000 ? prior : { startedAt: now, count: 0 };
    if (window.count >= limits.requestsPerMinute) {
      return serviceError(c, 429, { code: "rate_limited", message: "request rate limit exceeded" });
    }
    const active = inFlight.get(client.clientId) ?? 0;
    if (active >= limits.maxConcurrentPerClient) {
      return serviceError(c, 429, { code: "rate_limited", message: "too many concurrent requests", details: { reason: "concurrency" } });
    }
    window.count += 1;
    requests.set(client.clientId, window);
    inFlight.set(client.clientId, active + 1);
    try {
      await next();
    } finally {
      const remaining = (inFlight.get(client.clientId) ?? 1) - 1;
      if (remaining === 0) inFlight.delete(client.clientId);
      else inFlight.set(client.clientId, remaining);
    }
  });

  // --- search + neutrality rank ---
  app.post("/v1/search", async (c) => {
    const body = await readJsonBody(c, limits.maxBodyBytes, limits.bodyReadTimeoutMs);
    if (!body.ok && body.code === "payload_too_large") {
      return serviceError(c, 413, { code: "payload_too_large", message: `request body exceeds the ${limits.maxBodyBytes}-byte limit` });
    }
    if (!body.ok && body.code === "request_timeout") {
      return serviceError(c, 408, { code: "invalid_request", message: "request body did not complete before the deadline" });
    }
    if (!body.ok) {
      return serviceError(c, 400, { code: "invalid_request", message: "body must be JSON" });
    }
    const parsed = SearchRankRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return serviceError(c, 400, {
        code: "invalid_request",
        message: "request body does not match SearchRankRequest",
        details: { issues: parsed.error.issues },
      });
    }

    const { query } = parsed.data;
    const native = await deps.orchestrator.search(query);
    const offers = [...native.offers];
    const storeStatuses = [...native.storeStatuses];
    const registeredStores = deps.orchestrator.registeredStoreIds();
    let browserObservationReport: SearchRankResponse["browserObservationReport"];
    if (parsed.data.browserObservations !== undefined) {
      const started = Date.now();
      const receivedAt = new Date().toISOString();
      const rejected: NonNullable<SearchRankResponse["browserObservationReport"]>["rejected"] = [];
      for (const [index, raw] of parsed.data.browserObservations.entries()) {
        if (containsUnsafeAgentFacingText(raw)) {
          rejected.push({
            index,
            code: "unsafe_content",
            message: "observation contains instruction-like or unsafe content",
          });
          continue;
        }
        const observation = BrowserObservationSchema.safeParse(raw);
        if (!observation.success) {
          rejected.push({
            index,
            code: "invalid_observation",
            message: "observation does not match the browser handoff schema",
          });
          continue;
        }
        offers.push(offerFromBrowserObservation(observation.data, receivedAt));
      }
      const accepted = parsed.data.browserObservations.length - rejected.length;
      browserObservationReport = {
        submitted: parsed.data.browserObservations.length,
        accepted,
        rejected,
      };
      storeStatuses.push({
        store: "agent_browser",
        ok: true,
        offerCount: accepted,
        durationMs: Math.max(0, Math.round(Date.now() - started)),
      });
      registeredStores.push("agent_browser");
      registeredStores.sort();
    }

    // Trust every distinct merchant once; ranking consumes the signals.
    // Keyed by trustKey(merchant) — the collision-safe canonical key
    // Bare merchant.id collides across stores. rankOffers
    // and both client-side re-verifiers use the same key in lockstep.
    const merchants = new Map(offers.map((o) => [trustKey(o.merchant), o.merchant]));
    const trust: Record<string, TrustSignal> = {};
    await Promise.all(
      [...merchants.entries()].map(async ([key, m]) => {
        trust[key] = await deps.trust.trustSignal(m);
      }),
    );

    const response: SearchRankResponse = {
      results: rankOffers(offers, query, { trust }),
      storeStatuses,
      registeredStores,
      // The exact trust signals the ranking consumed (ranking verification neutrality-proof
      // loop): with these + the offers above, any client can re-run the open
      // rankOffers and verify this response's order deterministically.
      trustSignals: trust,
      ...(browserObservationReport !== undefined ? { browserObservationReport } : {}),
    };
    return c.json(response);
  });

  // --- merchant trust signal ---
  app.post("/v1/trust", async (c) => {
    const body = await readJsonBody(c, limits.maxBodyBytes, limits.bodyReadTimeoutMs);
    if (!body.ok && body.code === "payload_too_large") {
      return serviceError(c, 413, { code: "payload_too_large", message: `request body exceeds the ${limits.maxBodyBytes}-byte limit` });
    }
    if (!body.ok && body.code === "request_timeout") {
      return serviceError(c, 408, { code: "invalid_request", message: "request body did not complete before the deadline" });
    }
    if (!body.ok) {
      return serviceError(c, 400, { code: "invalid_request", message: "body must be JSON" });
    }
    const parsed = TrustRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return serviceError(c, 400, {
        code: "invalid_request",
        message: "request body does not match TrustRequest",
        details: { issues: parsed.error.issues },
      });
    }
    return c.json(await deps.trust.trustSignal(parsed.data.merchant));
  });

  app.notFound((c) =>
    serviceError(c, 404, { code: "not_found", message: `no route: ${c.req.method} ${c.req.path}` }),
  );
  app.onError((_err, c) => {
    console.error("[northcinder-service] unhandled request error");
    return serviceError(c, 500, { code: "internal", message: "internal service error" });
  });

  return app;
}
