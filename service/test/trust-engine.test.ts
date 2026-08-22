import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TrustSignalSchema, type Merchant } from "@northcinder/protocol";
import { createTrustCorpusStore } from "../src/trust/store.js";
import { createSignalTrustProvider } from "../src/trust/engine.js";
import { createRefreshProbes } from "../src/trust/probes.js";
import { DEFAULT_TRUST_SEED, type TrustSeed } from "../src/trust/seed-trust.js";
import type { RefreshProbes, RefreshResult } from "../src/trust/probes.js";

const NOW = new Date("2026-07-11T00:00:00.000Z");
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "northcinder-engine-"));
}
function merchant(domain: string, id = domain): Merchant {
  return { id, domain, name: id };
}
function seed(overrides: Partial<TrustSeed> = {}): TrustSeed {
  return { ...DEFAULT_TRUST_SEED, ...overrides };
}

describe("signal trust engine — cache-first, budgeted, deduped", () => {
  it("fresh corpus hit: derives 'known' from stored age+rank with zero probe calls", async () => {
    const dir = tempDir();
    const store = createTrustCorpusStore({ dir });
    store.put({
      key: "allbirds.com",
      inputs: { domainAgeDays: 8000, popularityRank: 4200 },
      evidence: [
        { source: "rdap", detail: "domain registered 2002-01-09 (RDAP, Verisign)", fetchedAt: NOW.toISOString() },
        { source: "tranco", detail: "popularity rank ~4200 (Tranco K2J3W)", fetchedAt: NOW.toISOString() },
      ],
      fetchedAt: NOW.toISOString(),
      ttlMs: 1_000_000,
    });
    const refreshProbes = vi.fn<RefreshProbes>(async () => ({ inputs: {}, evidence: [] }));
    const engine = createSignalTrustProvider({ store, seed: seed(), refreshProbes, now: () => NOW });

    const signal = await engine.trustSignal(merchant("allbirds.com"));
    expect(signal.level).toBe("known");
    expect(refreshProbes).not.toHaveBeenCalled(); // fresh ⇒ no probe
    expect(signal.evidence.map((e) => e.source)).toEqual(["rdap", "tranco"]);
    expect(TrustSignalSchema.parse(signal)).toBeTruthy();
  });

  it("deny-seed short-circuits to 'flagged' without any probe", async () => {
    const store = createTrustCorpusStore({ dir: tempDir() });
    const refreshProbes = vi.fn<RefreshProbes>(async () => ({ inputs: {}, evidence: [] }));
    const engine = createSignalTrustProvider({
      store,
      seed: seed({ deny: [{ domain: "scam.example", detail: "counterfeit" }] }),
      refreshProbes,
      now: () => NOW,
    });
    const signal = await engine.trustSignal(merchant("scam.example"));
    expect(signal.level).toBe("flagged");
    expect(refreshProbes).not.toHaveBeenCalled();
  });

  it("cold path within budget: awaits the refresh, persists, and returns fresh signals", async () => {
    const dir = tempDir();
    const store = createTrustCorpusStore({ dir });
    const refreshProbes: RefreshProbes = async () => ({
      inputs: { domainAgeDays: 9000, popularityRank: 3000 },
      evidence: [{ source: "rdap", detail: "domain registered 2001-05-01 (RDAP, Verisign)", fetchedAt: NOW.toISOString() }],
    });
    const engine = createSignalTrustProvider({ store, seed: seed(), refreshProbes, budgetMs: 500, now: () => NOW });

    const signal = await engine.trustSignal(merchant("established.com"));
    expect(signal.level).toBe("known");
    expect(signal.evidence.some((e) => e.source === "rdap")).toBe(true);
    // Persisted to the corpus for the next (warm) search.
    expect(store.get("established.com")?.inputs.domainAgeDays).toBe(9000);
  });

  it("cold path budget expiry: returns unknown + a 'signals pending' line, refresh continues", async () => {
    const dir = tempDir();
    const store = createTrustCorpusStore({ dir });
    let resolveRefresh!: (r: RefreshResult) => void;
    const gate = new Promise<RefreshResult>((r) => (resolveRefresh = r));
    const refreshProbes: RefreshProbes = () => gate;
    const engine = createSignalTrustProvider({ store, seed: seed(), refreshProbes, budgetMs: 30, now: () => NOW });

    const started = Date.now();
    const signal = await engine.trustSignal(merchant("obscure-shop.example"));
    expect(Date.now() - started).toBeLessThan(400); // did NOT wait for the slow refresh
    expect(signal.level).toBe("unknown");
    expect(signal.evidence.some((e) => e.detail.includes("signals pending"))).toBe(true);

    // The background refresh still lands and persists (warm next time).
    resolveRefresh({ inputs: { domainAgeDays: 9000, popularityRank: 100 }, evidence: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.get("obscure-shop.example")?.inputs.domainAgeDays).toBe(9000);
  });

  it("a never-resolving probe never makes the hot path exceed budgetMs", async () => {
    const store = createTrustCorpusStore({ dir: tempDir() });
    const refreshProbes: RefreshProbes = () => new Promise<RefreshResult>(() => {}); // never resolves
    const engine = createSignalTrustProvider({ store, seed: seed(), refreshProbes, budgetMs: 50, now: () => NOW });
    const started = Date.now();
    const signal = await engine.trustSignal(merchant("hang.example"));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(400);
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(signal.level).toBe("unknown");
  });

  it("per-key dedupe: two concurrent cold lookups trigger exactly one probe run", async () => {
    const store = createTrustCorpusStore({ dir: tempDir() });
    const refreshProbes = vi.fn<RefreshProbes>(async () => ({ inputs: { domainAgeDays: 5000, popularityRank: 900 }, evidence: [] }));
    const engine = createSignalTrustProvider({ store, seed: seed(), refreshProbes, budgetMs: 500, now: () => NOW });

    const [a, b] = await Promise.all([
      engine.trustSignal(merchant("dedupe.example")),
      engine.trustSignal(merchant("dedupe.example")),
    ]);
    expect(a.level).toBe("known");
    expect(b.level).toBe("known");
    expect(refreshProbes).toHaveBeenCalledTimes(1);
  });

  it("shares one normalized-domain refresh across seller identities without collapsing returned merchant ids", async () => {
    const store = createTrustCorpusStore({ dir: tempDir() });
    const refreshProbes = vi.fn<RefreshProbes>(async () => ({ inputs: { domainAgeDays: 5000, popularityRank: 900 }, evidence: [] }));
    const engine = createSignalTrustProvider({ store, seed: seed(), refreshProbes, budgetMs: 500, now: () => NOW });
    const [one, two] = await Promise.all([
      engine.trustSignal(merchant("Market.Example.", "seller-1")),
      engine.trustSignal(merchant("market.example", "seller-2")),
    ]);
    expect(refreshProbes).toHaveBeenCalledTimes(1);
    expect(one.merchantId).toBe("seller-1");
    expect(two.merchantId).toBe("seller-2");
    expect(store.get("market.example")).toBeDefined();
  });

  it("stale record serves best-available + a refreshing line while re-fetching", async () => {
    const dir = tempDir();
    const store = createTrustCorpusStore({ dir });
    store.put({
      key: "aged.com",
      inputs: { domainAgeDays: 4000, popularityRank: 5000 },
      evidence: [{ source: "rdap", detail: "domain registered 2015-01-01 (RDAP, Verisign)", fetchedAt: "2026-01-01T00:00:00.000Z" }],
      fetchedAt: "2026-01-01T00:00:00.000Z",
      ttlMs: 1000, // long stale by NOW
    });
    let resolveRefresh!: (r: RefreshResult) => void;
    const refreshProbes: RefreshProbes = () => new Promise<RefreshResult>((r) => (resolveRefresh = r));
    const engine = createSignalTrustProvider({ store, seed: seed(), refreshProbes, budgetMs: 20, now: () => NOW });

    const signal = await engine.trustSignal(merchant("aged.com"));
    expect(signal.level).toBe("known"); // still served from the stale record
    expect(signal.evidence.some((e) => e.detail.includes("showing cached signals"))).toBe(true);
    resolveRefresh({ inputs: { domainAgeDays: 4200, popularityRank: 4000 }, evidence: [] });
  });

  it("§4 property: NO probe-measurement combination (age/rank/CT) yields 'flagged' — only curated hits do", async () => {
    const store = createTrustCorpusStore({ dir: tempDir() });
    // Compose real probes with age+rank+CT successes and NO curated hit.
    const refreshProbes = createRefreshProbes({
      rdap: async () => ({ ok: true, measurement: { registrationDate: "2001-01-01T00:00:00Z", domainAgeDays: 9000 }, evidence: { source: "rdap", detail: "x" } }),
      tranco: () => ({ ok: true, measurement: { rank: 10 }, evidence: { source: "tranco", detail: "x" } }),
      ct: async () => ({ ok: true, measurement: { firstCertDate: "2001-02-01" }, evidence: { source: "certificate-transparency", detail: "x" } }),
    });
    const engine = createSignalTrustProvider({ store, seed: seed(), refreshProbes, budgetMs: 500, now: () => NOW });
    const signal = await engine.trustSignal(merchant("wellestablished.com"));
    expect(signal.level).not.toBe("flagged");
    expect(signal.level).toBe("known");

    // A PhishTank curated hit is the only automated path to flagged (§4.2).
    const store2 = createTrustCorpusStore({ dir: tempDir() });
    const flagProbes = createRefreshProbes({
      phishtank: () => ({ ok: true, measurement: { phishId: "42", verifiedAt: "2026-07-01T00:00:00Z" }, evidence: { source: "phishtank", detail: "listed" } }),
    });
    const engine2 = createSignalTrustProvider({ store: store2, seed: seed(), refreshProbes: flagProbes, budgetMs: 500, now: () => NOW });
    const flagged = await engine2.trustSignal(merchant("nike-outlet-sale.example"));
    expect(flagged.level).toBe("flagged");

    // A URLhaus hit is EVIDENCE-ONLY — it must NOT flag an honest merchant
    // (spec §6 "weak, lowest priority"; the anti-ScamAdviser risk). The
    // listing is surfaced, but the level is unaffected: an obscure store with
    // a URLhaus note (and no age/rank) stays UNKNOWN, never flagged.
    const store3 = createTrustCorpusStore({ dir: tempDir() });
    const urlhausProbes = createRefreshProbes({
      urlhaus: async () => ({ ok: true, measurement: { firstSeen: "2025-01-01" }, evidence: { source: "urlhaus", detail: "listed on URLhaus as of 2025-01-01" } }),
    });
    const engine3 = createSignalTrustProvider({ store: store3, seed: seed(), refreshProbes: urlhausProbes, budgetMs: 500, now: () => NOW });
    const urlhausSignal = await engine3.trustSignal(merchant("small-indie-shop.example"));
    expect(urlhausSignal.level).not.toBe("flagged");
    expect(urlhausSignal.level).toBe("unknown");
    // ...but the malware note IS surfaced for the human.
    expect(urlhausSignal.evidence.some((e) => e.source === "urlhaus")).toBe(true);
  });

  it("corpus persists to a 0600 file that a fresh store instance reads back", async () => {
    const dir = tempDir();
    const store = createTrustCorpusStore({ dir });
    const refreshProbes: RefreshProbes = async () => ({ inputs: { domainAgeDays: 9000, popularityRank: 100 }, evidence: [] });
    const engine = createSignalTrustProvider({ store, seed: seed(), refreshProbes, budgetMs: 500, now: () => NOW });
    await engine.trustSignal(merchant("persist.com"));

    const reopened = createTrustCorpusStore({ dir });
    expect(reopened.get("persist.com")?.inputs.popularityRank).toBe(100);
    // sanity: file exists and is JSON
    expect(() => JSON.parse(readFileSync(store.path, "utf8"))).not.toThrow();
  });
});
