import type { TrustEvidence } from "@northcinder/protocol";

/**
 * Every trust signal probe (RDAP, Tranco, PhishTank, CT, URLhaus) returns this
 * discriminated union — never throws across the boundary (spec §5.2 "honest
 * degrade"). `ok:true` carries a typed MEASUREMENT (the machine fact the engine
 * adapts into `TrustDerivationInputs`) plus one re-checkable `TrustEvidence`
 * line (source + fact + fetchedAt + url). `ok:false` carries a short, logged
 * `reason` — a probe that is unavailable, times out, 404s, or returns garbage
 * is INDISTINGUISHABLE to the derivation from "signal absent", which by
 * spec §4 invariant 1 can only ever hold a merchant at `unknown`, never lower.
 */
export type SignalResult<M> =
  | { ok: true; measurement: M; evidence: TrustEvidence }
  | { ok: false; reason: string };
