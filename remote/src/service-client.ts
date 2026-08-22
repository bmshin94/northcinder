/**
 * HTTP client for the deployer's NorthCinder engine, used by the remote MCP bridge.
 *
 * Deliberately mirrors client/src/service-client.ts (the stdio client's
 * upstream connector) line for line in shape: same discriminated result type,
 * same schema validation on every response (the remote bridge never trusts
 * the engine blindly either), same fetchWithBudget reliability backbone.
 * Duplicated rather than imported because the two packages are independent
 * deployables (stdio client vs. self-hosted HTTP bridge) with no reason to share a
 * runtime dependency edge — see remote/README.md.
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

export type ServiceCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryAfterMs?: number } };

export interface NorthCinderServiceClient {
  search(query: SearchQuery): Promise<ServiceCallResult<SearchRankResponse>>;
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
      { timeoutMs, retries: 0, ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) },
    );
    if (!result.ok) {
      return {
        ok: false,
        error: { code: "service_unreachable", message: "configured NorthCinder engine unavailable" },
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
          message: `configured NorthCinder engine error (HTTP ${result.status})`,
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
    search: (query) => post("/v1/search", { query }, SearchRankResponseSchema),
    trust: (merchant) => post("/v1/trust", { merchant }, TrustResponseSchema),
  };
}
