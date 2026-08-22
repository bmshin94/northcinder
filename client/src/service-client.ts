/**
 * HTTP client for the buyer-run NorthCinder engine (the open client↔engine
 * protocol, spec §2). Every response body is validated against the SHARED
 * protocol schemas — the client never trusts the configured engine blindly, which is
 * exactly what lets a user diff the deployed ranking against the open one.
 *
 * Reliability backbone: every call goes through fetchWithBudget (hard
 * timeout, bounded retry, body cap) and resolves with a structured result —
 * never a throw.
 */
import { fetchWithBudget } from "@northcinder/adapter-kit";
import {
  SearchRankResponseSchema,
  GetOfferResponseSchema,
  type Offer,
  TrustResponseSchema,
  type Merchant,
  type SearchQuery,
  type SearchRankResponse,
  type TrustSignal,
} from "@northcinder/protocol";
import { BRAND_NAME } from "./brand.js";

export type ServiceCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryAfterMs?: number; store?: string; retryable?: boolean; details?: Record<string, unknown> } };

export interface NorthCinderServiceClient {
  health(): Promise<ServiceCallResult<ServiceHealth>>;
  search(
    query: SearchQuery,
    options?: { browserObservations?: unknown[] },
  ): Promise<ServiceCallResult<SearchRankResponse>>;
  trust(merchant: Merchant): Promise<ServiceCallResult<TrustSignal>>;
  getOffer(store: string, offerId: string): Promise<ServiceCallResult<Offer>>;
}

export type DiscoverySourceStatus = "ready" | "not_configured" | "invalid_configuration";

export interface ServiceHealth {
  ok: true;
  service: "northcinder";
  version: string;
  discoverySources?: Array<{ store: string; status: DiscoverySourceStatus }>;
}

export interface ServiceClientOptions {
  serviceUrl: string;
  clientKey?: string;
  /** Hard budget per call (default 20000ms — live multi-store fan-outs are slow). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createServiceClient(options: ServiceClientOptions): NorthCinderServiceClient {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const base = options.serviceUrl.replace(/\/$/, "");

  const authorizationHeaders = (): Record<string, string> =>
    options.clientKey ? { authorization: `Bearer ${options.clientKey}` } : {};

  async function post<T>(
    path: string,
    body: unknown,
    schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } },
  ): Promise<ServiceCallResult<T>> {
    const headers = {
      "content-type": "application/json",
      ...authorizationHeaders(),
    };
    const result = await fetchWithBudget(
      `${base}${path}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      { timeoutMs, retries: 0, ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) },
    );
    if (!result.ok) {
      return {
        ok: false,
        error: { code: "service_unreachable", message: `configured ${BRAND_NAME} engine unavailable` },
      };
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(result.bodyText);
    } catch {
      return { ok: false, error: { code: "invalid_service_response", message: "configured engine returned non-JSON" } };
    }
    if (result.status >= 400) {
      return {
        ok: false,
        error: {
          code: "service_error",
          message: `configured ${BRAND_NAME} engine error (HTTP ${result.status})`,
          ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
        },
      };
    }
    const validated = schema.safeParse(parsedBody);
    if (!validated.success) {
      return {
        ok: false,
        error: {
          code: "invalid_service_response",
          message: `configured engine response violates the protocol schema: ${validated.error.issues[0]?.message ?? "invalid"}`,
        },
      };
    }
    return { ok: true, data: validated.data };
  }

  return {
    async health() {
      const result = await fetchWithBudget(
        `${base}/health`,
        { method: "GET", headers: authorizationHeaders() },
        { timeoutMs, ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) },
      );
      if (!result.ok) {
        return {
          ok: false,
          error: { code: "service_unreachable", message: `configured ${BRAND_NAME} engine unavailable` },
        };
      }
      let body: unknown;
      try {
        body = JSON.parse(result.bodyText);
      } catch {
        return { ok: false, error: { code: "invalid_service_response", message: "configured engine returned non-JSON" } };
      }
      const candidate = body as Partial<ServiceHealth> | null;
      const statuses = candidate?.discoverySources;
      if (
        result.status >= 400 ||
        candidate?.ok !== true ||
        candidate.service !== "northcinder" ||
        typeof candidate.version !== "string" ||
        (statuses !== undefined &&
          (!Array.isArray(statuses) ||
            !statuses.every(
              (entry) =>
                typeof entry === "object" &&
                entry !== null &&
                typeof entry.store === "string" &&
                ["ready", "not_configured", "invalid_configuration"].includes(entry.status),
            )))
      ) {
        return {
          ok: false,
          error: { code: "invalid_service_response", message: "configured engine health response is invalid" },
        };
      }
      return { ok: true, data: candidate as ServiceHealth };
    },
    async getOffer(store, offerId) {
      const result = await post("/v1/offer", { store, offerId }, GetOfferResponseSchema);
      if (!result.ok) return result;
      if (result.data.ok) return { ok: true, data: result.data.offer };
      return {
        ok: false,
        error: {
          code: result.data.error.code,
          message: result.data.error.message,
          ...(result.data.error.retryAfterMs !== undefined ? { retryAfterMs: result.data.error.retryAfterMs } : {}),
          store: result.data.error.store,
          retryable: result.data.error.retryable,
          ...(result.data.error.details !== undefined ? { details: result.data.error.details } : {}),
        },
      };
    },
    search: (query, searchOptions) =>
      post(
        "/v1/search",
        {
          query,
          ...(searchOptions?.browserObservations !== undefined
            ? { browserObservations: searchOptions.browserObservations }
            : {}),
        },
        SearchRankResponseSchema,
      ),
    trust: (merchant) => post("/v1/trust", { merchant }, TrustResponseSchema),
  };
}
