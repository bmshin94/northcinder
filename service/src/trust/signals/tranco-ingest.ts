/**
 * Tranco list INGEST — the network/download half, kept SEPARATE from the
 * offline lookup (`tranco.ts`) so tests never touch the network. This is an
 * buyer-run cron task, not a request-path probe: it downloads a Tranco list,
 * normalizes it to a `rank,domain` CSV, and writes it atomically (tmp+rename)
 * so the previous list stays intact until the new one is complete (global
 * reliability constraint). Streams with a hard row cap — never buffers 1M rows
 * unbounded — and supports gzip via the built-in DecompressionStream (no new
 * dependency); `.zip` is refused with a clear message (no bundled unzip).
 *
 * ⚠️ LICENSE TODO (v1, dev-only): the Tranco DEFAULT list mixes CC-BY-NC
 * Cloudflare Radar data and is NOT clean for commercial use. Ship it for
 * development only; the commercial-clean path is a custom list generated from
 * crux/majestic/umbrella providers (account signup). The list id is recorded in
 * every evidence line so provenance is never lost.
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fetchWithBudget } from "@northcinder/adapter-kit";
import { normalizeTrancoSourceUrl, writeTrancoProvenance, type TrancoSourceClass } from "./tranco-provenance.js";

export interface TrancoIngestOptions {
  listId: string;
  /** e.g. https://tranco-list.eu/download/{listId}/1000000 (uncompressed) or a .gz URL. */
  listUrl: string;
  sourceClass?: TrancoSourceClass;
  /** Where to write the normalized `rank,domain` CSV (the lookup reads this). */
  destPath: string;
  /** Cap rows ingested (default top 1,000,000). */
  maxRows?: number;
  /** Whole-download budget in ms (default 120s — this is off the request path). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type TrancoIngestResult = { ok: true; listId: string; rows: number } | { ok: false; reason: string };

const CSV_ROW = /^\s*(\d+)\s*,\s*([^\s,]+)\s*$/;

export async function ingestTrancoList(options: TrancoIngestOptions): Promise<TrancoIngestResult> {
  const maxRows = options.maxRows ?? 1_000_000;
  const timeoutMs = options.timeoutMs ?? 120_000;

  const normalizedSourceUrl = normalizeTrancoSourceUrl(options.listUrl);
  if (!normalizedSourceUrl) return { ok: false, reason: "Tranco ingest URL is invalid" };
  if (new URL(normalizedSourceUrl).pathname.endsWith(".zip")) {
    return {
      ok: false,
      reason: "Tranco .zip is not supported (no bundled unzip) — point NORTHCINDER_TRANCO_LIST_URL at the uncompressed CSV or a .gz",
    };
  }

  // The full uncompressed list is ~20MB, far over the shared 2MiB body cap;
  // stream the body ourselves with a row cap instead of fetchWithBudget's buffer.
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("northcinder: tranco ingest budget exhausted")), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(normalizedSourceUrl, {
      method: "GET",
      headers: { accept: "text/csv, application/octet-stream" },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return { ok: false, reason: controller.signal.aborted ? "tranco ingest timed out" : "tranco ingest network error" };
  }

  if (response.status !== 200 || !response.body) {
    clearTimeout(timer);
    return { ok: false, reason: `tranco ingest returned ${response.status}` };
  }

  // DOM's `DecompressionStream` accepts `BufferSource`, while Node's fetch
  // body is a Uint8Array stream. Preserve the wider, standards-defined type
  // so the gzip path is type-checked without suppressing library checks.
  let stream: ReadableStream<BufferSource> = response.body;
  if (new URL(normalizedSourceUrl).pathname.endsWith(".gz")) {
    stream = stream.pipeThrough(new DecompressionStream("gzip"));
  }

  const lines: string[] = [];
  let rows = 0;
  let buffer = "";
  const decoder = new TextDecoder();
  try {
    const reader = stream.getReader();
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const m = CSV_ROW.exec(line);
        if (m) {
          lines.push(`${m[1]},${m[2]!.toLowerCase()}`);
          rows += 1;
          if (rows >= maxRows) {
            await reader.cancel().catch(() => {});
            break outer;
          }
        }
      }
    }
    // Trailing line with no newline.
    const m = CSV_ROW.exec(buffer);
    if (m && rows < maxRows) {
      lines.push(`${m[1]},${m[2]!.toLowerCase()}`);
      rows += 1;
    }
  } catch {
    clearTimeout(timer);
    return { ok: false, reason: controller.signal.aborted ? "tranco ingest timed out mid-stream" : "tranco ingest read error" };
  } finally {
    clearTimeout(timer);
  }

  if (rows === 0) return { ok: false, reason: "tranco ingest produced no rows (unexpected list format)" };

  mkdirSync(dirname(options.destPath), { recursive: true });
  const tmp = `${options.destPath}.tmp`;
  writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, options.destPath); // previous list survives until the new one is fully written
  writeTrancoProvenance(options.destPath, {
    sourceClass: options.sourceClass ?? "development_noncommercial",
    listId: options.listId,
    sourceUrl: normalizedSourceUrl,
    ingestedAt: new Date().toISOString(),
  });
  return { ok: true, listId: options.listId, rows };
}
