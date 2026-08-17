/**
 * Simple per-key token bucket rate limiter for the remote MCP bridge.
 *
 * Each API-key client gets its own bucket (capacity tokens, refilled
 * continuously at refillPerSec). Pure, deterministic given an injectable
 * clock — no timers, no I/O — so it is trivially unit-testable and cheap to
 * run inline on every request.
 */

export interface TokenBucketLimiterOptions {
  /** Max tokens (= max burst requests) a single key can hold. */
  capacity: number;
  /** Tokens restored per second. */
  refillPerSec: number;
  /** Injectable clock (ms since epoch) — defaults to Date.now. */
  now?: () => number;
}

export type ConsumeResult = { ok: true; remaining: number } | { ok: false; retryAfterMs: number };

export interface TokenBucketLimiter {
  tryConsume(key: string, cost?: number): ConsumeResult;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export function createTokenBucketLimiter(options: TokenBucketLimiterOptions): TokenBucketLimiter {
  const { capacity, refillPerSec } = options;
  if (!Number.isFinite(capacity) || capacity <= 0) throw new RangeError("capacity must be a positive number");
  if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) throw new RangeError("refillPerSec must be a positive number");
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, BucketState>();

  function refill(state: BucketState, nowMs: number): void {
    const elapsedSec = Math.max(0, (nowMs - state.lastRefillMs) / 1000);
    if (elapsedSec > 0) {
      state.tokens = Math.min(capacity, state.tokens + elapsedSec * refillPerSec);
      state.lastRefillMs = nowMs;
    }
  }

  return {
    tryConsume(key: string, cost = 1): ConsumeResult {
      const nowMs = now();
      let state = buckets.get(key);
      if (!state) {
        state = { tokens: capacity, lastRefillMs: nowMs };
        buckets.set(key, state);
      }
      refill(state, nowMs);
      if (state.tokens >= cost) {
        state.tokens -= cost;
        return { ok: true, remaining: Math.floor(state.tokens) };
      }
      const deficitTokens = cost - state.tokens;
      const retryAfterMs = Math.ceil((deficitTokens / refillPerSec) * 1000);
      return { ok: false, retryAfterMs };
    },
  };
}
