/**
 * URLhaus host probe (abuse.ch) — OPTIONAL, env-gated, LOWEST priority (spec §6).
 * Malware-only (weak for shop fraud), and the keyless endpoint returns 401, so
 * it is gated behind `ABUSECH_AUTH_KEY`: absent key → `not_configured` (never an
 * error, never a network call). A host that IS listed is surfaced by the engine
 * (probes.ts) as an EVIDENCE-ONLY note — deliberately NOT wired to
 * `curatedFraudHit`, because an automated malware feed prone to shared-hosting
 * false-correlation must never auto-`flag` an honest merchant (spec §6 "weak,
 * lowest priority"; the anti-ScamAdviser risk). Only human-verified PhishTank
 * drives `flagged`. Anything else degrades honestly.
 */
import { fetchWithBudget } from "@northcinder/adapter-kit";
import type { SignalResult } from "./result.js";

export interface UrlhausMeasurement {
  /** ISO date the host was first seen on URLhaus, when available. */
  firstSeen?: string;
}

export interface UrlhausProbeOptions {
  /** abuse.ch Auth-Key; when undefined the probe returns not_configured. */
  authKey?: string;
  now?: () => Date;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface UrlhausResponse {
  query_status?: string;
  firstseen?: string;
}

export async function probeUrlhaus(host: string, options: UrlhausProbeOptions = {}): Promise<SignalResult<UrlhausMeasurement>> {
  if (!options.authKey) return { ok: false, reason: "not_configured: ABUSECH_AUTH_KEY absent" };
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 2000;
  const url = "https://urlhaus-api.abuse.ch/v1/host/";

  const res = await fetchWithBudget(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "Auth-Key": options.authKey },
      body: `host=${encodeURIComponent(host)}`,
    },
    { timeoutMs, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
  );
  if (!res.ok) return { ok: false, reason: `URLhaus unavailable (${res.kind})` };
  if (res.status !== 200) return { ok: false, reason: `URLhaus returned ${res.status}` };

  let body: UrlhausResponse;
  try {
    body = JSON.parse(res.bodyText) as UrlhausResponse;
  } catch {
    return { ok: false, reason: "URLhaus returned non-JSON" };
  }
  if (body.query_status !== "ok") return { ok: false, reason: `URLhaus: ${body.query_status ?? "no result"}` };

  const day = body.firstseen ? body.firstseen.slice(0, 10) : now().toISOString().slice(0, 10);
  return {
    ok: true,
    measurement: body.firstseen ? { firstSeen: body.firstseen } : {},
    evidence: {
      source: "urlhaus",
      detail: `listed on URLhaus as of ${day}`,
      fetchedAt: now().toISOString(),
      url: "https://urlhaus.abuse.ch/browse/",
    },
  };
}
