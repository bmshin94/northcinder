/**
 * northcinder-trust-ingest RUNNER — orchestrates the corpus-feed ingests into one
 * honest tick summary. Kept pure over injected ingest functions so it is
 * offline/deterministic to test; the CLI (`trust-ingest-main.ts`) wires the
 * real `ingestTrancoList` / `ingestPhishTank` and the cadence.
 *
 * Feed availability (2026-07-11, verified): Tranco downloads keyless (no
 * signup) — this is the one that lights up `known`-via-rank. PhishTank's bulk
 * dump is gated (keyless → 404; new API keys long closed) and URLhaus needs a
 * free abuse.ch key, so both are OPTIONAL and only run when configured
 * (env-gated placeholder pattern) and degrade honestly when their feed is down.
 */
import type { TrancoIngestResult } from "./signals/tranco-ingest.js";
import type { TrancoSourceClass } from "./signals/tranco-provenance.js";
import type { PhishTankIngestResult } from "./signals/phishtank-ingest.js";

export interface TrustIngestConfig {
  /** Explicitly configured provenance only; missing classification means disabled. */
  tranco?: { listId: string; listUrl: string; destPath: string; sourceClass: TrancoSourceClass; maxRows?: number; timeoutMs?: number };
  /** Optional (gated feed): PhishTank bulk dump → host set. */
  phishtank?: { dumpUrl?: string; destPath: string; timeoutMs?: number };
}

export interface TrustIngestDeps {
  ingestTranco: (o: NonNullable<TrustIngestConfig["tranco"]>) => Promise<TrancoIngestResult>;
  ingestPhishTank?: (o: NonNullable<TrustIngestConfig["phishtank"]>) => Promise<PhishTankIngestResult>;
}

export interface FeedResult {
  feed: "tranco" | "phishtank";
  ok: boolean;
  detail: string;
}

export interface TrustIngestSummary {
  results: FeedResult[];
  anyOk: boolean;
  allFailed: boolean;
}

async function runFeed(feed: FeedResult["feed"], fn: () => Promise<FeedResult>): Promise<FeedResult> {
  try {
    return await fn();
  } catch {
    return { feed, ok: false, detail: "feed ingest failed unexpectedly" };
  }
}

/** One ingest tick over every CONFIGURED feed. Never throws; every feed is reported. */
export async function runTrustIngestOnce(config: TrustIngestConfig, deps: TrustIngestDeps): Promise<TrustIngestSummary> {
  const results: FeedResult[] = [];

  if (config.tranco) results.push(
    await runFeed("tranco", async () => {
      const r = await deps.ingestTranco(config.tranco!);
      return r.ok
        ? { feed: "tranco", ok: true, detail: `${r.rows} rows` }
        : { feed: "tranco", ok: false, detail: r.reason };
    }),
  );

  if (config.phishtank && deps.ingestPhishTank) {
    const phishtank = config.phishtank;
    const ingest = deps.ingestPhishTank;
    results.push(
      await runFeed("phishtank", async () => {
        const r = await ingest(phishtank);
        return r.ok
          ? { feed: "phishtank", ok: true, detail: `${r.hosts} hosts` }
          : { feed: "phishtank", ok: false, detail: r.reason };
      }),
    );
  }

  const anyOk = results.some((r) => r.ok);
  return { results, anyOk, allFailed: results.length > 0 && !anyOk };
}

/**
 * `--once` exit code: 1 only when EVERY configured feed failed (so cron/launchd
 * see a fully-failed tick). Partial failure is a normal, reported state → 0.
 * Mirrors the northcinder-watch scheduler's convention.
 */
export function trustIngestExitCode(summary: TrustIngestSummary): 0 | 1 {
  return summary.allFailed ? 1 : 0;
}
