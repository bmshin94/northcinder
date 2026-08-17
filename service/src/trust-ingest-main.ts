#!/usr/bin/env node
/**
 * northcinder-trust-ingest — the corpus-feed scheduler (makes the trust moat LIVE).
 * The trust engine's Tranco/PhishTank signals read locally-ingested files; this
 * runnable refreshes them on a cadence. A long-running service hot-reloads the
 * Tranco list after each refresh (throttled ~5 min) — no restart needed.
 *
 * Modes (no daemon manager required; cron/launchd snippets in the service README):
 *   northcinder-trust-ingest --once                one refresh, then exit (cron-able)
 *   northcinder-trust-ingest [--interval <secs>]   interval loop (default 21600s / 6h)
 *
 * Feeds:
 *   Tranco  — keyless, NO signup (lights up `known`-via-rank). Always run.
 *   PhishTank — OPTIONAL, only when NORTHCINDER_PHISHTANK_DUMP_URL is set (its public
 *               dump is gated today; wire it if/when you have access).
 *
 * Env:
 *   NORTHCINDER_TRANCO_LIST_PATH   (required) where to write the normalized rank,domain CSV
 *                             — point the service's NORTHCINDER_TRANCO_LIST_PATH at the same file.
 *   NORTHCINDER_TRANCO_LIST_URL    Tranco download URL (default: the dev-only default list, top 1M)
 *   NORTHCINDER_TRANCO_LIST_ID     provenance id carried into evidence lines
 *   NORTHCINDER_TRANCO_MAX_ROWS    cap rows (default 1,000,000)
 *   NORTHCINDER_PHISHTANK_DUMP_PATH / NORTHCINDER_PHISHTANK_DUMP_URL  optional PhishTank feed
 *   NORTHCINDER_TRUST_INGEST_INTERVAL_S  loop interval (default 21600)
 *
 * Exit (--once): 1 only when EVERY configured feed failed; partial failure → 0.
 */
import { ingestTrancoList } from "./trust/signals/tranco-ingest.js";
import { ingestPhishTank } from "./trust/signals/phishtank-ingest.js";
import {
  runTrustIngestOnce,
  trustIngestExitCode,
  type TrustIngestConfig,
  type TrustIngestDeps,
  type TrustIngestSummary,
} from "./trust/ingest-runner.js";
import { canonicalizeProductEnv } from "@northcinder/protocol";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { isTrancoHostedUrl, normalizeTrancoSourceUrl } from "./trust/signals/tranco-provenance.js";

const DEFAULT_TRANCO_URL = "https://tranco-list.eu/download/Z377G/1000000";
const DEFAULT_INTERVAL_S = 21_600; // 6h

export function buildConfig(env: NodeJS.ProcessEnv): TrustIngestConfig {
  const sourceClass = env["NORTHCINDER_TRANCO_SOURCE_CLASS"];
  const config: TrustIngestConfig = {};
  if (sourceClass !== undefined && sourceClass !== "development_noncommercial" && sourceClass !== "commercial_clean") {
    throw new Error("NORTHCINDER_TRANCO_SOURCE_CLASS must be development_noncommercial or commercial_clean");
  }
  if (sourceClass === "development_noncommercial" && env["NORTHCINDER_TRANCO_ALLOW_DEV"] !== "1") {
    throw new Error("development_noncommercial Tranco ingest requires NORTHCINDER_TRANCO_ALLOW_DEV=1");
  }
  if (sourceClass) {
    const destPath = env["NORTHCINDER_TRANCO_LIST_PATH"];
    if (!destPath) throw new Error("NORTHCINDER_TRANCO_LIST_PATH is required for an enabled Tranco ingest");
    const listId = env["NORTHCINDER_TRANCO_LIST_ID"];
    const listUrl = env["NORTHCINDER_TRANCO_LIST_URL"];
    if (sourceClass === "commercial_clean" && listUrl && isTrancoHostedUrl(listUrl)) {
      throw new Error("commercial_clean Tranco ingest rejects every Tranco-hosted URL");
    }
    if (sourceClass === "commercial_clean" && (!listId || !listUrl || !normalizeTrancoSourceUrl(listUrl))) {
      throw new Error("commercial_clean Tranco ingest requires NORTHCINDER_TRANCO_LIST_ID and an explicit safe HTTPS NORTHCINDER_TRANCO_LIST_URL without userinfo, query, or fragment");
    }
    config.tranco = {
      listId: listId ?? "default (development_noncommercial; CC-BY-NC)",
      listUrl: listUrl ?? DEFAULT_TRANCO_URL,
      destPath,
      sourceClass,
      ...(env["NORTHCINDER_TRANCO_MAX_ROWS"] ? { maxRows: Number(env["NORTHCINDER_TRANCO_MAX_ROWS"]) } : {}), timeoutMs: 120_000,
    };
  }
  if (env["NORTHCINDER_PHISHTANK_DUMP_PATH"]) {
    config.phishtank = {
      destPath: env["NORTHCINDER_PHISHTANK_DUMP_PATH"],
      ...(env["NORTHCINDER_PHISHTANK_DUMP_URL"] ? { dumpUrl: env["NORTHCINDER_PHISHTANK_DUMP_URL"] } : {}),
      timeoutMs: 120_000,
    };
  }
  return config;
}

const DEPS: TrustIngestDeps = { ingestTranco: ingestTrancoList, ingestPhishTank: ingestPhishTank };

function report(summary: TrustIngestSummary): void {
  for (const r of summary.results) {
    console.log(`[northcinder-trust-ingest] ${r.feed}: ${r.ok ? "OK" : "FAILED"} — ${r.detail}`);
  }
}

async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  env = canonicalizeProductEnv(env);
  const once = argv.includes("--once");
  const intervalIdx = argv.indexOf("--interval");
  const intervalS =
    intervalIdx !== -1 && argv[intervalIdx + 1]
      ? Number(argv[intervalIdx + 1])
      : Number(env["NORTHCINDER_TRUST_INGEST_INTERVAL_S"] ?? DEFAULT_INTERVAL_S);
  const config = buildConfig(env);

  if (once) {
    const summary = await runTrustIngestOnce(config, DEPS);
    report(summary);
    process.exitCode = trustIngestExitCode(summary);
    return;
  }

  console.log(`[northcinder-trust-ingest] interval loop every ${intervalS}s (Ctrl-C to stop)`);
  // Long-running loop: refresh, wait, repeat. A failed tick is logged, never fatal.
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    report(await runTrustIngestOnce(config, DEPS));
    await new Promise((r) => setTimeout(r, intervalS * 1000));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).catch(() => {
    console.error("[northcinder-trust-ingest] fatal: startup failed; check buyer-local configuration");
    process.exit(1);
  });
}
