import { describe, expect, it } from "vitest";
import { fetchWithBudget } from "../src/index.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchWithBudget", () => {
  it("returns the body of a successful response", async () => {
    const result = await fetchWithBudget(
      "https://example.invalid/ok",
      { method: "POST", body: "{}" },
      { timeoutMs: 500, fetchImpl: async () => jsonResponse(200, { hello: "world" }) },
    );
    expect(result).toEqual({ ok: true, status: 200, bodyText: '{"hello":"world"}' });
  });

  it("resolves with a structured timeout when the server hangs (never hangs itself)", async () => {
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const started = Date.now();
    const result = await fetchWithBudget("https://example.invalid/hang", {}, {
      timeoutMs: 120,
      fetchImpl: hangingFetch,
    });
    expect(result).toEqual({ ok: false, kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("times out a final 200 whose response body never closes", async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} });
    const pending = fetchWithBudget("https://example.invalid/stalled-body", {}, {
      timeoutMs: 60,
      retries: 0,
      fetchImpl: async () => new Response(body, { status: 200 }),
    });
    const result = await Promise.race([pending, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 250))]);
    expect(result).toEqual({ ok: false, kind: "timeout" });
  });

  it("preserves a received 429 and Retry-After when its stalled body consumes the no-retry budget", async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} });
    const pending = fetchWithBudget("https://example.invalid/stalled-rate-limit", {}, {
      timeoutMs: 60,
      retries: 1,
      fetchImpl: async () => new Response(body, { status: 429, headers: { "Retry-After": "2" } }),
    });
    const result = await Promise.race([pending, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 250))]);
    expect(result).toEqual({ ok: true, status: 429, bodyText: "", retryAfterMs: 2_000 });
  });

  it("returns aborted promptly when the caller aborts during a final response body read", async () => {
    const aborter = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start() {} });
    const pending = fetchWithBudget("https://example.invalid/aborted-body", {}, {
      timeoutMs: 3_000,
      retries: 0,
      signal: aborter.signal,
      fetchImpl: async () => new Response(body, { status: 200 }),
    });
    setTimeout(() => aborter.abort(new Error("caller canceled")), 25);
    const result = await Promise.race([pending, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 250))]);
    expect(result).toEqual({ ok: false, kind: "aborted" });
  });

  it("retries a retryable status once with jitter, bounded by budget", async () => {
    let calls = 0;
    const result = await fetchWithBudget("https://example.invalid/flaky", {}, {
      timeoutMs: 2000,
      retries: 1,
      fetchImpl: async () => (++calls === 1 ? jsonResponse(503, {}) : jsonResponse(200, { fine: true })),
    });
    expect(calls).toBe(2);
    expect(result).toEqual({ ok: true, status: 200, bodyText: '{"fine":true}' });
  });

  it("parses Retry-After and honors it before an explicit retry", async () => {
    let calls = 0;
    const started = Date.now();
    const result = await fetchWithBudget("https://example.invalid/rate-limited", {}, {
      timeoutMs: 1_500,
      retries: 1,
      fetchImpl: async () => (++calls === 1
        ? new Response("{}", { status: 429, headers: { "Retry-After": "1" } })
        : new Response("{}", { status: 200 })),
    });
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  it("returns a retryable response and its delay when Retry-After exceeds the remaining budget", async () => {
    let calls = 0;
    const result = await fetchWithBudget("https://example.invalid/rate-limited", {}, {
      timeoutMs: 50,
      retries: 1,
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status: 429, headers: { "Retry-After": "2" } });
      },
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: true, status: 429, retryAfterMs: 2_000 });
  });

  it("returns the received 429 when body cancellation leaves too little budget for Retry-After", async () => {
    let calls = 0;
    const delayedCancellationBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("provider is rate limited"));
        setTimeout(() => controller.close(), 150);
      },
    });
    const delayedCancellationResponse = new Response(delayedCancellationBody, { status: 429, headers: { "Retry-After": "1" } });
    const result = await fetchWithBudget("https://example.invalid/rate-limited", {}, {
      timeoutMs: 1_100,
      retries: 1,
      fetchImpl: async () => {
        calls += 1;
        return delayedCancellationResponse;
      },
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      status: 429,
      retryAfterMs: 1_000,
      bodyText: "provider is rate limited",
    });
  });

  it("returns the received 429 by its deadline when the preserved body never closes", async () => {
    const neverClosingBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial provider payload"));
      },
    });
    const started = Date.now();
    const result = await fetchWithBudget("https://example.invalid/rate-limited", {}, {
      timeoutMs: 1_100,
      retries: 1,
      fetchImpl: async () => new Response(neverClosingBody, { status: 429, headers: { "Retry-After": "1" } }),
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(result).toMatchObject({ ok: true, status: 429, retryAfterMs: 1_000 });
  }, 2_500);

  it("returns aborted promptly when the caller aborts during a Retry-After wait", async () => {
    const aborter = new AbortController();
    const started = Date.now();
    const pending = fetchWithBudget("https://example.invalid/rate-limited", {}, {
      timeoutMs: 3_000,
      retries: 1,
      signal: aborter.signal,
      fetchImpl: async () => new Response("{}", { status: 429, headers: { "Retry-After": "2" } }),
    });
    setTimeout(() => aborter.abort(new Error("caller canceled")), 25);
    await expect(pending).resolves.toEqual({ ok: false, kind: "aborted" });
    expect(Date.now() - started).toBeLessThan(300);
  });

  it("does not retry beyond the bound", async () => {
    let calls = 0;
    const result = await fetchWithBudget("https://example.invalid/down", {}, {
      timeoutMs: 2000,
      retries: 1,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(503, {});
      },
    });
    expect(calls).toBe(2);
    expect(result).toEqual({ ok: true, status: 503, bodyText: "{}" });
  });

  it("retries a network error and reports it structurally when persistent", async () => {
    let calls = 0;
    const result = await fetchWithBudget("https://example.invalid/refused", {}, {
      timeoutMs: 2000,
      retries: 1,
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      },
    });
    expect(calls).toBe(2);
    expect(result).toEqual({ ok: false, kind: "network" });
  });

  it("caps the response body size (no unbounded buffers)", async () => {
    const big = "x".repeat(64 * 1024);
    const result = await fetchWithBudget("https://example.invalid/huge", {}, {
      timeoutMs: 1000,
      maxBodyBytes: 1024,
      fetchImpl: async () => new Response(big, { status: 200 }),
    });
    expect(result).toEqual({ ok: false, kind: "too_large" });
  });
});
