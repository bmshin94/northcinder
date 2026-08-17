/**
 * PhishTank verified-phishing LOOKUP — a DENY-GRADE curated source (spec §6,
 * §4 invariant 2). A hit here is one of the ONLY things (besides the local deployer
 * deny seed) that may legitimately drive a merchant to `flagged`: PhishTank
 * entries are human-verified phishing, and citing the specific `phish_id` is a
 * factual citation (not feed redistribution). Catches brand-impersonation shop
 * domains ("nike-outlet-sale.example" masquerading as nike.com).
 *
 * OFFLINE half: loads a locally-ingested host→entry map and answers per-host
 * lookups with zero network. The hourly bulk-dump DOWNLOAD is a separate module
 * (`phishtank-ingest.ts`) so this lookup, and its tests, stay offline.
 */
import { existsSync, readFileSync } from "node:fs";
import type { SignalResult } from "./result.js";

export interface PhishTankMeasurement {
  phishId: string;
  /** ISO verification time from the dump (`verification_time`). */
  verifiedAt: string;
}

/** The normalized on-disk shape (host → the fields we cite). */
export interface PhishTankRecord {
  phishId: string;
  verifiedAt: string;
}

export interface PhishTankLookup {
  readonly size: number;
  lookup(host: string, now?: () => Date): SignalResult<PhishTankMeasurement>;
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export interface PhishTankLookupOptions {
  /** Path to the normalized JSON map { host: { phishId, verifiedAt } }. */
  setPath?: string;
  entries?: Iterable<[string, PhishTankRecord]>;
}

export function createPhishTankLookup(options: PhishTankLookupOptions = {}): PhishTankLookup {
  let map = new Map<string, PhishTankRecord>();
  if (options.entries) {
    map = new Map([...options.entries].map(([h, r]) => [normalizeHost(h), r]));
  } else if (options.setPath && existsSync(options.setPath)) {
    try {
      const raw = JSON.parse(readFileSync(options.setPath, "utf8")) as Record<string, PhishTankRecord>;
      map = new Map(Object.entries(raw).map(([h, r]) => [normalizeHost(h), r]));
    } catch {
      map = new Map(); // corrupt dump → treat as unavailable, never throw
    }
  }

  return {
    size: map.size,
    lookup(host, now = () => new Date()): SignalResult<PhishTankMeasurement> {
      if (map.size === 0) return { ok: false, reason: "PhishTank dump not loaded" };
      const rec = map.get(normalizeHost(host));
      if (rec === undefined) return { ok: false, reason: "host not in PhishTank dump" };
      const day = rec.verifiedAt.slice(0, 10);
      return {
        ok: true,
        measurement: { phishId: rec.phishId, verifiedAt: rec.verifiedAt },
        evidence: {
          source: "phishtank",
          detail: `listed as verified phishing (PhishTank #${rec.phishId}, verified ${day})`,
          fetchedAt: now().toISOString(),
          url: `https://www.phishtank.com/phish_detail.php?phish_id=${encodeURIComponent(rec.phishId)}`,
        },
      };
    },
  };
}
