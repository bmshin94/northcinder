import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createShopifyAdapter } from "@northcinder/adapter-shopify";
import { createWoocommerceAdapter } from "../../adapters/woocommerce/src/index.js";
import type { StoreAdapter } from "@northcinder/protocol";
import { createApp, createOrchestrator, createSeedTrustProvider } from "@northcinder/service";
import { createWatchStore, runWatchesOnce, type WatchRunSummary } from "@northcinder/watches";
import { createServiceClient } from "../src/service-client.js";
import { createAdapterOfferSource, createChannelNotifierFor, createServiceOfferSource, watchRunExitCode } from "../src/watch-runner.js";

function summary(outcomes: Array<{ outcome: string; error?: { code: string; message: string } }>): WatchRunSummary {
  return {
    checkedAt: "2026-07-05T12:00:00.000Z",
    total: outcomes.length,
    reports: outcomes.map((o, i) => ({
      watchId: `watch_${i}`,
      name: `w${i}`,
      outcome: o.outcome as WatchRunSummary["reports"][number]["outcome"],
      ...(o.error !== undefined ? { error: o.error } : {}),
    })),
  };
}

describe("northcinder-watch --once exit code (cron must SEE a fully-failed tick)", () => {
  it("exits 1 when EVERY check failed (source_error / notify_failed)", () => {
    expect(
      watchRunExitCode(
        summary([
          { outcome: "source_error", error: { code: "service_unreachable", message: "down" } },
          { outcome: "notify_failed", error: { code: "ntfy_http_error", message: "HTTP 500" } },
        ]),
      ),
    ).toBe(1);
  });

  it("exits 0 when at least one check succeeded (partial failure is a normal, reported state)", () => {
    expect(
      watchRunExitCode(
        summary([
          { outcome: "source_error", error: { code: "service_unreachable", message: "down" } },
          { outcome: "above_target" },
        ]),
      ),
    ).toBe(0);
  });

  it("exits 0 on an all-healthy tick and on a tick with no active watches", () => {
    expect(watchRunExitCode(summary([{ outcome: "target_hit_notified" }, { outcome: "target_hit_deduped" }]))).toBe(0);
    expect(watchRunExitCode(summary([]))).toBe(0);
  });
});

