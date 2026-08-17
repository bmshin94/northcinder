/**
 * Budgeted HTTP for adapters (global reliability constraint): every outbound
 * call gets a hard timeout, a bounded full-jitter retry on retryable
 * failures, and a response-body size cap (no unbounded buffers). Never
 * throws — resolves with a discriminated result.
 */
export type HttpResult =
  | { ok: true; status: number; bodyText: string }
  | { ok: false; kind: "timeout" | "network" | "too_large" | "aborted" };

export interface FetchBudgetOptions {
  /** Hard budget for the whole call including retries, in ms. */
  timeoutMs: number;
  /** Cooperative external cancellation. */
  signal?: AbortSignal;
  /** Bounded retry count on retryable failures (default 1). */
  retries?: number;
  /** Response body cap in bytes (default 2 MiB). */
  maxBodyBytes?: number;
  /** Injectable fetch (tests / instrumentation). */
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DEFAULT_MAX_BODY = 2 * 1024 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string | null> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function fetchWithBudget(
  url: string,
  init: RequestInit,
  options: FetchBudgetOptions,
): Promise<HttpResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 1;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const deadline = Date.now() + options.timeoutMs;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, kind: "timeout" };
    if (options.signal?.aborted) return { ok: false, kind: "aborted" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("northcinder: budget exhausted")), remaining);
    const onExternalAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });

    let outcome: HttpResult | "retry";
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (RETRYABLE_STATUS.has(response.status) && attempt < retries && deadline - Date.now() > 100) {
        await response.body?.cancel().catch(() => {});
        outcome = "retry";
      } else {
        const bodyText = await readBodyCapped(response, maxBodyBytes);
        outcome = bodyText === null ? { ok: false, kind: "too_large" } : { ok: true, status: response.status, bodyText };
      }
    } catch {
      if (options.signal?.aborted) outcome = { ok: false, kind: "aborted" };
      else if (controller.signal.aborted) outcome = { ok: false, kind: "timeout" };
      else if (attempt < retries && deadline - Date.now() > 100) outcome = "retry";
      else outcome = { ok: false, kind: "network" };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }

    if (outcome !== "retry") return outcome;
    // Bounded full-jitter backoff, capped so it never eats the whole budget.
    const backoff = Math.min(Math.random() * 200 * (attempt + 1), Math.max(0, deadline - Date.now()) / 4);
    await sleep(backoff);
  }
  return { ok: false, kind: "network" };
}
