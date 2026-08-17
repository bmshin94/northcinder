import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPhishTankLookup } from "../src/trust/signals/phishtank.js";
import { ingestPhishTank } from "../src/trust/signals/phishtank-ingest.js";
import { probeCt } from "../src/trust/signals/ct.js";
import { probeUrlhaus } from "../src/trust/signals/urlhaus.js";

const NOW = () => new Date("2026-07-11T00:00:00.000Z");
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "northcinder-curated-"));
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("PhishTank — deny-grade curated lookup + ingest", () => {
  it("cites the phish_id for a listed host (host-normalized)", () => {
    const lookup = createPhishTankLookup({
      entries: [["nike-outlet-sale.example", { phishId: "8675309", verifiedAt: "2026-07-01T12:00:00Z" }]],
    });
    const res = lookup.lookup("www.nike-outlet-sale.example", NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.measurement.phishId).toBe("8675309");
    expect(res.evidence.detail).toBe("listed as verified phishing (PhishTank #8675309, verified 2026-07-01)");
    expect(res.evidence.url).toContain("phish_id=8675309");
  });

  it("degrades to ok:false for an unlisted host and for an unloaded dump", () => {
    expect(createPhishTankLookup({ entries: [] }).lookup("safe.example", NOW).ok).toBe(false);
    expect(createPhishTankLookup().lookup("safe.example", NOW).ok).toBe(false);
  });

  it("ingest streams+gunzips the dump into a host→entry map keyed by URL host", async () => {
    const dir = tempDir();
    const dest = join(dir, "phishtank.json");
    const dump = JSON.stringify([
      { phish_id: 1, url: "http://nike-outlet-sale.example/login", verification_time: "2026-07-01T12:00:00Z" },
      { phish_id: 2, url: "https://www.paypa1-secure.example/", verification_time: "2026-07-02T09:00:00Z" },
      { phish_id: 3, url: "not a url" },
    ]);
    const gz = new Uint8Array(gzipSync(Buffer.from(dump)));
    const fetchImpl = (async () => new Response(new Blob([gz]).stream(), { status: 200 })) as unknown as typeof fetch;
    const res = await ingestPhishTank({ dumpUrl: "https://data.phishtank.com/data/online-valid.json.gz", destPath: dest, fetchImpl });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.hosts).toBe(2);
    const map = JSON.parse(readFileSync(dest, "utf8"));
    expect(map["nike-outlet-sale.example"].phishId).toBe("1");
    expect(map["paypa1-secure.example"].phishId).toBe("2");
  });
});

describe("CT (crt.sh) — best-effort, honest degrade", () => {
  it("reads the earliest not_before across rows as first-cert date", async () => {
    const fetchImpl = (async () =>
      json([{ not_before: "2018-05-01T00:00:00" }, { not_before: "2016-02-11T00:00:00" }, { not_before: "2020-01-01T00:00:00" }])) as typeof fetch;
    const res = await probeCt("allbirds.com", { now: NOW, fetchImpl });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.measurement.firstCertDate).toBe("2016-02-11");
    expect(res.evidence.source).toBe("certificate-transparency");
  });

  it("degrades honestly on 404, empty array, and non-JSON", async () => {
    const notFound = (async () => new Response("", { status: 404 })) as typeof fetch;
    expect((await probeCt("x.com", { now: NOW, fetchImpl: notFound })).ok).toBe(false);
    const empty = (async () => json([])) as typeof fetch;
    expect((await probeCt("x.com", { now: NOW, fetchImpl: empty })).ok).toBe(false);
    const html = (async () => new Response("<html/>", { status: 200 })) as typeof fetch;
    expect((await probeCt("x.com", { now: NOW, fetchImpl: html })).ok).toBe(false);
  });

  it("degrades honestly on a slow response (never blocks past budget)", async () => {
    const fetchImpl = ((_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const started = Date.now();
    const res = await probeCt("slow.com", { now: NOW, fetchImpl, timeoutMs: 40 });
    expect(res.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("URLhaus — env-gated, not_configured when key absent", () => {
  it("returns not_configured without a key (no network call)", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return json({});
    }) as typeof fetch;
    const res = await probeUrlhaus("x.example", { fetchImpl });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("not_configured");
    expect(called).toBe(false);
  });

  it("flags a listed host when the key is present", async () => {
    const fetchImpl = (async () => json({ query_status: "ok", firstseen: "2025-11-02 08:00:00" })) as typeof fetch;
    const res = await probeUrlhaus("malware.example", { authKey: "k", now: NOW, fetchImpl });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.evidence.detail).toContain("listed on URLhaus as of 2025-11-02");
  });

  it("degrades on no_results", async () => {
    const fetchImpl = (async () => json({ query_status: "no_results" })) as typeof fetch;
    const res = await probeUrlhaus("clean.example", { authKey: "k", now: NOW, fetchImpl });
    expect(res.ok).toBe(false);
  });
});