describe("query-watch provider cooldown propagation", () => {
  const now = () => new Date("2026-07-05T12:00:00.000Z");

  function serviceFor(fetchImpl: typeof fetch) {
    const adapter = createShopifyAdapter({
      shops: ["www.allbirds.com", "limited-shop.example"],
      globalCatalog: { profileUrl: "https://buyer.example/profile.json" },
      fetchImpl,
      env: {},
    });
    return serviceForAdapter(adapter);
  }

  function serviceForAdapter(adapter: StoreAdapter) {
    const app = createApp({
      orchestrator: createOrchestrator([adapter], { adapterTimeoutMs: 100 }),
      trust: createSeedTrustProvider(),
      auth: { kind: "local-loopback", clientId: "watch-cooldown-test" },
    });
    return createServiceClient({
      serviceUrl: "http://127.0.0.1",
      timeoutMs: 1_000,
      fetchImpl: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
    });
  }

  function queryWatch(configDir: string) {
    return createWatchStore({ configDir, now: () => new Date("2026-07-05T00:00:00.000Z") }).create({
      name: "Shopify query",
      target: { kind: "query", query: { text: "wool runners", maxResults: 3 } },
      targetPrice: { amount: 20_000, currency: "USD" },
      expiresAt: "2026-07-06T00:00:00.000Z",
    });
  }

  function checkerDeps(configDir: string, service: ReturnType<typeof serviceFor>) {
    return {
      store: createWatchStore({ configDir }),
      source: createServiceOfferSource(service),
      notifierFor: () => ({ id: "collect", send: async () => ({ ok: true as const }) }),
      now,
    };
  }

  it("persists the maximum all-failed provider cooldown and performs zero early source I/O", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-watch-all-limited-"));
    const watch = queryWatch(configDir);
    let providerCalls = 0;
    const service = serviceFor(async (input) => {
      providerCalls += 1;
      const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
      const seconds = host === "catalog.shopify.com" ? "3" : host === "www.allbirds.com" ? "4" : "5";
      return new Response("{}", { status: 429, headers: { "Retry-After": seconds } });
    });
    const first = await runWatchesOnce(checkerDeps(configDir, service));
    expect(first.reports[0]).toMatchObject({ outcome: "source_error", error: { code: "rate_limited" } });
    expect(createWatchStore({ configDir }).get(watch.id)).toMatchObject({ nextEligibleCheckAt: "2026-07-05T12:00:05.000Z" });
    expect(providerCalls).toBe(3);
    const deferred = await runWatchesOnce({ ...checkerDeps(configDir, service), now: () => new Date("2026-07-05T12:00:02.000Z") });
    expect(deferred.reports[0]).toMatchObject({ outcome: "cooldown_deferred" });
    expect(providerCalls).toBe(3);
  });

  it("uses partial Shopify offers while persisting the maximum failed-host cooldown", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-watch-partial-limited-"));
    const watch = queryWatch(configDir);
    const fixtureBody = readFileSync(new URL("../../adapters/shopify/test/fixtures/allbirds-search.json", import.meta.url), "utf8");
    let providerCalls = 0;
    const service = serviceFor(async (input) => {
      providerCalls += 1;
      const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
      if (host === "www.allbirds.com") return new Response(fixtureBody, { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 429, headers: { "Retry-After": host === "catalog.shopify.com" ? "4" : "5" } });
    });
    const first = await runWatchesOnce(checkerDeps(configDir, service));
    expect(first.reports[0]).toMatchObject({ outcome: "target_hit_notified" });
    expect(createWatchStore({ configDir }).get(watch.id)).toMatchObject({
      lastSuccessAt: "2026-07-05T12:00:00.000Z",
      nextEligibleCheckAt: "2026-07-05T12:00:05.000Z",
    });
    expect(providerCalls).toBe(3);
    const deferred = await runWatchesOnce({ ...checkerDeps(configDir, service), now: () => new Date("2026-07-05T12:00:02.000Z") });
    expect(deferred.reports[0]).toMatchObject({ outcome: "cooldown_deferred" });
    expect(providerCalls).toBe(3);
  });

  it("persists Shopify's mixed all-failed cooldown through the service and performs zero early provider I/O", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-watch-shopify-mixed-"));
    const watch = queryWatch(configDir);
    let providerCalls = 0;
    const service = serviceFor(((input: string | URL | Request, init?: RequestInit) => {
      providerCalls += 1;
      const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
      if (host === "catalog.shopify.com") {
        return Promise.resolve(new Response("{}", { status: 429, headers: { "Retry-After": "3" } }));
      }
      return Promise.resolve(new Response("{}", { status: 500 }));
    }) as typeof fetch);

    const serviceResult = await service.search({ text: "wool runners", maxResults: 3 });
    expect(serviceResult).toMatchObject({ ok: true, data: { storeStatuses: [{ ok: false, error: { code: "unavailable", retryAfterMs: 3_000 } }] } });
    providerCalls = 0;

    const first = await runWatchesOnce(checkerDeps(configDir, service));
    expect(first.reports[0]).toMatchObject({ outcome: "source_error", error: { code: "source_unavailable" } });
    expect(createWatchStore({ configDir }).get(watch.id)).toMatchObject({ nextEligibleCheckAt: "2026-07-05T12:00:03.000Z" });
    expect(providerCalls).toBe(3);

    const deferred = await runWatchesOnce({ ...checkerDeps(configDir, service), now: () => new Date("2026-07-05T12:00:02.000Z") });
    expect(deferred.reports[0]).toMatchObject({ outcome: "cooldown_deferred" });
    expect(providerCalls).toBe(3);
  });

  it("persists WooCommerce's mixed all-failed cooldown through the service and performs zero early provider I/O", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-watch-woocommerce-mixed-"));
    const watch = queryWatch(configDir);
    let providerCalls = 0;
    const service = serviceForAdapter(createWoocommerceAdapter({
      stores: ["limited-shop.example", "slow-shop.example"],
      fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
        providerCalls += 1;
        const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
        if (host === "limited-shop.example") {
          return Promise.resolve(new Response("{}", { status: 429, headers: { "Retry-After": "3" } }));
        }
        return Promise.resolve(new Response("{}", { status: 500 }));
      }) as typeof fetch,
      env: {},
    }));

    const serviceResult = await service.search({ text: "wool runners", maxResults: 3 });
    expect(serviceResult).toMatchObject({ ok: true, data: { storeStatuses: [{ ok: false, error: { code: "unavailable", retryAfterMs: 3_000 } }] } });
    providerCalls = 0;

    const first = await runWatchesOnce(checkerDeps(configDir, service));
    expect(first.reports[0]).toMatchObject({ outcome: "source_error", error: { code: "source_unavailable" } });
    expect(createWatchStore({ configDir }).get(watch.id)).toMatchObject({ nextEligibleCheckAt: "2026-07-05T12:00:03.000Z" });
    expect(providerCalls).toBe(2);

    const deferred = await runWatchesOnce({ ...checkerDeps(configDir, service), now: () => new Date("2026-07-05T12:00:02.000Z") });
    expect(deferred.reports[0]).toMatchObject({ outcome: "cooldown_deferred" });
    expect(providerCalls).toBe(2);
  });

  it("retains Retry-After on a direct-adapter query failure", async () => {
    const source = createAdapterOfferSource({
      manifest: { id: "fixture", name: "fixture", version: "0.0.1", permissions: { allowedHosts: [], userSession: false }, capabilities: { checkout: false } },
      async search() { return { ok: false, error: { store: "fixture", code: "rate_limited", message: "busy", retryable: true, retryAfterMs: 7_000 } }; },
      async getOffer() { return { ok: false, error: { store: "fixture", code: "not_found", message: "missing", retryable: false } }; },
    });
    await expect(source.search({ text: "anything" })).resolves.toMatchObject({ ok: false, error: { retryAfterMs: 7_000 } });
  });
});

