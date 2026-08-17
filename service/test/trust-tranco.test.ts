import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTrancoLookup } from "../src/trust/signals/tranco.js";
import { ingestTrancoList } from "../src/trust/signals/tranco-ingest.js";
import { normalizeTrancoSourceUrl, writeTrancoProvenance } from "../src/trust/signals/tranco-provenance.js";

const NOW = () => new Date("2026-07-11T00:00:00.000Z");
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "northcinder-tranco-"));
}

describe("createTrancoLookup — offline popularity lookup", () => {
  it("returns rank + a provenance-carrying evidence line for a listed domain (www-insensitive)", () => {
    const lookup = createTrancoLookup({ listId: "K2J3W", entries: [["allbirds.com", 4200], ["nike.com", 300]] });
    const res = lookup.lookup("www.allbirds.com", NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.measurement.rank).toBe(4200);
    expect(res.evidence.detail).toBe("popularity rank ~4200 (Tranco K2J3W)");
    expect(res.evidence.source).toBe("tranco");
    expect(res.evidence.fetchedAt).toBe("2026-07-11T00:00:00.000Z");
  });

  it("degrades to ok:false for a domain not on the list (never negative)", () => {
    const lookup = createTrancoLookup({ listId: "K2J3W", entries: [["nike.com", 300]] });
    const res = lookup.lookup("obscure-indie-shop.example", NOW);
    expect(res.ok).toBe(false);
  });

  it("degrades to ok:false when no list is loaded at all", () => {
    const lookup = createTrancoLookup({ listId: "K2J3W" });
    expect(lookup.size).toBe(0);
    expect(lookup.lookup("nike.com", NOW).ok).toBe(false);
  });

  it("reads a normalized CSV file from disk", () => {
    const dir = tempDir();
    const listPath = join(dir, "tranco.csv");
    writeFileSync(listPath, "1,google.com\n2,youtube.com\n4200,allbirds.com\n");
    const lookup = createTrancoLookup({ listId: "K2J3W", listPath });
    expect(lookup.size).toBe(3);
    const res = lookup.lookup("allbirds.com", NOW);
    expect(res.ok && res.measurement.rank).toBe(4200);
  });
});

