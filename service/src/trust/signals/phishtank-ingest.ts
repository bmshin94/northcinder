/**
 * PhishTank bulk-dump INGEST — the network/download half, SEPARATE from the
 * offline lookup (`phishtank.ts`). Probe-verified (spec §6): the keyless dump
 * `data.phishtank.com/data/online-valid.json.gz` (~3.3MB gz, hourly) works
 * today. This buyer-run cron task streams+gunzips the dump, reduces it to a
 * host→{phishId, verifiedAt} map keyed by the phishing URL's host, and writes it
 * atomically (tmp+rename, 0600) so the previous map survives until the new one
 * is complete. Bounded: caps the collected bytes (no unbounded buffer).
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PhishTankRecord } from "./phishtank.js";

export interface PhishTankIngestOptions {
  /** Default: https://data.phishtank.com/data/online-valid.json.gz */
  dumpUrl?: string;
  destPath: string;
  /** Byte cap on the DECOMPRESSED dump (default 64 MiB). */
  maxBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type PhishTankIngestResult = { ok: true; hosts: number } | { ok: false; reason: string };

const DEFAULT_DUMP = "https://data.phishtank.com/data/online-valid.json.gz";

interface PhishTankRow {
  phish_id?: number | string;
  url?: string;
  verification_time?: string;
}

async function collect(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function ingestPhishTank(options: PhishTankIngestOptions): Promise<PhishTankIngestResult> {
  const dumpUrl = options.dumpUrl ?? DEFAULT_DUMP;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("northcinder: phishtank ingest budget exhausted")), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(dumpUrl, { method: "GET", headers: { accept: "application/gzip" }, signal: controller.signal });
  } catch {
    clearTimeout(timer);
    return { ok: false, reason: controller.signal.aborted ? "phishtank ingest timed out" : "phishtank ingest network error" };
  }
  if (response.status !== 200 || !response.body) {
    clearTimeout(timer);
    return { ok: false, reason: `phishtank ingest returned ${response.status}` };
  }

  const decompressed = dumpUrl.endsWith(".gz")
    ? response.body.pipeThrough(new DecompressionStream("gzip"))
    : response.body;
  let text: string | null;
  try {
    text = await collect(decompressed, maxBytes);
  } catch {
    clearTimeout(timer);
    return { ok: false, reason: "phishtank ingest read error" };
  } finally {
    clearTimeout(timer);
  }
  if (text === null) return { ok: false, reason: "phishtank dump exceeded size cap" };

  let rows: PhishTankRow[];
  try {
    rows = JSON.parse(text) as PhishTankRow[];
  } catch {
    return { ok: false, reason: "phishtank dump was not JSON" };
  }
  if (!Array.isArray(rows)) return { ok: false, reason: "phishtank dump was not an array" };

  const map: Record<string, PhishTankRecord> = {};
  for (const row of rows) {
    if (row.phish_id === undefined || !row.url) continue;
    let host: string;
    try {
      host = new URL(row.url).host.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    if (host === "") continue;
    // Keep the FIRST verified entry per host (dumps are newest-first).
    if (!(host in map)) {
      map[host] = { phishId: String(row.phish_id), verifiedAt: row.verification_time ?? "" };
    }
  }

  mkdirSync(dirname(options.destPath), { recursive: true });
  const tmp = `${options.destPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(map)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, options.destPath);
  return { ok: true, hosts: Object.keys(map).length };
}
