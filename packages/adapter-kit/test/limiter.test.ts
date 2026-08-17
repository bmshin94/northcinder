import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/index.js";

describe("mapWithConcurrency", () => {
  it("never exceeds the concurrency cap and preserves order", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });

  it("one task rejecting does not lose the others (settled results)", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(results[0]).toBe(1);
    expect(results[1]).toBeInstanceOf(Error);
    expect((results[1] as Error).message).toBe("boom");
    expect(results[2]).toBe(3);
  });
});
