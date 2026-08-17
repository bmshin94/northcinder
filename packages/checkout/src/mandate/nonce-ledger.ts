/**
 * Single-use nonce ledger: replay protection for purchase mandates. A nonce
 * is consumed exactly once, at the moment verification otherwise succeeds.
 *
 * On I/O failure `consume` REJECTS; the verifier catches that and fails
 * closed with a structured `ledger_unavailable` rejection — a broken ledger
 * never grants a purchase.
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * A marker older than this can never gate a live replay: verifyMandate
 * rejects an expired mandate BEFORE it ever reaches consume(), so once a
 * nonce's mandate is older than any reasonable TTL, its marker is inert
 * weight left on disk. Generous upper bound over a caller-configured
 * `ttlMs` (issue.ts's own default is 15 minutes).
 */
const DEFAULT_MAX_MARKER_AGE_MS = 24 * 60 * 60_000;

/** Best-effort: removes marker files older than maxAgeMs. Never throws. */
function pruneOldMarkers(markersDir: string, maxAgeMs: number, nowMs: number): void {
  let entries: string[];
  try {
    entries = readdirSync(markersDir);
  } catch {
    return; // no markers dir yet — nothing to prune
  }
  for (const name of entries) {
    const markerFile = join(markersDir, name);
    try {
      const { mtimeMs } = statSync(markerFile);
      if (nowMs - mtimeMs > maxAgeMs) rmSync(markerFile, { force: true });
    } catch {
      // Best-effort: a marker we can't stat/remove is left in place rather
      // than risk throwing out of ledger construction.
    }
  }
}

export interface NonceLedger {
  /**
   * Atomically mark the nonce used. Returns false if it was already used —
   * including by ANOTHER ledger instance or process on the same store.
   * Rejects on I/O failure (never silently succeeds without persistence).
   */
  consume(nonce: string, meta?: { mandateId?: string }): Promise<boolean>;
  has(nonce: string): Promise<boolean>;
}

export function createInMemoryNonceLedger(): NonceLedger {
  const used = new Set<string>();
  return {
    async consume(nonce) {
      if (used.has(nonce)) return false;
      used.add(nonce);
      return true;
    },
    async has(nonce) {
      return used.has(nonce);
    },
  };
}

/**
 * File-backed ledger with REAL cross-instance/cross-process exclusion:
 * the commit point for a nonce is the atomic O_EXCL creation of a per-nonce
 * marker file in `<filePath>.markers/` (named by the nonce's sha256, mode
 * 0600). Exactly one instance — in this process or any other on the same
 * filesystem — can create it; every loser gets EEXIST and reports the nonce
 * as already used. The human-auditable JSONL at `filePath` is kept as the
 * append-only usage log (and legacy entries in it still block replays), but
 * it is no longer the exclusion mechanism.
 *
 * Ordering (fail closed): marker first (durable burn), then in-memory set,
 * then the JSONL audit line. If the audit append fails after the marker is
 * committed, consume() rejects — the nonce stays burned and the caller
 * treats the ledger as unavailable rather than proceeding un-audited.
 */
export interface FileNonceLedgerOptions {
  /** Marker files older than this are pruned when the ledger opens (default 24h). */
  maxMarkerAgeMs?: number;
  /** Injectable clock for the prune cutoff (tests). */
  now?: () => Date;
}

export function createFileNonceLedger(filePath: string, options: FileNonceLedgerOptions = {}): NonceLedger {
  const markersDir = `${filePath}.markers`;
  const now = options.now ?? (() => new Date());
  // Bound the markers directory's growth: a nonce marker outlives any
  // legitimate use for it (see DEFAULT_MAX_MARKER_AGE_MS above) once past
  // the max mandate TTL — prune on open rather than let it grow forever.
  pruneOldMarkers(markersDir, options.maxMarkerAgeMs ?? DEFAULT_MAX_MARKER_AGE_MS, now().getTime());
  const used = new Set<string>();
  if (existsSync(filePath)) {
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { nonce?: string };
        if (typeof entry.nonce === "string") used.add(entry.nonce);
      } catch {
        // A corrupt line never grants a replay: ignore it for lookup, keep appending.
      }
    }
  }

  function markerPath(nonce: string): string {
    return join(markersDir, createHash("sha256").update(nonce, "utf8").digest("hex"));
  }

  return {
    async consume(nonce, meta) {
      if (used.has(nonce)) return false; // legacy JSONL entries + same-instance fast path

      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      mkdirSync(markersDir, { recursive: true, mode: 0o700 });

      const record = {
        nonce,
        usedAt: new Date().toISOString(),
        ...(meta?.mandateId ? { mandateId: meta.mandateId } : {}),
      };

      // THE commit point: O_CREAT|O_EXCL is atomic on a filesystem — exactly
      // one instance/process wins the marker.
      let fd: number;
      try {
        fd = openSync(markerPath(nonce), "wx", 0o600);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
          used.add(nonce); // learned: burned elsewhere
          return false;
        }
        throw cause; // real I/O failure → reject → verifier fails closed
      }
      try {
        writeSync(fd, `${JSON.stringify(record)}\n`);
      } finally {
        closeSync(fd);
      }
      used.add(nonce);

      // Append-only audit log (mode 0600; appendFileSync's mode is umask-filtered).
      const existed = existsSync(filePath);
      appendFileSync(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      if (!existed) chmodSync(filePath, 0o600);
      return true;
    },

    async has(nonce) {
      return used.has(nonce) || existsSync(markerPath(nonce));
    },
  };
}
