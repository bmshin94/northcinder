/**
 * Probe composition — turns the individual signal modules into a single
 * `refreshProbes(merchant)` the engine can run on a cold/stale corpus miss. It
 * runs the available probes in parallel and ADAPTS each successful measurement
 * into the probe-derived subset of `TrustDerivationInputs` (spec §5.2), while
 * collecting every probe's re-checkable evidence line.
 *
 * Mapping (the ONLY place probe measurements become derivation inputs):
 *  - RDAP  ok → `domainAgeDays`      (age; the strongest positive signal)
 *  - Tranco ok → `popularityRank`    (popularity; combined with age ⇒ `known`)
 *  - PhishTank ok → `curatedFraudHit`(DENY-grade; may drive `flagged` per §4.2)
 *  - URLhaus  ok → EVIDENCE-ONLY note (weak/automated; never an input, never flags)
 *  - CT ok → evidence ONLY, no input (informational; age comes from RDAP)
 * A failed probe contributes nothing — indistinguishable from "signal absent",
 * which by §4.1 can only hold a merchant at `unknown`, never lower.
 */
import type { Merchant, TrustEvidence } from "@northcinder/protocol";
import type { CorpusInputs } from "./store.js";
import type { SignalResult } from "./signals/result.js";
import type { RdapMeasurement } from "./signals/rdap.js";
import type { TrancoMeasurement } from "./signals/tranco.js";
import type { PhishTankMeasurement } from "./signals/phishtank.js";
import type { CtMeasurement } from "./signals/ct.js";
import type { UrlhausMeasurement } from "./signals/urlhaus.js";

export interface RefreshResult {
  inputs: CorpusInputs;
  evidence: TrustEvidence[];
}

export interface ProbeConfig {
  rdap?: (domain: string) => Promise<SignalResult<RdapMeasurement>>;
  tranco?: (domain: string) => SignalResult<TrancoMeasurement>;
  phishtank?: (host: string) => SignalResult<PhishTankMeasurement>;
  /** Best-effort, off the hot path — only run when explicitly enabled. */
  ct?: (domain: string) => Promise<SignalResult<CtMeasurement>>;
  urlhaus?: (host: string) => Promise<SignalResult<UrlhausMeasurement>>;
}

export type RefreshProbes = (merchant: Merchant) => Promise<RefreshResult>;

export function createRefreshProbes(config: ProbeConfig): RefreshProbes {
  return async (merchant) => {
    const domain = merchant.domain;
    const inputs: CorpusInputs = {};
    const evidence: TrustEvidence[] = [];

    const [rdap, tranco, phishtank, ct, urlhaus] = await Promise.all([
      config.rdap ? config.rdap(domain) : Promise.resolve<SignalResult<RdapMeasurement> | undefined>(undefined),
      Promise.resolve(config.tranco ? config.tranco(domain) : undefined),
      Promise.resolve(config.phishtank ? config.phishtank(domain) : undefined),
      config.ct ? config.ct(domain) : Promise.resolve<SignalResult<CtMeasurement> | undefined>(undefined),
      config.urlhaus ? config.urlhaus(domain) : Promise.resolve<SignalResult<UrlhausMeasurement> | undefined>(undefined),
    ]);

    if (rdap?.ok) {
      inputs.domainAgeDays = rdap.measurement.domainAgeDays;
      evidence.push(rdap.evidence);
    }
    if (tranco?.ok) {
      inputs.popularityRank = tranco.measurement.rank;
      evidence.push(tranco.evidence);
    }
    if (phishtank?.ok) {
      // PhishTank is HUMAN-VERIFIED phishing → the only automated deny-grade
      // path. This is the one probe permitted to drive `flagged` (§4.2).
      inputs.curatedFraudHit = true;
      evidence.push(phishtank.evidence);
    }
    if (urlhaus?.ok) {
      // URLhaus is an AUTOMATED malware-URL feed — weak for shop fraud and
      // prone to shared-hosting false-correlation (spec §6: "weak, lowest
      // priority"). It must NOT auto-flag an honest merchant (the core
      // anti-ScamAdviser risk), so it is EVIDENCE-ONLY: the listing is
      // surfaced for the human but never sets a derivation input. In practice
      // a genuine malware host cannot independently clear the `known` bar
      // (3-year domain AND top-1M rank), so it stays `unknown` with the note.
      evidence.push(urlhaus.evidence);
    }
    if (ct?.ok) {
      evidence.push(ct.evidence); // informational only — never an input
    }

    return { inputs, evidence };
  };
}
