/**
 * Signal trust engine — the cache-first `TrustProvider` (spec §5.2, §4.5). It
 * feeds the OPEN, pure `deriveTrustLevel` (from @northcinder/protocol) with two input
 * layers:
 *   1. CURATION (instant, live): local-deployer allow/deny + platform-domain hits from
 *      the seed. Deny/allow are authoritative and SHORT-CIRCUIT — no probe.
 *   2. MEASURED signals (cached): the probe-derived corpus record (domain age,
 *      popularity rank, curated-fraud hit) with its re-checkable evidence lines.
 *
 * Latency contract (§4.5): the search path NEVER blocks on cold probes beyond
 * `budgetMs`. On a fresh corpus hit we derive and return with zero I/O. On a
 * cold/stale miss we schedule a bounded, per-key-DEDUPED background refresh and
 * race it against the budget: if it lands in time we return the fresh signals,
 * otherwise we return the best-available (stale record, or `unknown` + a
 * "signals pending" line) and let the refresh finish and persist in the
 * background — warm on the next search. Given a stored record, output is
 * deterministic (no clock- or probe-dependence on the hot path).
 */
import {
  deriveTrustLevel,
  trustKey,
  type Merchant,
  type TrustDerivationInputs,
  type TrustEvidence,
  type TrustSignal,
} from "@northcinder/protocol";
import type { TrustProvider, TrustSeed, TrustSeedEntry } from "./seed-trust.js";
import type { CorpusInputs, TrustCorpusStore } from "./store.js";
import type { RefreshProbes } from "./probes.js";

const DEFAULT_BUDGET_MS = 800;
/** 7 days: domain age / popularity move slowly; a weekly refresh is ample. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SignalTrustProviderOptions {
  store: TrustCorpusStore;
  seed: TrustSeed;
  refreshProbes: RefreshProbes;
  /** Hot-path budget for a cold/stale miss (default 800ms, spec §5.2). */
  budgetMs?: number;
  /** Corpus record freshness horizon (default 7 days). */
  ttlMs?: number;
  now?: () => Date;
}

function domainMatches(domain: string, seedDomain: string): boolean {
  const d = domain.toLowerCase();
  const s = seedDomain.toLowerCase();
  return d === s || d.endsWith(`.${s}`);
}
function probeKey(domain: string): string {
  return domain.toLowerCase().replace(/\.+$/, "");
}
function findEntry(entries: TrustSeedEntry[], domain: string): TrustSeedEntry | undefined {
  return entries.find((e) => domainMatches(domain, e.domain));
}

interface SeedEvaluation {
  inputs: Pick<TrustDerivationInputs, "allowHit" | "denyHit" | "platformHit">;
  evidence: TrustEvidence[];
  /** Set when deny/allow is authoritative — the engine can skip probes entirely. */
  shortCircuit: boolean;
}

/** Curation layer: instant, live, no I/O. Only the verifiable DOMAIN is matched. */
function evaluateSeed(seed: TrustSeed, domain: string): SeedEvaluation {
  const denied = findEntry(seed.deny, domain);
  if (denied) {
    return { inputs: { denyHit: true }, evidence: [{ source: "seed-list", detail: `deny-listed: ${denied.detail}` }], shortCircuit: true };
  }
  const allowed = findEntry(seed.allow, domain);
  if (allowed) {
    return { inputs: { allowHit: true }, evidence: [{ source: "seed-list", detail: `allow-listed: ${allowed.detail}` }], shortCircuit: true };
  }
  const platform = findEntry(seed.knownPlatformDomains, domain);
  if (platform) {
    return { inputs: { platformHit: true }, evidence: [{ source: "platform-heuristic", detail: platform.detail }], shortCircuit: false };
  }
  return { inputs: {}, evidence: [], shortCircuit: false };
}

