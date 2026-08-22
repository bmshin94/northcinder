import { describe, expect, it } from "vitest";
import {
  WatchChannelSchema,
  WatchSchema,
  WatchTargetSchema,
  WATCH_DEFAULT_TTL_DAYS,
  type Watch,
} from "../src/index.js";

const OFFER = {
  id: "off-1",
  product: { id: "p-1", title: "Fairphone 5 128GB", url: "https://shop.example/p1", attributes: { storage: "128GB" } },
  price: { amount: 59900, currency: "EUR" },
  merchant: { id: "shop.example", name: "Shop", domain: "shop.example" },
  availability: "in_stock" as const,
  sourceStore: "reference",
  sponsored: false,
};

const BASE: Watch = {
  id: "watch_1",
  name: "Fairphone below 550",
  target: { kind: "offer", offer: OFFER },
  targetPrice: { amount: 55000, currency: "EUR" },
  mustHaveAttributes: [],
  channel: { type: "stderr" },
  createdAt: "2026-07-05T00:00:00.000Z",
  expiresAt: "2027-01-04T00:00:00.000Z",
  state: "active",
  notifiedBuckets: [],
};

describe("watch schemas (watch)", () => {
  it("accepts a complete offer-target watch and defaults notifiedBuckets/mustHaveAttributes", () => {
    const { notifiedBuckets, mustHaveAttributes, ...rest } = BASE;
    const parsed = WatchSchema.parse(rest);
    expect(parsed.notifiedBuckets).toEqual([]);
    expect(parsed.mustHaveAttributes).toEqual([]);
    expect(parsed.state).toBe("active");
  });

  it("accepts a query-target watch with persisted scheduler state", () => {
    const parsed = WatchSchema.parse({
      ...BASE,
      target: { kind: "query", query: { text: "fairphone 5 128GB" } },
      lastCheckedAt: "2026-07-05T01:00:00.000Z",
      lastPrice: { amount: 58900, currency: "EUR" },
      lastStatus: { ok: true, outcome: "above_target" },
      lastSuccessAt: "2026-07-05T01:00:00.000Z",
      lastFailureAt: "2026-07-05T00:30:00.000Z",
      nextEligibleCheckAt: "2026-07-05T02:00:00.000Z",
      notifiedBuckets: ["EUR:99"],
    });
    expect(parsed.lastPrice).toEqual({ amount: 58900, currency: "EUR" });
    expect(parsed.notifiedBuckets).toEqual(["EUR:99"]);
    expect(parsed.nextEligibleCheckAt).toBe("2026-07-05T02:00:00.000Z");
  });

  it("rejects agent-observed offer targets until a native store connection revalidates them", () => {
    const productUrl = "https://observed-shop.example/products/fairphone-5";
    const target = {
      kind: "offer" as const,
      offer: {
        ...OFFER,
        product: { ...OFFER.product, url: productUrl },
        sourceStore: "agent_browser",
        acquisition: {
          kind: "agent_observed" as const,
          observedAt: "2026-08-16T10:00:00.000Z",
          receivedAt: "2026-08-16T10:01:00.000Z",
          placement: "organic" as const,
        },
      },
    };

    for (const result of [
      WatchTargetSchema.safeParse(target),
      WatchSchema.safeParse({ ...BASE, target }),
    ]) {
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("native_revalidation_required");
        expect(result.error.issues[0]?.message).toContain(productUrl);
      }
    }
  });

  it("rejects a watch without a target price (a watch must state what counts as a hit)", () => {
    const { targetPrice, ...rest } = BASE;
    expect(WatchSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects float money in targetPrice (protocol law: integer minor units)", () => {
    expect(WatchSchema.safeParse({ ...BASE, targetPrice: { amount: 549.99, currency: "EUR" } }).success).toBe(false);
  });

  it("channel: rejects a webhook without a URL and an ntfy topic under 8 chars", () => {
    expect(WatchChannelSchema.safeParse({ type: "webhook" }).success).toBe(false);
    expect(WatchChannelSchema.safeParse({ type: "ntfy", topic: "short" }).success).toBe(false);
    expect(WatchChannelSchema.safeParse({ type: "ntfy" }).success).toBe(true);
  });

  it("default TTL constant is ~6 months", () => {
    expect(WATCH_DEFAULT_TTL_DAYS).toBe(183);
  });

  it("rejects an unknown state (no silent watch resurrection states)", () => {
    expect(WatchSchema.safeParse({ ...BASE, state: "paused" }).success).toBe(false);
  });
});
