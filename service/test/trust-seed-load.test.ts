import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadTrustSeed } from "../src/trust/seed-load.js";
import { DEFAULT_TRUST_SEED } from "../src/trust/seed-trust.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "northcinder-seed-"));
}

describe("loadTrustSeed — curation moved to a data file", () => {
  it("returns DEFAULT_TRUST_SEED when no path is configured", () => {
    expect(loadTrustSeed()).toEqual(DEFAULT_TRUST_SEED);
  });

  it("loads + validates a well-formed seed file", () => {
    const dir = tempDir();
    const path = join(dir, "seed.json");
    writeFileSync(
      path,
      JSON.stringify({
        allow: [{ domain: "vetted.example", detail: "hand-vetted" }],
        deny: [{ domain: "scam.example", detail: "reported fraud" }],
        knownPlatformDomains: [{ domain: "myshopify.com", detail: "Shopify" }],
      }),
    );
    const seed = loadTrustSeed(path);
    expect(seed.allow[0]?.domain).toBe("vetted.example");
    expect(seed.deny[0]?.detail).toBe("reported fraud");
  });

  it("falls back to default when the configured path does not exist", () => {
    const missing = join(tempDir(), "missing.json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(loadTrustSeed(missing)).toEqual(DEFAULT_TRUST_SEED);
    expect(warn).toHaveBeenCalledWith("[northcinder-trust] configured trust seed does not exist — using DEFAULT_TRUST_SEED");
    expect(warn.mock.calls.flat().join(" ")).not.toContain(missing);
    warn.mockRestore();
  });

  it("throws (fail closed) on a malformed seed file — never boots unseeded", () => {
    const dir = tempDir();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ allow: "not-an-array" }));
    expect(() => loadTrustSeed(bad)).toThrow(/does not match the seed schema/);

    const notJson = join(dir, "notjson.json");
    writeFileSync(notJson, "{ not json");
    expect(() => loadTrustSeed(notJson)).toThrow(/not valid JSON/);
  });

  it("the shipped service/trust-seed.json matches the schema and the built-in default", () => {
    const shipped = loadTrustSeed(join(process.cwd(), "trust-seed.json"));
    expect(shipped.knownPlatformDomains.map((e) => e.domain)).toEqual(
      DEFAULT_TRUST_SEED.knownPlatformDomains.map((e) => e.domain),
    );
  });
});
