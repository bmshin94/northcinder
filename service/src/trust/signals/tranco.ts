/**
 * Tranco popularity LOOKUP — the second corpus signal (spec §6). Sustained
 * real-traffic popularity is expensive to fake at list scale, so combined with
 * domain age it clears "this store actually exists" (→ `known`). This module is
 * the OFFLINE half: it loads a locally-stored, normalized Tranco CSV (`rank,
 * domain`) into memory and answers per-domain lookups with zero network. The
 * daily DOWNLOAD/ingest is deliberately a separate module (`tranco-ingest.ts`)
 * so this lookup — and every test that uses it — stays offline.
 *
 * License note: the ingest ships the Tranco
 * DEFAULT list, which mixes CC-BY-NC Cloudflare Radar data and is therefore
 * NOT commercial-clean. v1 gates that behind a loud dev-only TODO; the evidence
 * line carries the list id so the provenance is always visible, and the
 * commercial-clean custom-list path (crux/majestic/umbrella) is the follow-up.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import type { SignalResult } from "./result.js";

export interface TrancoMeasurement {
  /** 1 = most popular. */
  rank: number;
}

export interface TrancoLookup {
  /** The Tranco list id carried into every evidence line (provenance). */
  readonly listId: string;
  /** Number of domains loaded (0 = list unavailable → every lookup degrades). */
  readonly size: number;
  lookup(domain: string, now?: () => Date): SignalResult<TrancoMeasurement>;
}

/** Tranco lists store bare registrable domains; normalize the query the same way. */
function normalize(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, "");
}

/** Parse a normalized `rank,domain` CSV (as written by tranco-ingest). */
function parseCsv(text: string): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const comma = trimmed.indexOf(",");
    if (comma === -1) continue;
    const rank = Number(trimmed.slice(0, comma));
    const domain = normalize(trimmed.slice(comma + 1).trim());
    if (Number.isFinite(rank) && rank >= 1 && domain !== "") {
      // Keep the BEST (lowest) rank if a domain appears twice.
      const prev = ranks.get(domain);
      if (prev === undefined || rank < prev) ranks.set(domain, rank);
    }
  }
  return ranks;
}

export interface TrancoLookupOptions {
  /** Path to the normalized `rank,domain` CSV written by the ingest. */
  listPath?: string;
  /** Provenance id for evidence (e.g. the Tranco list id "K2J3W"). */
  listId: string;
  /** Explicit provenance class; carried to every evidence line. */
  sourceClass?: "development_noncommercial" | "commercial_clean";
  /** Re-checkable source URL for a commercial custom corpus. */
  provenanceUrl?: string;
  /** Inject a pre-parsed list instead of reading a file (tests). */
  entries?: Iterable<[string, number]>;
  /**
   * Hot-reload: when set, a long-running service re-reads `listPath` after the
   * `northcinder-trust-ingest` scheduler writes a fresher file — without a restart.
   * The mtime is checked at most once per `throttleMs` of wall time (so the
   * search hot path pays at most one `stat` per window, not per lookup).
   * Omitted → construction-time immutable (the offline/test default).
   */
  reload?: { throttleMs: number; now?: () => Date };
}

/**
 * Build a lookup. If neither `listPath` (existing) nor `entries` is supplied,
 * the lookup is EMPTY — every query degrades to `ok:false` ("Tranco list not
 * loaded"), which the engine treats as "signal absent" (never negative).
 */
export function createTrancoLookup(options: TrancoLookupOptions): TrancoLookup {
  const loadFromFile = (): { ranks: Map<string, number>; mtimeMs: number } => {
    if (options.listPath && existsSync(options.listPath)) {
      return { ranks: parseCsv(readFileSync(options.listPath, "utf8")), mtimeMs: statSync(options.listPath).mtimeMs };
    }
    return { ranks: new Map(), mtimeMs: 0 };
  };

  let ranks: Map<string, number>;
  let loadedMtimeMs = 0;
  if (options.entries) {
    ranks = new Map([...options.entries].map(([d, r]) => [normalize(d), r]));
  } else {
    const loaded = loadFromFile();
    ranks = loaded.ranks;
    loadedMtimeMs = loaded.mtimeMs;
  }

  // Hot-reload state (only used when options.reload + options.listPath are set).
  const reloadNow = options.reload?.now ?? (() => new Date());
  let lastCheckMs = Number.NEGATIVE_INFINITY;
  function maybeReload(): void {
    if (!options.reload || !options.listPath || options.entries) return;
    const nowMs = reloadNow().getTime();
    if (nowMs - lastCheckMs < options.reload.throttleMs) return;
    lastCheckMs = nowMs;
    if (!existsSync(options.listPath)) return;
    const mtimeMs = statSync(options.listPath).mtimeMs;
    if (mtimeMs <= loadedMtimeMs) return; // unchanged since last load
    ranks = parseCsv(readFileSync(options.listPath, "utf8"));
    loadedMtimeMs = mtimeMs;
  }

  return {
    listId: options.listId,
    get size() {
      return ranks.size;
    },
    lookup(domain, now = () => new Date()): SignalResult<TrancoMeasurement> {
      maybeReload();
      if (ranks.size === 0) return { ok: false, reason: "Tranco list not loaded" };
      const rank = ranks.get(normalize(domain));
      if (rank === undefined) return { ok: false, reason: "domain not in Tranco list" };
      return {
        ok: true,
        measurement: { rank },
        evidence: {
          source: "tranco",
          detail: `popularity rank ~${rank} (Tranco ${options.listId}${options.sourceClass ? `; ${options.sourceClass}` : ""})`,
          fetchedAt: now().toISOString(),
          url: options.provenanceUrl ?? `https://tranco-list.eu/query?list=${encodeURIComponent(options.listId)}`,
        },
      };
    },
  };
}
