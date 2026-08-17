import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Offer, Watch } from "@northcinder/protocol";
import { createWatchStore, WATCHES_FILENAME } from "../src/index.js";

const OFFER: Offer = {
  id: "off-1",
  product: { id: "p-1", title: "Fairphone 5 128GB", url: "https://shop.example/p1", attributes: { storage: "128GB" } },
  price: { amount: 59900, currency: "EUR" },
  merchant: { id: "shop.example", name: "Shop", domain: "shop.example" },
  availability: "in_stock",
  sourceStore: "reference",
  sponsored: false,
};

const OBSERVED_OFFER: Offer = {
  ...OFFER,
  product: { ...OFFER.product, url: "https://observed-shop.example/products/fairphone-5" },
  sourceStore: "agent_browser",
};

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "northcinder-watches-store-"));
}

describe("watch store (0600 local persistence)", () => {
  it("create persists a watch with defaults: active, stderr channel, expiry = createdAt + 183 days", () => {
    const now = new Date("2026-07-05T00:00:00.000Z");
    const store = createWatchStore({ configDir: freshDir(), now: () => now });
    const watch = store.create({
      name: "Fairphone below 550",
      target: { kind: "offer", offer: OFFER },
      targetPrice: { amount: 55000, currency: "EUR" },
    });
    expect(watch.state).toBe("active");
    expect(watch.channel).toEqual({ type: "stderr" });
    expect(watch.createdAt).toBe("2026-07-05T00:00:00.000Z");
    expect(watch.expiresAt).toBe(new Date(now.getTime() + 183 * 24 * 60 * 60 * 1000).toISOString());
    expect(watch.notifiedBuckets).toEqual([]);
    expect(store.get(watch.id)?.name).toBe("Fairphone below 550");
  });

  it("the watches file is created 0600 (channel topics are bearer secrets)", () => {
    const dir = freshDir();
    const store = createWatchStore({ configDir: dir });
    store.create({
      name: "n",
      target: { kind: "query", query: { text: "fairphone" } },
      targetPrice: { amount: 55000, currency: "EUR" },
      channel: { type: "ntfy", topic: "long-random-topic" },
    });
    const mode = statSync(join(dir, WATCHES_FILENAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("watches survive a restart (a fresh store instance over the same dir lists them)", () => {
    const dir = freshDir();
    const first = createWatchStore({ configDir: dir });
    const watch = first.create({
      name: "persisted",
      target: { kind: "query", query: { text: "usb hub" } },
      targetPrice: { amount: 2000, currency: "EUR" },
    });
    const second = createWatchStore({ configDir: dir });
    expect(second.list().map((w) => w.id)).toEqual([watch.id]);
    expect(second.get(watch.id)?.targetPrice).toEqual({ amount: 2000, currency: "EUR" });
  });

  it("rejects an agent-observed offer before creating persistence", () => {
    const dir = freshDir();
    const store = createWatchStore({ configDir: dir });
    const productUrl = OBSERVED_OFFER.product.url;

    expect(() =>
      store.create({
        name: "Observed Fairphone below 550",
        target: { kind: "offer", offer: OBSERVED_OFFER },
        targetPrice: { amount: 55000, currency: "EUR" },
      }),
    ).toThrow(new RegExp(`native_revalidation_required.*${productUrl.replaceAll("/", "\\/")}`));
    expect(existsSync(join(dir, WATCHES_FILENAME))).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("fails closed when a legacy persisted record targets an agent-observed offer", () => {
    const dir = freshDir();
    const persisted: Watch = {
      id: "watch_observed_legacy",
      name: "Legacy observed Fairphone",
      target: { kind: "offer", offer: OBSERVED_OFFER },
      targetPrice: { amount: 55000, currency: "EUR" },
      mustHaveAttributes: [],
      channel: { type: "stderr" },
      createdAt: "2026-08-16T10:02:00.000Z",
      expiresAt: "2027-02-15T10:02:00.000Z",
      state: "active",
      notifiedBuckets: [],
    };
    writeFileSync(
      join(dir, WATCHES_FILENAME),
      `${JSON.stringify({ version: 1, watches: [persisted] })}\n`,
      { mode: 0o600 },
    );

    expect(() => createWatchStore({ configDir: dir }).list()).toThrow(
      /does not match the watch schema.*agent_browser offers require agent_observed acquisition provenance.*refusing to touch it/,
    );
  });

  it("cancel voids an active watch; cancelling again reports not_active; unknown ids report not_found", () => {
    const store = createWatchStore({ configDir: freshDir() });
    const watch = store.create({
      name: "c",
      target: { kind: "query", query: { text: "x" } },
      targetPrice: { amount: 100, currency: "USD" },
    });
    const outcome = store.cancel(watch.id);
    expect(outcome).toMatchObject({ ok: true });
    expect(store.get(watch.id)?.state).toBe("cancelled");
    expect(store.cancel(watch.id)).toEqual({ ok: false, reason: "not_active" });
    expect(store.cancel("watch_nope")).toEqual({ ok: false, reason: "not_found" });
  });

  it("update persists scheduler state (lastCheckedAt/lastPrice/notifiedBuckets) across instances", () => {
    const dir = freshDir();
    const store = createWatchStore({ configDir: dir });
    const watch = store.create({
      name: "u",
      target: { kind: "query", query: { text: "x" } },
      targetPrice: { amount: 100, currency: "USD" },
    });
    store.update(watch.id, {
      lastCheckedAt: "2026-07-05T02:00:00.000Z",
      lastPrice: { amount: 90, currency: "USD" },
      notifiedBuckets: ["USD:90"],
      lastStatus: { ok: true, outcome: "target_hit_notified" },
    });
    const reloaded = createWatchStore({ configDir: dir }).get(watch.id);
    expect(reloaded?.lastCheckedAt).toBe("2026-07-05T02:00:00.000Z");
    expect(reloaded?.lastPrice).toEqual({ amount: 90, currency: "USD" });
    expect(reloaded?.notifiedBuckets).toEqual(["USD:90"]);
    expect(reloaded?.lastStatus).toEqual({ ok: true, outcome: "target_hit_notified" });
  });

  it("fails CLOSED on a corrupt watches file (never silently drops watches)", () => {
    const dir = freshDir();
    writeFileSync(join(dir, WATCHES_FILENAME), "{not json", { mode: 0o600 });
    const store = createWatchStore({ configDir: dir });
    expect(() => store.list()).toThrow(/not valid JSON/);
  });

  it("rejects a watch expiring in the past relative to creation", () => {
    const store = createWatchStore({ configDir: freshDir(), now: () => new Date("2026-07-05T00:00:00.000Z") });
    expect(() =>
      store.create({
        name: "past",
        target: { kind: "query", query: { text: "x" } },
        targetPrice: { amount: 100, currency: "USD" },
        expiresAt: "2026-07-04T00:00:00.000Z",
      }),
    ).toThrow(/expiresAt/);
  });

  it("file content never contains checkout/mandate vocabulary (watches only notify)", () => {
    const dir = freshDir();
    const store = createWatchStore({ configDir: dir });
    store.create({
      name: "clean",
      target: { kind: "offer", offer: OFFER },
      targetPrice: { amount: 100, currency: "EUR" },
    });
    const raw = readFileSync(join(dir, WATCHES_FILENAME), "utf8");
    expect(raw).not.toMatch(/mandate|checkout/i);
  });
});