describe("ingestTrancoList — separate download half (offline via fetch stub)", () => {
  function streamFetch(body: Uint8Array, status = 200): typeof fetch {
    return (async () =>
      new Response(status === 200 ? new Blob([body]).stream() : null, { status })) as unknown as typeof fetch;
  }

  it("streams an uncompressed CSV to a normalized local file (row-capped)", async () => {
    const dir = tempDir();
    const dest = join(dir, "out.csv");
    const csv = "1,Google.com\n2,youtube.com\n3,Facebook.com\n4,x.com\n";
    const res = await ingestTrancoList({
      listId: "K2J3W",
      listUrl: "https://tranco-list.eu/download/K2J3W/1000000",
      destPath: dest,
      maxRows: 3,
      fetchImpl: streamFetch(new TextEncoder().encode(csv)),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows).toBe(3);
    // Row-capped + lowercased.
    expect(readFileSync(dest, "utf8")).toBe("1,google.com\n2,youtube.com\n3,facebook.com\n");
    expect(statSync(`${dest}.provenance.json`).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(`${dest}.provenance.json`, "utf8"))).toMatchObject({
      schemaVersion: 1,
      sourceClass: "development_noncommercial",
      listId: "K2J3W",
    });
  });

  it("transparently gunzips a .gz list", async () => {
    const dir = tempDir();
    const dest = join(dir, "out.csv");
    const gz = gzipSync(Buffer.from("1,google.com\n2,youtube.com\n"));
    const res = await ingestTrancoList({
      listId: "K2J3W",
      listUrl: "https://tranco-list.eu/download/K2J3W.gz",
      destPath: dest,
      fetchImpl: streamFetch(new Uint8Array(gz)),
    });
    expect(res.ok).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("1,google.com\n2,youtube.com\n");
  });

  it("refuses a .zip URL with a clear message (no bundled unzip)", async () => {
    const res = await ingestTrancoList({
      listId: "K2J3W",
      listUrl: "https://tranco-list.eu/top-1m.csv.zip",
      destPath: "/tmp/never",
      fetchImpl: streamFetch(new Uint8Array()),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain(".zip");
  });

  it("degrades honestly on a non-200 response", async () => {
    const res = await ingestTrancoList({
      listId: "K2J3W",
      listUrl: "https://tranco-list.eu/download/K2J3W/1000000",
      destPath: "/tmp/never",
      fetchImpl: streamFetch(new Uint8Array(), 503),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("503");
  });

  it.each([
    "http://corpus.example/custom.csv",
    "ftp://corpus.example/custom.csv",
    "https://operator:secret@corpus.example/custom.csv",
    "https://corpus.example/custom.csv?token=secret",
    "https://corpus.example/custom.csv#token=secret",
  ])("rejects an unsafe provenance URL before invoking fetch: %s", async (listUrl) => {
    const fetchImpl = vi.fn(streamFetch(new TextEncoder().encode("1,allbirds.com\n")));
    const res = await ingestTrancoList({ listId: "safe", listUrl, destPath: join(tempDir(), "out.csv"), fetchImpl });
    expect(res).toEqual({ ok: false, reason: "Tranco ingest URL is invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("writes only a safe canonical source URL to the provenance sidecar", () => {
    const listPath = join(tempDir(), "out.csv");
    writeFileSync(listPath, "1,allbirds.com\n");
    expect(() => writeTrancoProvenance(listPath, {
      sourceClass: "commercial_clean", listId: "safe", sourceUrl: "https://operator:secret@corpus.example/list.csv", ingestedAt: NOW().toISOString(),
    })).toThrow(/invalid/i);
    writeTrancoProvenance(listPath, {
      sourceClass: "commercial_clean", listId: "safe", sourceUrl: "https://corpus.example/list.csv", ingestedAt: NOW().toISOString(),
    });
    const sidecar = readFileSync(`${listPath}.provenance.json`, "utf8");
    expect(sidecar).toContain("https://corpus.example/list.csv");
    expect(sidecar).not.toContain("secret");
  });

  it.each(["http://corpus.example/list.csv", "https://operator:secret@corpus.example/list.csv", "https://corpus.example/list.csv?token=secret", "https://corpus.example/list.csv#secret"])("does not normalize an unsafe source URL: %s", (sourceUrl) => {
    expect(normalizeTrancoSourceUrl(sourceUrl)).toBeUndefined();
  });
});

describe("createTrancoLookup — mtime-throttled hot reload (long-running service picks up a fresh ingest)", () => {
  function tmpCsv(rows: string): string {
    const dir = mkdtempSync(join(tmpdir(), "tranco-reload-"));
    const path = join(dir, "tranco.csv");
    writeFileSync(path, rows);
    return path;
  }

  it("re-reads the list when the file changes and the throttle window has passed", () => {
    const path = tmpCsv("1,first.example\n");
    let ms = 1_000_000;
    const now = () => new Date(ms);
    const lookup = createTrancoLookup({ listId: "L", listPath: path, reload: { throttleMs: 60_000, now } });

    expect(lookup.lookup("first.example").ok).toBe(true);
    expect(lookup.lookup("second.example").ok).toBe(false);

    // A fresh ingest overwrites the CSV with a newer mtime.
    ms += 120_000;
    writeFileSync(path, "1,second.example\n");

    // Throttle window passed → the next lookup re-reads and sees the new list.
    expect(lookup.lookup("second.example").ok).toBe(true);
    expect(lookup.lookup("first.example").ok).toBe(false);
  });

  it("does NOT re-stat on every lookup within the throttle window (cheap hot path)", () => {
    const path = tmpCsv("1,first.example\n");
    let ms = 1_000_000;
    const now = () => new Date(ms);
    const lookup = createTrancoLookup({ listId: "L", listPath: path, reload: { throttleMs: 60_000, now } });
    expect(lookup.lookup("first.example").ok).toBe(true);

    // File changes but only 5s pass (< throttle) → still serves the cached list.
    ms += 5_000;
    writeFileSync(path, "1,second.example\n");
    expect(lookup.lookup("second.example").ok).toBe(false); // not reloaded yet
    expect(lookup.lookup("first.example").ok).toBe(true);
  });

  it("without a reload option, stays construction-time immutable (unchanged behavior)", () => {
    const path = tmpCsv("1,first.example\n");
    const lookup = createTrancoLookup({ listId: "L", listPath: path });
    expect(lookup.lookup("first.example").ok).toBe(true);
    writeFileSync(path, "1,second.example\n");
    expect(lookup.lookup("second.example").ok).toBe(false); // never reloads
  });
});
