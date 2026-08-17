/**
 * Certificate Transparency first-cert probe (crt.sh) — BEST-EFFORT, NEVER on the
 * request path (spec §6: probes showed one 404 and one 40s response). It is an
 * OPTIONAL, budget-guarded refresh source that degrades honestly to "unavailable"
 * — the engine must never block on it. The earliest `not_before` across the log
 * rows is the first-cert observation date. This is INFORMATIONAL context only:
 * it produces an evidence line but NO derivation input (domain age comes from
 * RDAP), so a slow/absent CT can never move a trust level.
 *
 * NOTE (spec §6): Cert Spotter keyless is EXCLUDED — it returns only UNEXPIRED
 * certs and would misreport every domain as months old. crt.sh is the source.
 */
import { fetchWithBudget } from "@northcinder/adapter-kit";
import type { SignalResult } from "./result.js";

export interface CtMeasurement {
  /** ISO date (YYYY-MM-DD) of the earliest observed certificate. */
  firstCertDate: string;
}

export interface CtProbeOptions {
  now?: () => Date;
  /** Short by design — CT is best-effort and off the hot path (default 4s). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface CrtShRow {
  not_before?: string;
}

export async function probeCt(domain: string, options: CtProbeOptions = {}): Promise<SignalResult<CtMeasurement>> {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 4000;
  const url = `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`;

  const res = await fetchWithBudget(
    url,
    { method: "GET", headers: { accept: "application/json" } },
    { timeoutMs, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), maxBodyBytes: 8 * 1024 * 1024 },
  );
  if (!res.ok) return { ok: false, reason: `crt.sh unavailable (${res.kind})` };
  if (res.status !== 200) return { ok: false, reason: `crt.sh returned ${res.status}` };

  let rows: CrtShRow[];
  try {
    rows = JSON.parse(res.bodyText) as CrtShRow[];
  } catch {
    return { ok: false, reason: "crt.sh returned non-JSON" };
  }
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, reason: "crt.sh returned no certificates" };

  let earliest: number | undefined;
  for (const row of rows) {
    if (!row.not_before) continue;
    const t = new Date(row.not_before).getTime();
    if (!Number.isNaN(t) && (earliest === undefined || t < earliest)) earliest = t;
  }
  if (earliest === undefined) return { ok: false, reason: "crt.sh rows had no parseable not_before" };

  const firstCertDate = new Date(earliest).toISOString().slice(0, 10);
  return {
    ok: true,
    measurement: { firstCertDate },
    evidence: {
      source: "certificate-transparency",
      detail: `first TLS certificate observed ${firstCertDate} (Certificate Transparency via crt.sh)`,
      fetchedAt: now().toISOString(),
      url,
    },
  };
}
