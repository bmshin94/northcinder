import { describe, expect, it } from "vitest";
import { createTokenBucketLimiter } from "../src/rate-limiter.js";

describe("createTokenBucketLimiter", () => {
  it("allows requests up to capacity, then rejects", () => {
    let now = 1_000_000;
    const limiter = createTokenBucketLimiter({ capacity: 3, refillPerSec: 1, now: () => now });
    expect(limiter.tryConsume("client-a")).toEqual({ ok: true, remaining: 2 });
    expect(limiter.tryConsume("client-a")).toEqual({ ok: true, remaining: 1 });
    expect(limiter.tryConsume("client-a")).toEqual({ ok: true, remaining: 0 });
    const rejected = limiter.tryConsume("client-a");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("refills over time at the configured rate", () => {
    let now = 0;
    const limiter = createTokenBucketLimiter({ capacity: 2, refillPerSec: 1, now: () => now });
    expect(limiter.tryConsume("client-b").ok).toBe(true);
    expect(limiter.tryConsume("client-b").ok).toBe(true);
    expect(limiter.tryConsume("client-b").ok).toBe(false);
    now += 1_000; // 1 second later — one token refilled
    const afterRefill = limiter.tryConsume("client-b");
    expect(afterRefill).toEqual({ ok: true, remaining: 0 });
  });

  it("tracks separate buckets per key — one client's usage never affects another's", () => {
    let now = 0;
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSec: 1, now: () => now });
    expect(limiter.tryConsume("client-a").ok).toBe(true);
    expect(limiter.tryConsume("client-a").ok).toBe(false);
    expect(limiter.tryConsume("client-b").ok).toBe(true);
  });

  it("never exceeds capacity even after a long idle period", () => {
    let now = 0;
    const limiter = createTokenBucketLimiter({ capacity: 2, refillPerSec: 1, now: () => now });
    expect(limiter.tryConsume("client-a").ok).toBe(true);
    now += 1_000_000; // long idle — bucket must cap at capacity, not overflow
    expect(limiter.tryConsume("client-a")).toEqual({ ok: true, remaining: 1 });
  });
});
