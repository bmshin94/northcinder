/**
 * Trust provider wiring (spec §5.2). Selects and assembles the merchant trust
 * provider from the environment:
 *
 *   NORTHCINDER_TRUST_ENGINE       "0" → the seed-only fallback provider; anything
 *                             else (default) → the verifiable-signals engine.
 *   NORTHCINDER_TRUST_SEED_PATH    curated allow/deny/platform data file (else built-in).
 *   NORTHCINDER_TRUST_CORPUS_DIR   corpus store dir (default <config-dir>/trust).
 *   NORTHCINDER_TRUST_BUDGET_MS    hot-path cold-miss budget (default 800).
 *   NORTHCINDER_TRANCO_LIST_PATH   normalized rank,domain CSV (from the ingest).
 *   NORTHCINDER_TRANCO_LIST_ID     Tranco list id for evidence provenance.
 *   NORTHCINDER_PHISHTANK_DUMP_PATH  normalized host→entry JSON (from the ingest).
 *   NORTHCINDER_TRUST_CT           "1" → enable the best-effort crt.sh probe.
 *   ABUSECH_AUTH_KEY          present → enable the URLhaus probe.
 */
import { join } from "node:path";
import { resolveConfigDir } from "@northcinder/protocol";
import { createSeedTrustProvider, type TrustProvider } from "./seed-trust.js";
import { loadTrustSeed } from "./seed-load.js";
import { createTrustCorpusStore } from "./store.js";
import { createSignalTrustProvider } from "./engine.js";
import { createRefreshProbes, type ProbeConfig } from "./probes.js";
import { probeRdap } from "./signals/rdap.js";
import { createTrancoLookup } from "./signals/tranco.js";
import { hasMatchingTrancoProvenance, isTrancoHostedUrl, normalizeTrancoSourceUrl } from "./signals/tranco-provenance.js";
import { createPhishTankLookup } from "./signals/phishtank.js";
import { probeCt } from "./signals/ct.js";
import { probeUrlhaus } from "./signals/urlhaus.js";

export function buildTrustProviderFromEnv(env: NodeJS.ProcessEnv): TrustProvider {
  const seed = loadTrustSeed(env["NORTHCINDER_TRUST_SEED_PATH"]);

  // Engine is ON by default; NORTHCINDER_TRUST_ENGINE=0 falls back to the seed stub.
  if (env["NORTHCINDER_TRUST_ENGINE"] === "0") {
    return createSeedTrustProvider(seed);
  }

  // Trust corpus is state within the same canonical/legacy-compatible local
  // authorization domain as mandates; never invent a parallel ~/.northcinder.
  const corpusDir = env["NORTHCINDER_TRUST_CORPUS_DIR"] ?? join(resolveConfigDir(env), "trust");
  const store = createTrustCorpusStore({ dir: corpusDir });

  const sourceClass = env["NORTHCINDER_TRANCO_SOURCE_CLASS"] === "commercial_clean"
    ? "commercial_clean"
    : env["NORTHCINDER_TRANCO_SOURCE_CLASS"] === "development_noncommercial"
      ? "development_noncommercial"
      : undefined;
  const configuredPath = env["NORTHCINDER_TRANCO_LIST_PATH"];
  const commercialUrl = env["NORTHCINDER_TRANCO_LIST_URL"];
  const listId = env["NORTHCINDER_TRANCO_LIST_ID"];
  const normalizedUrl = commercialUrl ? normalizeTrancoSourceUrl(commercialUrl) : undefined;
  const sourceAllowed = sourceClass === "commercial_clean"
    ? Boolean(listId && normalizedUrl && !isTrancoHostedUrl(normalizedUrl))
    : sourceClass === "development_noncommercial" && env["NORTHCINDER_TRANCO_ALLOW_DEV"] === "1";
  const expectedUrl = normalizedUrl ?? "https://tranco-list.eu/download/Z377G/1000000";
  const expectedId = listId ?? "default (development_noncommercial; CC-BY-NC)";
  const allowPath = Boolean(configuredPath && sourceAllowed && sourceClass && hasMatchingTrancoProvenance(configuredPath, {
    sourceClass,
    listId: expectedId,
    sourceUrl: expectedUrl,
  }));
  const tranco = createTrancoLookup({
    ...(allowPath && configuredPath ? { listPath: configuredPath } : {}),
    listId: allowPath ? expectedId : "unconfigured (popularity disabled)",
    ...(allowPath && sourceClass ? { sourceClass } : {}),
    ...(allowPath && sourceClass === "commercial_clean" && normalizedUrl ? { provenanceUrl: normalizedUrl } : {}),
    // A long-running service hot-reloads the list after `northcinder-trust-ingest`
    // refreshes it (throttled ~5 min), so a scheduled ingest goes live without
    // a restart. Off in tests/one-shots (no listPath).
    ...(allowPath && configuredPath ? { reload: { throttleMs: 300_000 } } : {}),
  });
  const phishtank = createPhishTankLookup(
    env["NORTHCINDER_PHISHTANK_DUMP_PATH"] ? { setPath: env["NORTHCINDER_PHISHTANK_DUMP_PATH"] } : {},
  );

  const probeConfig: ProbeConfig = {
    rdap: (domain) => probeRdap(domain),
    tranco: (domain) => tranco.lookup(domain),
    phishtank: (host) => phishtank.lookup(host),
    ...(env["NORTHCINDER_TRUST_CT"] === "1" ? { ct: (domain: string) => probeCt(domain) } : {}),
    ...(env["ABUSECH_AUTH_KEY"]
      ? { urlhaus: (host: string) => probeUrlhaus(host, { authKey: env["ABUSECH_AUTH_KEY"]! }) }
      : {}),
  };

  const budgetMs = env["NORTHCINDER_TRUST_BUDGET_MS"] ? Number(env["NORTHCINDER_TRUST_BUDGET_MS"]) : undefined;
  return createSignalTrustProvider({
    store,
    seed,
    refreshProbes: createRefreshProbes(probeConfig),
    ...(budgetMs !== undefined && Number.isFinite(budgetMs) ? { budgetMs } : {}),
  });
}