describe("persisted watch channel policy", () => {
  it("fails closed on a legacy file sink outside the config directory without writing it", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-watch-channel-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "northcinder-watch-outside-"));
    const outsidePath = join(outsideDir, "notifications.jsonl");
    const offer = {
      id: "offer-policy",
      product: { id: "product-policy", title: "Policy phone", url: "https://shop.example/policy", attributes: {} },
      price: { amount: 100, currency: "USD" },
      merchant: { id: "shop.example", name: "Shop", domain: "shop.example" },
      availability: "in_stock" as const,
      sourceStore: "reference",
      sponsored: false,
    };
    const store = createWatchStore({ configDir, now: () => new Date("2026-08-21T00:00:00.000Z") });
    store.create({
      name: "legacy outside file",
      target: { kind: "offer", offer },
      targetPrice: { amount: 100, currency: "USD" },
      channel: { type: "file", path: outsidePath },
      expiresAt: "2026-08-22T00:00:00.000Z",
    });

    const result = await runWatchesOnce({
      store,
      source: {
        async search() { return { ok: true as const, offers: [offer] }; },
        async getOffer() { return { ok: true as const, offer }; },
      },
      notifierFor: createChannelNotifierFor({ configDir }),
      now: () => new Date("2026-08-21T01:00:00.000Z"),
    });

    expect(result.reports[0]).toMatchObject({
      outcome: "notify_failed",
      error: { code: "unsafe_notification_file" },
    });
    expect(existsSync(outsidePath)).toBe(false);
  });
});
