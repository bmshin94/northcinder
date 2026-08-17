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
