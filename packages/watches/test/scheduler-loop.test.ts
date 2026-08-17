import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Offer } from "@northcinder/protocol";
import { createWatchStore, runWatchesLoop, type OfferSource, type WatchRunSummary } from "../src/index.js";

const OFFER: Offer = {
  id: "off-1",
  product: { id: "p-1", title: "Fairphone 5 128GB", url: "https://shop.example/p1", attributes: {} },
  price: { amount: 59900, currency: "EUR" },
  merchant: { id: "shop.example", name: "Shop", domain: "shop.example" },
  availability: "in_stock",
  sourceStore: "reference",
  sponsored: false,
};

describe("interval loop (long-running mode of the northcinder-watch bin)", () => {
  it("ticks repeatedly at the interval and stops cleanly on abort", async () => {
    const dir = mkdtempSync(join(tmpdir(), "northcinder-watches-loop-"));
    const store = createWatchStore({ configDir: dir });
    store.create({
      name: "loop watch",
      target: { kind: "offer", offer: OFFER },
      targetPrice: { amount: 100, currency: "EUR" },
    });
    let searches = 0;
    const source: OfferSource = {
      async search() {
        searches += 1;
        return { ok: true, offers: [OFFER] };
      },
    };
    const summaries: WatchRunSummary[] = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 120);
    await runWatchesLoop(
      {
        store,
        source,
        notifierFor: () => ({ id: "noop", send: async () => ({ ok: true }) }),
      },
      { intervalMs: 25, signal: controller.signal, onTick: (s) => summaries.push(s) },
    );
    // First tick is immediate, then every 25ms until the 120ms abort.
    expect(searches).toBeGreaterThanOrEqual(3);
    expect(summaries.length).toBe(searches);
    expect(summaries[0]!.reports[0]).toMatchObject({ outcome: "above_target" });
  });
});
