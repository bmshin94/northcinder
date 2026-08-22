/**
 * Budgeted HTTP for adapters (global reliability constraint): every outbound
 * call gets a hard timeout, a bounded full-jitter retry on retryable
 * failures, and a response-body size cap (no unbounded buffers). Never
 * throws — resolves with a discriminated result.
 */
export type HttpResult =
  | { ok: true; status: number; bodyText: string; retryAfterMs?: number }
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

function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value.trim())) {
    const milliseconds = Number(value) * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

function waitForRetryAfter(delayMs: number, deadline: number, signal?: AbortSignal): Promise<"ready" | "timeout" | "aborted"> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve("timeout");
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    let delayTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: "ready" | "timeout" | "aborted") => {
      if (delayTimer !== undefined) clearTimeout(delayTimer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish("aborted");
    delayTimer = setTimeout(() => finish("ready"), delayMs);
    deadlineTimer = setTimeout(() => finish("timeout"), remaining);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForBodyCancellation(cancellation: Promise<void>, deadline: number, signal?: AbortSignal): Promise<"done" | "timeout" | "aborted"> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve("timeout");
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish("timeout"), remaining);
    const onAbort = () => finish("aborted");
    const finish = (outcome: "done" | "timeout" | "aborted") => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    cancellation.then(() => finish("done"), () => finish("done"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readBodyCapped(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string | null | undefined> {
  const body = response.body;
  if (!body) {
    if (signal?.aborted) return undefined;
    const text = await new Promise<string | undefined>((resolve) => {
      let settled = false;
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => finish(undefined);
      signal?.addEventListener("abort", onAbort, { once: true });
      response.text().then(finish, () => finish(undefined));
    });
    if (text === undefined) return undefined;
    return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (signal?.aborted) {
      void reader.cancel().catch(() => {});
      return undefined;
    }
    const next = await new Promise<ReadableStreamReadResult<Uint8Array> | undefined>((resolve) => {
      const onAbort = () => {
        void reader.cancel().catch(() => {});
        resolve(undefined);
      };
      reader.read().then(resolve, () => resolve(undefined)).finally(() => signal?.removeEventListener("abort", onAbort));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (next === undefined) return undefined;
    const { done, value } = next;
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

async function resultFromResponse(
  response: Response,
  maxBodyBytes: number,
  retryAfter: number | undefined,
  deadline: number,
  signal?: AbortSignal,
  preserveReceivedOnTimeout = false,
): Promise<HttpResult> {
  const readController = new AbortController();
  const bodyRead = readBodyCapped(response, maxBodyBytes, readController.signal)
    .then((bodyText) => ({ kind: "body" as const, bodyText }))
    .catch(() => ({ kind: "body" as const, bodyText: undefined }));
  const bounded = await new Promise<
    { kind: "body"; bodyText: string | null | undefined } | { kind: "timeout" | "aborted" }
  >((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: { kind: "body"; bodyText: string | null | undefined } | { kind: "timeout" | "aborted" }) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish({ kind: "aborted" });
    if (signal?.aborted) {
      finish({ kind: "aborted" });
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      finish({ kind: "timeout" });
      return;
    }
    timer = setTimeout(() => finish({ kind: "timeout" }), remaining);
    signal?.addEventListener("abort", onAbort, { once: true });
    bodyRead.then(finish);
  });
  if (bounded.kind !== "body") {
    readController.abort();
    if (bounded.kind === "aborted") return { ok: false, kind: "aborted" };
    return preserveReceivedOnTimeout
      ? { ok: true, status: response.status, bodyText: "", ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) }
      : { ok: false, kind: "timeout" };
  }
  const bodyText = bounded.bodyText;
  if (bodyText === undefined) {
    if (signal?.aborted) return { ok: false, kind: "aborted" };
    return { ok: true, status: response.status, bodyText: "", ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) };
  }
  return bodyText === null
    ? { ok: false, kind: "too_large" }
    : { ok: true, status: response.status, bodyText, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) };
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
      const responseRetryAfterMs = retryAfterMs(response.headers.get("retry-after"));
      const remainingAfterResponse = deadline - Date.now();
      const retryDelay = responseRetryAfterMs ?? Math.min(Math.random() * 200 * (attempt + 1), Math.max(0, remainingAfterResponse) / 4);
      if (RETRYABLE_STATUS.has(response.status) && attempt < retries && retryDelay <= remainingAfterResponse) {
        const preservedResponse = response.clone();
        const preservedResult = resultFromResponse(preservedResponse, maxBodyBytes, responseRetryAfterMs, deadline, options.signal, true)
          .catch((): HttpResult => ({ ok: false, kind: "network" }));
        const cancellation = response.body?.cancel();
        if (cancellation !== undefined) {
          const cancelled = await waitForBodyCancellation(cancellation, deadline, options.signal);
          if (cancelled === "aborted") outcome = { ok: false, kind: "aborted" };
          else if (cancelled === "timeout" || retryDelay > deadline - Date.now()) {
            outcome = await preservedResult;
          } else {
            const waited = await waitForRetryAfter(retryDelay, deadline, options.signal);
            outcome = waited === "ready"
              ? "retry"
              : waited === "aborted"
                ? { ok: false, kind: "aborted" }
                : await preservedResult;
          }
        } else {
          const waited = await waitForRetryAfter(retryDelay, deadline, options.signal);
          outcome = waited === "ready"
            ? "retry"
            : waited === "aborted"
              ? { ok: false, kind: "aborted" }
              : await preservedResult;
        }
      } else {
        const preserveReceivedOnTimeout = RETRYABLE_STATUS.has(response.status)
          && attempt < retries
          && retryDelay > remainingAfterResponse;
        outcome = await resultFromResponse(
          response,
          maxBodyBytes,
          responseRetryAfterMs,
          deadline,
          options.signal,
          preserveReceivedOnTimeout,
        );
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
  }
  return { ok: false, kind: "network" };
}
