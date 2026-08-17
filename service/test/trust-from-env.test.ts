import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Merchant } from "@northcinder/protocol";
import { buildTrustProviderFromEnv } from "../src/trust/from-env.js";
import { TRUST_CORPUS_FILENAME } from "../src/trust/store.js";
import { writeTrancoProvenance } from "../src/trust/signals/tranco-provenance.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "northcinder-fromenv-"));
}
function merchant(domain: string): Merchant {
  return { id: domain, domain, name: domain };
}

afterEach(() => vi.unstubAllGlobals());

describe("buildTrustProviderFromEnv — engine wiring behind NORTHCINDER_TRUST_ENGINE", () => {
  it("NORTHCINDER_TRUST_ENGINE=0 returns the seed-only fallback (platform heuristic, no probes/network)", async () => {
    const trust = buildTrustProviderFromEnv({ NORTHCINDER_TRUST_ENGINE: "0" } as NodeJS.ProcessEnv);
    const shopify = await trust.trustSignal(merchant("cool.myshopify.com"));
    expect(shopify.level).toBe("known");
    expect(shopify.evidence[0]?.source).toBe("platform-heuristic");

    const unknown = await trust.trustSignal(merchant("obscure-indie.example"));
    expect(unknown.level).toBe("unknown");
  });

  it("NORTHCINDER_TRUST_ENGINE=0 honors a deny hit from a curated seed file", async () => {
    const dir = tempDir();
    const seedPath = join(dir, "seed.json");
    writeFileSync(
      seedPath,
      JSON.stringify({ allow: [], deny: [{ domain: "scam.example", detail: "reported" }], knownPlatformDomains: [] }),
    );
    const trust = buildTrustProviderFromEnv({ NORTHCINDER_TRUST_ENGINE: "0", NORTHCINDER_TRUST_SEED_PATH: seedPath } as NodeJS.ProcessEnv);
    expect((await trust.trustSignal(merchant("scam.example"))).level).toBe("flagged");
  });

  it("uses the shared canonical config domain for its default corpus (not a parallel state root)", async () => {
    const home = tempDir();
    const corpus = join(home, ".config", "northcinder", "trust");
    mkdirSync(corpus, { recursive: true });
    writeFileSync(join(corpus, TRUST_CORPUS_FILENAME), JSON.stringify({ version: 1, records: {
      "allbirds.com": { key: "allbirds.com", inputs: { domainAgeDays: 8000, popularityRank: 1 }, evidence: [{ source: "fixture", detail: "canonical root" }], fetchedAt: new Date().toISOString(), ttlMs: 86400000 },
    } }));
    const trust = buildTrustProviderFromEnv({ HOME: home, NORTHCINDER_TRUST_ENGINE: "1" } as NodeJS.ProcessEnv);
    expect((await trust.trustSignal(merchant("allbirds.com"))).level).toBe("known");
  });

  it("engine ON reads a pre-seeded FRESH corpus and derives from it with no probe/network (offline)", async () => {
    const dir = tempDir();
    // A fresh corpus record → the engine takes the pure fresh-hit path, no probe.
    writeFileSync(
      join(dir, TRUST_CORPUS_FILENAME),
      JSON.stringify({
        version: 1,
        records: {
          "allbirds.com": {
            key: "allbirds.com",
            inputs: { domainAgeDays: 8000, popularityRank: 4200 },
            evidence: [{ source: "rdap", detail: "domain registered 2002-01-09 (RDAP, Verisign)", fetchedAt: new Date().toISOString() }],
            fetchedAt: new Date().toISOString(),
            ttlMs: 10 * 365 * 24 * 60 * 60 * 1000,
          },
        },
      }),
    );
    const trust = buildTrustProviderFromEnv({ NORTHCINDER_TRUST_CORPUS_DIR: dir, NORTHCINDER_TRUST_BUDGET_MS: "50" } as NodeJS.ProcessEnv);
    const signal = await trust.trustSignal(merchant("allbirds.com"));
    expect(signal.level).toBe("known");
    expect(signal.evidence.some((e) => e.source === "rdap")).toBe(true);
  });

  it("does not use a configured popularity file unless its source class is explicitly allowed", async () => {
    const dir = tempDir();
    const list = join(dir, "tranco.csv");
    writeFileSync(list, "1,allbirds.com\n");
    writeTrancoProvenance(list, { sourceClass: "development_noncommercial", listId: "dev-fixture", sourceUrl: "https://tranco-list.eu/download/Z377G/1000000", ingestedAt: new Date().toISOString() });
    const trust = buildTrustProviderFromEnv({
      NORTHCINDER_TRUST_CORPUS_DIR: join(dir, "corpus"),
      NORTHCINDER_TRUST_BUDGET_MS: "50",
      NORTHCINDER_TRANCO_LIST_PATH: list,
    } as NodeJS.ProcessEnv);
    const signal = await trust.trustSignal(merchant("allbirds.com"));
    expect(signal.evidence.some((e) => e.source === "tranco")).toBe(false);
  });

  it("labels an explicitly allowed development source in runtime evidence", async () => {
    const dir = tempDir();
    const list = join(dir, "tranco.csv");
    writeFileSync(list, "1,allbirds.com\n");
    writeTrancoProvenance(list, { sourceClass: "development_noncommercial", listId: "dev-fixture", sourceUrl: "https://tranco-list.eu/download/Z377G/1000000", ingestedAt: new Date().toISOString() });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ events: [{ eventAction: "registration", eventDate: "2000-01-01T00:00:00.000Z" }] }), { status: 200 })));
    const trust = buildTrustProviderFromEnv({
      NORTHCINDER_TRUST_CORPUS_DIR: join(dir, "corpus"), NORTHCINDER_TRUST_BUDGET_MS: "500",
      NORTHCINDER_TRANCO_LIST_PATH: list, NORTHCINDER_TRANCO_SOURCE_CLASS: "development_noncommercial",
      NORTHCINDER_TRANCO_ALLOW_DEV: "1", NORTHCINDER_TRANCO_LIST_ID: "dev-fixture",
    } as NodeJS.ProcessEnv);
    const signal = await trust.trustSignal(merchant("allbirds.com"));
    expect(signal.evidence.find((e) => e.source === "tranco")?.detail).toContain("development_noncommercial");
  });

  it("fails closed for commercial_clean when the normalized CSV has no matching provenance sidecar", async () => {
    const dir = tempDir();
    const list = join(dir, "tranco.csv");
    writeFileSync(list, "1,allbirds.com\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ events: [{ eventAction: "registration", eventDate: "2000-01-01T00:00:00.000Z" }] }), { status: 200 })));
    const trust = buildTrustProviderFromEnv({
      NORTHCINDER_TRUST_CORPUS_DIR: join(dir, "corpus"), NORTHCINDER_TRUST_BUDGET_MS: "500",
      NORTHCINDER_TRANCO_LIST_PATH: list, NORTHCINDER_TRANCO_SOURCE_CLASS: "commercial_clean",
      NORTHCINDER_TRANCO_LIST_ID: "operator-custom", NORTHCINDER_TRANCO_LIST_URL: "https://corpus.example/custom.csv",
    } as NodeJS.ProcessEnv);
    const signal = await trust.trustSignal(merchant("allbirds.com"));
    expect(signal.evidence.some((e) => e.source === "tranco")).toBe(false);
  });

  it("permits only matching commercial provenance and rejects digest or metadata tampering", async () => {
    const dir = tempDir();
    const list = join(dir, "tranco.csv");
    const sourceUrl = "https://corpus.example/custom.csv";
    let attempt = 0;
    const env = {
      NORTHCINDER_TRUST_BUDGET_MS: "500",
      NORTHCINDER_TRANCO_LIST_PATH: list, NORTHCINDER_TRANCO_SOURCE_CLASS: "commercial_clean",
      NORTHCINDER_TRANCO_LIST_ID: "operator-custom", NORTHCINDER_TRANCO_LIST_URL: sourceUrl,
    } as NodeJS.ProcessEnv;
    const hasTranco = async (): Promise<boolean> => {
      env.NORTHCINDER_TRUST_CORPUS_DIR = join(dir, `corpus-${attempt++}`);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ events: [{ eventAction: "registration", eventDate: "2000-01-01T00:00:00.000Z" }] }), { status: 200 })));
      return (await buildTrustProviderFromEnv(env).trustSignal(merchant("allbirds.com"))).evidence.some((e) => e.source === "tranco");
    };
    writeFileSync(list, "1,allbirds.com\n");
    writeTrancoProvenance(list, { sourceClass: "commercial_clean", listId: "operator-custom", sourceUrl, ingestedAt: new Date().toISOString() });
    expect(await hasTranco()).toBe(true);
    writeFileSync(list, "2,allbirds.com\n");
    expect(await hasTranco()).toBe(false);
    writeTrancoProvenance(list, { sourceClass: "commercial_clean", listId: "operator-custom", sourceUrl, ingestedAt: new Date().toISOString() });
    const sidecar = `${list}.provenance.json`;
    writeFileSync(sidecar, readFileSync(sidecar, "utf8").replace("operator-custom", "relabeled"));
    expect(await hasTranco()).toBe(false);
  });

  it("fails closed for unsafe configured commercial provenance and never returns a credential-bearing evidence URL", async () => {
    const dir = tempDir();
    const list = join(dir, "tranco.csv");
    const safeUrl = "https://corpus.example/custom.csv";
    writeFileSync(list, "1,allbirds.com\n");
    writeTrancoProvenance(list, { sourceClass: "commercial_clean", listId: "operator-custom", sourceUrl: safeUrl, ingestedAt: new Date().toISOString() });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ events: [{ eventAction: "registration", eventDate: "2000-01-01T00:00:00.000Z" }] }), { status: 200 })));
    const base = {
      NORTHCINDER_TRUST_CORPUS_DIR: join(dir, "corpus"), NORTHCINDER_TRUST_BUDGET_MS: "500",
      NORTHCINDER_TRANCO_LIST_PATH: list, NORTHCINDER_TRANCO_SOURCE_CLASS: "commercial_clean",
      NORTHCINDER_TRANCO_LIST_ID: "operator-custom",
    } as NodeJS.ProcessEnv;
    const safeSignal = await buildTrustProviderFromEnv({ ...base, NORTHCINDER_TRANCO_LIST_URL: safeUrl }).trustSignal(merchant("allbirds.com"));
    expect(safeSignal.evidence.find((e) => e.source === "tranco")?.url).toBe(safeUrl);
    const unsafeSignal = await buildTrustProviderFromEnv({ ...base, NORTHCINDER_TRUST_CORPUS_DIR: join(dir, "unsafe-corpus"), NORTHCINDER_TRANCO_LIST_URL: "https://operator:secret@corpus.example/custom.csv" }).trustSignal(merchant("allbirds.com"));
    expect(unsafeSignal.evidence.some((e) => e.source === "tranco")).toBe(false);
    expect(JSON.stringify(unsafeSignal)).not.toContain("secret");
  });
});