function toSignal(merchant: Merchant, inputs: TrustDerivationInputs, evidence: TrustEvidence[]): TrustSignal {
  const { level } = deriveTrustLevel(inputs);
  // Evidence is non-empty by construction (schema min(1)); a merchant with no
  // curation and no measured signals still carries the explicit unknown floor.
  const lines =
    evidence.length > 0
      ? evidence
      : [
          {
            source: "default-unknown",
            detail: `merchant "${merchant.id}" (${merchant.domain}) has no curated hit and no verifiable signals yet — explicitly unknown, never silently trusted`,
          },
        ];
  return { merchantId: merchant.id, level, evidence: lines };
}

export function createSignalTrustProvider(options: SignalTrustProviderOptions): TrustProvider {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => new Date());
  const { store, seed, refreshProbes } = options;

  // Per-key refresh dedupe: concurrent cold lookups for one merchant share one
  // probe run (bounded work — the map holds at most one promise per key).
  const inFlight = new Map<string, Promise<void>>();

  function scheduleRefresh(key: string, merchant: Merchant): Promise<void> {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = (async () => {
      const { inputs, evidence } = await refreshProbes(merchant);
      store.put({ key, inputs, evidence, fetchedAt: now().toISOString(), ttlMs });
    })()
      .catch(() => {
        // Honest degrade: a failed refresh leaves the corpus untouched; the
        // next lookup simply tries again. Never throws across the boundary.
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, promise);
    return promise;
  }

  const PENDING_LINE: TrustEvidence = {
    source: "trust-engine",
    detail: "verifiable signals are still being fetched for this merchant — re-check shortly (signals pending)",
  };
  const REFRESHING_LINE: TrustEvidence = {
    source: "trust-engine",
    detail: "showing cached signals while fresher ones are fetched in the background",
  };

  return {
    async trustSignal(merchant: Merchant): Promise<TrustSignal> {
      const key = probeKey(merchant.domain);
      const legacyKey = trustKey(merchant);
      const seedEval = evaluateSeed(seed, merchant.domain);

      // Curation short-circuit: deny/allow are authoritative and instant.
      if (seedEval.shortCircuit) {
        return toSignal(merchant, seedEval.inputs, seedEval.evidence);
      }

      const record = store.get(key) ?? store.get(legacyKey);
      // Merge curation + measured signals, omitting undefined so
      // exactOptionalPropertyTypes stays happy and absence means absence.
      const merge = (probe: CorpusInputs): TrustDerivationInputs => {
        const out: TrustDerivationInputs = { ...seedEval.inputs };
        if (probe.domainAgeDays !== undefined) out.domainAgeDays = probe.domainAgeDays;
        if (probe.popularityRank !== undefined) out.popularityRank = probe.popularityRank;
        if (probe.curatedFraudHit !== undefined) out.curatedFraudHit = probe.curatedFraudHit;
        return out;
      };

      if (record && store.isFresh(record, now())) {
        // Fresh corpus hit: pure, deterministic, zero I/O on the hot path.
        return toSignal(merchant, merge(record.inputs), [...seedEval.evidence, ...record.evidence]);
      }

      // Cold or stale: race a deduped background refresh against the budget.
      const refresh = scheduleRefresh(key, { ...merchant, domain: key });
      const timedOut = Symbol("timeout");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), budgetMs);
      });
      const outcome = await Promise.race([refresh.then(() => "done" as const), budget]);
      if (timer) clearTimeout(timer);

      if (outcome === "done") {
        const fresh = store.get(key);
        if (fresh) {
          return toSignal(merchant, merge(fresh.inputs), [...seedEval.evidence, ...fresh.evidence]);
        }
        // Refresh completed but produced no record (all probes failed to persist):
        // fall through to best-available below.
      }

      // Budget expired (or empty refresh): serve best-available, keep refreshing.
      if (record) {
        return toSignal(merchant, merge(record.inputs), [...seedEval.evidence, ...record.evidence, REFRESHING_LINE]);
      }
      return toSignal(merchant, seedEval.inputs, [...seedEval.evidence, PENDING_LINE]);
    },
  };
}
