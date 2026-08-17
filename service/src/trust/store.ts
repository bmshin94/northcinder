/**
 * Trust corpus store — the MOAT SEED (spec §5.2). One 0600 JSON file mapping
 * `trustKey` → the PROBE-derived signals measured for that merchant (domain age,
 * popularity rank, curated-fraud hit) + their re-checkable evidence lines +
 * when they were fetched + a TTL. Seed allow/deny/platform hits are NOT stored:
 * they are curated, instant, and computed live by the engine, so the corpus
 * holds only the expensive-to-measure network signals.
 *
 * Persistence mirrors the profile store: write-then-rename so a crash mid-write
 * can never leave a truncated corpus, mode 0600 enforced past the umask. The
 * service is a single process, so the parsed map is held in memory and is the
 * source of truth; every `put` re-persists the whole file atomically. A corrupt
 * (unparseable / wrong-shape) file degrades to an EMPTY corpus with a warning
 * rather than crashing boot — the corpus is a cache/accretion, and
 * honest-degrade beats fail-to-boot here.
 *
 * TRUST BOUNDARY: this file
 * is validated for SHAPE, not CONTENT. A well-typed but fabricated record
 * (e.g. a hand-written `domainAgeDays: 999999`) would be read back as if it were
 * a genuine probe result and could drive a `known` uplift. This is the same
 * boundary as every other 0600 service-owned secret file — the mandate keypair,
 * the nonce ledger, the profile store: an attacker who can WRITE this file
 * already controls the service process, so an integrity signature would only
 * move the problem to an adjacent key. The mitigation is filesystem perms
 * (0600, service-owned dir), not in-band crypto. The
 * user-facing neutrality guarantee (`rankingVerified`) is unaffected because it
 * re-checks the ORDERING over disclosed inputs, and the evidence lines remain
 * independently re-checkable against the real registries/lists regardless.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TrustEvidenceSchema, type TrustEvidence } from "@northcinder/protocol";

export const TRUST_CORPUS_FILENAME = "trust-corpus.json";

/** The probe-measured subset of TrustDerivationInputs (curation is computed live). */
export const CorpusInputsSchema = z.object({
  domainAgeDays: z.number().optional(),
  popularityRank: z.number().optional(),
  curatedFraudHit: z.boolean().optional(),
});
export type CorpusInputs = z.infer<typeof CorpusInputsSchema>;

export const CorpusRecordSchema = z.object({
  key: z.string().min(1),
  inputs: CorpusInputsSchema,
  evidence: z.array(TrustEvidenceSchema),
  /** When the probes were measured (ISO 8601). */
  fetchedAt: z.iso.datetime(),
  /** Freshness horizon in ms; `fetchedAt + ttlMs < now` ⇒ stale ⇒ refresh. */
  ttlMs: z.number().nonnegative(),
});
export type CorpusRecord = z.infer<typeof CorpusRecordSchema>;

const CorpusFileSchema = z.object({
  version: z.literal(1),
  records: z.record(z.string(), CorpusRecordSchema),
});

export interface TrustCorpusStore {
  readonly path: string;
  get(key: string): CorpusRecord | undefined;
  put(record: CorpusRecord): void;
  /** True when the record exists and `fetchedAt + ttlMs` has not passed at `now`. */
  isFresh(record: CorpusRecord, now: Date): boolean;
}

export interface TrustCorpusStoreOptions {
  dir: string;
}

export function createTrustCorpusStore(options: TrustCorpusStoreOptions): TrustCorpusStore {
  const path = join(options.dir, TRUST_CORPUS_FILENAME);
  const records = new Map<string, CorpusRecord>();

  if (existsSync(path)) {
    try {
      const parsed = CorpusFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) {
        for (const [key, rec] of Object.entries(parsed.data.records)) records.set(key, rec);
      } else {
        console.warn("[northcinder-trust] corpus failed schema validation — starting empty");
      }
    } catch {
      console.warn("[northcinder-trust] corpus is not valid JSON — starting empty");
    }
  }

  function persist(): void {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    const payload = { version: 1 as const, records: Object.fromEntries(records) };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600); // writeFileSync's mode is umask-filtered; enforce 0600
    renameSync(tmp, path);
  }

  return {
    path,
    get: (key) => records.get(key),
    put(record) {
      const validated = CorpusRecordSchema.parse(record);
      records.set(validated.key, validated);
      persist();
    },
    isFresh(record, now) {
      return Date.parse(record.fetchedAt) + record.ttlMs > now.getTime();
    },
  };
}

/** Re-export for engine adaptation. */
export type { TrustEvidence };
