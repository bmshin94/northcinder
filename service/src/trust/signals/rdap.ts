/**
 * RDAP domain-age probe — the single most predictive fake-shop signal (spec §3;
 * 0.9167 accuracy alone) and attacker-cost-asymmetric (an aged domain costs
 * ≥ $1k). Reads the registry's RDAP `events[]` for the `registration` event and
 * measures the domain's age in days.
 *
 * Endpoint policy is PROBE-VERIFIED (spec §6, live 2026-07-11):
 *  - .com / .net → hardcoded Verisign registry (rdap.verisign.com, ~0.8s).
 *  - every other TLD → resolve the base URL from the IANA bootstrap file
 *    (data.iana.org/rdap/dns.json) and query `{base}domain/{d}`.
 *  - the rdap.org proxy (15s) is deliberately AVOIDED.
 *
 * Real shape (verified): {"events":[{"eventAction":"registration","eventDate":
 * "2002-01-09T15:24:37Z"}]}. Fixture-tested offline incl. every failure mode.
 */
import { fetchWithBudget, type HttpResult } from "@northcinder/adapter-kit";
import type { SignalResult } from "./result.js";

export interface RdapMeasurement {
  /** ISO 8601 registration datetime from the RDAP `registration` event. */
  registrationDate: string;
  /** Whole days between registration and `now` (floor, never negative). */
  domainAgeDays: number;
}

export interface RdapProbeOptions {
  now?: () => Date;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Override the IANA bootstrap URL (tests). */
  bootstrapUrl?: string;
}

const VERISIGN = "https://rdap.verisign.com";
const DEFAULT_BOOTSTRAP = "https://data.iana.org/rdap/dns.json";

/** Registry base URL + a human label for the evidence line. */
interface Endpoint {
  base: string; // ends WITHOUT a trailing slash; we append `/domain/{d}`
  registry: string;
}

function tldOf(domain: string): string {
  const parts = domain.toLowerCase().split(".");
  return parts[parts.length - 1] ?? "";
}

/** Bootstrap DNS RDAP registry shape (only the fields we read). */
interface BootstrapFile {
  services?: Array<[string[], string[]]>;
}

async function resolveEndpoint(
  domain: string,
  opts: Required<Pick<RdapProbeOptions, "timeoutMs">> & Pick<RdapProbeOptions, "fetchImpl" | "bootstrapUrl">,
): Promise<Endpoint | { error: string }> {
  const tld = tldOf(domain);
  if (tld === "com" || tld === "net") {
    return { base: `${VERISIGN}/${tld}/v1`, registry: "Verisign" };
  }
  const bootstrapUrl = opts.bootstrapUrl ?? DEFAULT_BOOTSTRAP;
  const res = await fetchWithBudget(
    bootstrapUrl,
    { method: "GET", headers: { accept: "application/json" } },
    { timeoutMs: opts.timeoutMs, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) },
  );
  if (!res.ok) return { error: `rdap bootstrap unavailable (${res.kind})` };
  if (res.status !== 200) return { error: `rdap bootstrap returned ${res.status}` };
  let file: BootstrapFile;
  try {
    file = JSON.parse(res.bodyText) as BootstrapFile;
  } catch {
    return { error: "rdap bootstrap returned non-JSON" };
  }
  for (const service of file.services ?? []) {
    const [tlds, urls] = service;
    if (tlds?.some((t) => t.toLowerCase() === tld) && urls?.[0]) {
      const raw = urls[0].replace(/\/+$/, "");
      return { base: raw, registry: new URL(raw).host };
    }
  }
  return { error: `no RDAP registry in IANA bootstrap for .${tld}` };
}

function readBody(res: HttpResult): { text: string } | { error: string } {
  if (!res.ok) return { error: `rdap unavailable (${res.kind})` };
  if (res.status === 404) return { error: "rdap domain not found (404)" };
  if (res.status !== 200) return { error: `rdap returned ${res.status}` };
  return { text: res.bodyText };
}

interface RdapDomainResponse {
  events?: Array<{ eventAction?: string; eventDate?: string }>;
}

export async function probeRdap(domain: string, options: RdapProbeOptions = {}): Promise<SignalResult<RdapMeasurement>> {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 2000;
  // `timeoutMs` is the budget for the WHOLE probe. For non-.com/.net TLDs the
  // IANA bootstrap fetch spends part of it; the domain query gets only the
  // remainder, so the total never doubles the stated budget (adversarial MINOR).
  const startedMs = now().getTime();

  const endpoint = await resolveEndpoint(domain, {
    timeoutMs,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.bootstrapUrl ? { bootstrapUrl: options.bootstrapUrl } : {}),
  });
  if ("error" in endpoint) return { ok: false, reason: endpoint.error };

  const remainingMs = Math.max(250, timeoutMs - (now().getTime() - startedMs));
  const url = `${endpoint.base}/domain/${encodeURIComponent(domain)}`;
  const res = await fetchWithBudget(
    url,
    { method: "GET", headers: { accept: "application/rdap+json, application/json" } },
    { timeoutMs: remainingMs, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
  );
  const body = readBody(res);
  if ("error" in body) return { ok: false, reason: body.error };

  let parsed: RdapDomainResponse;
  try {
    parsed = JSON.parse(body.text) as RdapDomainResponse;
  } catch {
    return { ok: false, reason: "rdap response was not JSON" };
  }

  const registration = (parsed.events ?? []).find((e) => e.eventAction === "registration");
  if (!registration?.eventDate) {
    return { ok: false, reason: "rdap response had no registration event" };
  }
  const registered = new Date(registration.eventDate);
  if (Number.isNaN(registered.getTime())) {
    return { ok: false, reason: "rdap registration eventDate was not a valid date" };
  }

  const nowDate = now();
  const domainAgeDays = Math.max(0, Math.floor((nowDate.getTime() - registered.getTime()) / 86_400_000));
  const registeredIso = registered.toISOString();
  const day = registeredIso.slice(0, 10);

  return {
    ok: true,
    measurement: { registrationDate: registeredIso, domainAgeDays },
    evidence: {
      source: "rdap",
      detail: `domain registered ${day} (RDAP, ${endpoint.registry})`,
      fetchedAt: nowDate.toISOString(),
      url,
    },
  };
}
