/**
 * Trust corpus store — direct coverage for degrade/atomic/freshness behavior.
 * These tests also pin the documented content-trust
 * boundary (shape-validated, not content-validated — same boundary as every
 * 0600 service-owned secret file; see the store module boundary.
 */
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTrustCorpusStore,
  TRUST_CORPUS_FILENAME,
  type CorpusRecord,
} from "../src/trust/store.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "trust-store-"));
  dirs.push(d);
  return d;
}
afterEach(() => vi.restoreAllMocks());

const REC: CorpusRecord = {
  key: "allbirds.com",
  inputs: { domainAgeDays: 8949, popularityRank: 41672 },
  evidence: [{ source: "rdap", detail: "domain registered 2002-01-09 (RDAP, Verisign)", fetchedAt: "2026-07-11T00:00:00.000Z" }],
  fetchedAt: "2026-07-11T00:00:00.000Z",
  ttlMs: 86_400_000,
};

describe("trust corpus store", () => {
  it("round-trips a record through a fresh store instance and persists a 0600 file", () => {
    const dir = tempDir();
    createTrustCorpusStore({ dir }).put(REC);
    const path = join(dir, TRUST_CORPUS_FILENAME);
    expect((statSync(path).mode & 0o777)).toBe(0o600);
    const reread = createTrustCorpusStore({ dir }).get("allbirds.com");
    expect(reread).toEqual(REC);
  });

  it("writes atomically: no lingering temp file after a put", () => {
    const dir = tempDir();
    createTrustCorpusStore({ dir }).put(REC);
    const leftovers = readFileSync(join(dir, TRUST_CORPUS_FILENAME), "utf8");
    expect(leftovers).toContain("allbirds.com");
    // The tmp sibling must have been renamed away, not left behind.
    expect(existsSync(join(dir, `${TRUST_CORPUS_FILENAME}.tmp`))).toBe(false);
  });

  it("isFresh honors fetchedAt + ttlMs against the given clock", () => {
    const store = createTrustCorpusStore({ dir: tempDir() });
    expect(store.isFresh(REC, new Date("2026-07-11T12:00:00.000Z"))).toBe(true); // within TTL
    expect(store.isFresh(REC, new Date("2026-07-13T00:00:00.000Z"))).toBe(false); // past TTL
  });

  it("degrades a CORRUPT (unparseable) file to an empty corpus with a warning, never crashing", () => {
    const dir = tempDir();
    writeFileSync(join(dir, TRUST_CORPUS_FILENAME), "{ this is not json", { mode: 0o600 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createTrustCorpusStore({ dir });
    expect(store.get("allbirds.com")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[northcinder-trust] corpus is not valid JSON — starting empty");
    expect(warn.mock.calls.flat().join(" ")).not.toContain(dir);
    // ...and a subsequent put still works (recovers to a valid file).
    store.put(REC);
    expect(createTrustCorpusStore({ dir }).get("allbirds.com")).toEqual(REC);
  });

  it("degrades a WRONG-SHAPE file (valid JSON, invalid schema) to empty, never crashing", () => {
    const dir = tempDir();
    writeFileSync(join(dir, TRUST_CORPUS_FILENAME), JSON.stringify({ version: 2, nope: true }), { mode: 0o600 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createTrustCorpusStore({ dir }).get("allbirds.com")).toBeUndefined();
  });

  it("CONTENT-trust boundary (documented): a well-typed but FABRICATED record is read back verbatim", () => {
    // This is the accepted trust boundary documented by the store module: the
    // store validates SHAPE, not truth. An attacker who can WRITE this 0600
    // file already controls the service; the mitigation is filesystem perms,
    // not in-band crypto. This test PINS the boundary so any future change to
    // it is a conscious decision, not an accident.
    const dir = tempDir();
    const forged: CorpusRecord = {
      key: "totally-unverified.example",
      inputs: { domainAgeDays: 999_999, popularityRank: 1 },
      evidence: [{ source: "rdap", detail: "FORGED", fetchedAt: "2026-07-11T00:00:00.000Z" }],
      fetchedAt: "2026-07-11T00:00:00.000Z",
      ttlMs: 86_400_000,
    };
    writeFileSync(
      join(dir, TRUST_CORPUS_FILENAME),
      JSON.stringify({ version: 1, records: { "totally-unverified.example": forged } }),
      { mode: 0o600 },
    );
    const read = createTrustCorpusStore({ dir }).get("totally-unverified.example");
    expect(read).toEqual(forged); // read verbatim — the documented boundary
  });
});
