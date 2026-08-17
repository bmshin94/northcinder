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
  TrustResponseSchema,
  type Merchant,
  type SearchQuery,
  type SearchRankResponse,
  type TrustSignal,
} from "@northcinder/protocol";
import { BRAND_NAME } from "./brand.js";

export type ServiceCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export interface NorthCinderServiceClient {
  search(
    query: SearchQuery,
    options?: { browserObservations?: unknown[] },
  ): Promise<ServiceCallResult<SearchRankResponse>>;
  trust(merchant: Merchant): Promise<ServiceCallResult<TrustSignal>>;
}

export interface ServiceClientOptions {
  serviceUrl: string;
  clientKey: string;
  /** Hard budget per call (default 20000ms — live multi-store fan-outs are slow). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createServiceClient(options: ServiceClientOptions): NorthCinderServiceClient {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const base = options.serviceUrl.replace(/\/$/, "");

  async function post<T>(
    path: string,
    body: unknown,
    schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } },
  ): Promise<ServiceCallResult<T>> {
    const result = await fetchWithBudget(
      `${base}${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.clientKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      { timeoutMs, ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) },
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
