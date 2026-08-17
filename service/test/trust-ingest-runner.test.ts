/**
 * northcinder-trust-ingest runner — orchestrates the corpus feed ingests (Tranco
 * live/keyless; PhishTank + URLhaus env-gated) into one honest summary the
 * scheduler can act on. Pure over injected ingest fns → offline, deterministic.
 */
import { describe, expect, it, vi } from "vitest";
import { runTrustIngestOnce, trustIngestExitCode, type TrustIngestConfig } from "../src/trust/ingest-runner.js";
import { buildConfig } from "../src/trust-ingest-main.js";

function cfg(over: Partial<TrustIngestConfig> = {}): TrustIngestConfig {
  return {
    tranco: { listId: "L", listUrl: "https://x/list", destPath: "/tmp/t.csv", sourceClass: "development_noncommercial" },
    ...over,
  };
}

describe("runTrustIngestOnce", () => {
  it("does not schedule a default download without an explicit allowed source class", () => {
    expect(buildConfig({})).toEqual({});
    expect(() => buildConfig({ NORTHCINDER_TRANCO_SOURCE_CLASS: "development_noncommercial" })).toThrow(/ALLOW_DEV/);
    expect(() => buildConfig({ NORTHCINDER_TRANCO_SOURCE_CLASS: "commercial_clean", NORTHCINDER_TRANCO_LIST_PATH: "/tmp/x" })).toThrow(/explicit safe/);
  });

  it("passes the configured PhishTank dump URL through the runner's actual dumpUrl field", () => {
    expect(buildConfig({
      NORTHCINDER_PHISHTANK_DUMP_PATH: "/tmp/phishtank.json",
      NORTHCINDER_PHISHTANK_DUMP_URL: "data:application/json,%5B%5D",
    })).toEqual({
      phishtank: {
        destPath: "/tmp/phishtank.json",
        dumpUrl: "data:application/json,%5B%5D",
        timeoutMs: 120_000,
      },
    });
  });

  it("treats an intentionally empty feed configuration as a successful no-op", async () => {
    const ingestTranco = vi.fn(async () => ({ ok: true as const, listId: "unused", rows: 1 }));
    const summary = await runTrustIngestOnce({}, { ingestTranco });
    expect(ingestTranco).not.toHaveBeenCalled();
    expect(summary).toEqual({ results: [], anyOk: false, allFailed: false });
    expect(trustIngestExitCode(summary)).toBe(0);
  });

  it.each([
    "https://TRANCO-LIST.EU/custom/list",
    "https://tranco-list.eu/custom/list?source=claimed-clean#fragment",
    "https://cdn.tranco-list.eu/another/path",
  ])("rejects every Tranco-hosted URL from the commercial_clean path: %s", (listUrl) => {
    expect(() => buildConfig({
      NORTHCINDER_TRANCO_SOURCE_CLASS: "commercial_clean",
      NORTHCINDER_TRANCO_LIST_PATH: "/tmp/x",
      NORTHCINDER_TRANCO_LIST_ID: "custom-list",
      NORTHCINDER_TRANCO_LIST_URL: listUrl,
    })).toThrow(/Tranco-hosted/);
  });

  it.each([
    "http://corpus.example/list.csv",
    "ftp://corpus.example/list.csv",
    "https://operator:secret@corpus.example/list.csv",
    "https://corpus.example/list.csv?token=secret",
    "https://corpus.example/list.csv#token=secret",
  ])("rejects unsafe commercial_clean source URLs at configuration: %s", (listUrl) => {
    expect(() => buildConfig({
      NORTHCINDER_TRANCO_SOURCE_CLASS: "commercial_clean",
      NORTHCINDER_TRANCO_LIST_PATH: "/tmp/x",
      NORTHCINDER_TRANCO_LIST_ID: "custom-list",
      NORTHCINDER_TRANCO_LIST_URL: listUrl,
    })).toThrow(/HTTPS/i);
  });

  it("runs the configured Tranco ingest and reports rows, when it succeeds", async () => {
    const ingestTranco = vi.fn(async () => ({ ok: true as const, listId: "L", rows: 100_000 }));
    const summary = await runTrustIngestOnce(cfg(), { ingestTranco });
    expect(ingestTranco).toHaveBeenCalledTimes(1);
    expect(summary.results).toContainEqual({ feed: "tranco", ok: true, detail: "100000 rows" });
    expect(summary.anyOk).toBe(true);
    expect(summary.allFailed).toBe(false);
  });

  it("reports a failed feed honestly without throwing (honest degrade)", async () => {
    const ingestTranco = vi.fn(async () => ({ ok: false as const, reason: "tranco 503" }));
    const summary = await runTrustIngestOnce(cfg(), { ingestTranco });
    expect(summary.results).toContainEqual({ feed: "tranco", ok: false, detail: "tranco 503" });
    expect(summary.anyOk).toBe(false);
    expect(summary.allFailed).toBe(true);
  });

  it("only runs PhishTank/URLhaus when configured (env-gated placeholder pattern)", async () => {
    const ingestTranco = vi.fn(async () => ({ ok: true as const, listId: "L", rows: 5 }));
    const ingestPhishTank = vi.fn(async () => ({ ok: true as const, hosts: 42 }));
    // No phishtank config → its ingest is never called.
    const s1 = await runTrustIngestOnce(cfg(), { ingestTranco, ingestPhishTank });
    expect(ingestPhishTank).not.toHaveBeenCalled();
    expect(s1.results.map((r) => r.feed)).toEqual(["tranco"]);

    // With phishtank config → it runs and is reported.
    const s2 = await runTrustIngestOnce(
      cfg({ phishtank: { destPath: "/tmp/pt.set" } }),
      { ingestTranco, ingestPhishTank },
    );
    expect(ingestPhishTank).toHaveBeenCalledTimes(1);
    expect(s2.results).toContainEqual({ feed: "phishtank", ok: true, detail: "42 hosts" });
  });

  it("a throwing ingest is caught and reported as a failed feed, never crashes the tick", async () => {
    const ingestTranco = vi.fn(async () => {
      throw new Error("network exploded");
    });
    const summary = await runTrustIngestOnce(cfg(), { ingestTranco });
    expect(summary.results[0]).toMatchObject({ feed: "tranco", ok: false });
    expect(summary.results[0]!.detail).toBe("feed ingest failed unexpectedly");
    expect(summary.results[0]!.detail).not.toContain("network exploded");
  });
});

describe("trustIngestExitCode", () => {
  it("exits 1 only when EVERY configured feed failed (cron sees a fully-failed tick)", () => {
    expect(trustIngestExitCode({ results: [], anyOk: false, allFailed: false })).toBe(0);
    expect(trustIngestExitCode({ results: [{ feed: "tranco", ok: false, detail: "x" }], anyOk: false, allFailed: true })).toBe(1);
    expect(trustIngestExitCode({ results: [{ feed: "tranco", ok: true, detail: "x" }], anyOk: true, allFailed: false })).toBe(0);
    // partial failure is a normal, reported state → 0
    expect(
      trustIngestExitCode({
        results: [{ feed: "tranco", ok: true, detail: "x" }, { feed: "phishtank", ok: false, detail: "y" }],
        anyOk: true,
        allFailed: false,
      }),
    ).toBe(0);
  });
});
