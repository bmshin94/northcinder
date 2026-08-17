# NorthCinder trust: the deterministic, auditable specification

This document explains how NorthCinder derives a merchant's trust level. Like the
[ranking specification](./RANKING.md), it is **deterministic and auditable**, never a claim that a
merchant is “provably safe”:

- The derivation is open in
  [`packages/protocol/src/trust/derive.ts`](../packages/protocol/src/trust/derive.ts) and ships in
  `@northcinder/protocol`. The buyer-run aggregation engine uses the same code and is included in this
  MIT-licensed repository. No NorthCinder-operated trust or aggregation endpoint exists.
- Every evidence line names the source and measured fact. Probe-measured lines can carry a
  `fetchedAt` timestamp and a `url` recheck pointer.
- The generated section below comes from the trust derivation source. Regenerate it with
  `corepack pnpm --filter @northcinder/protocol gen:trust-doc`; the protocol drift test compares the
  generated block byte for byte.

## What the levels mean

- `trusted`: vetted through the local deployer's allow seed.
- `known`: clears the documented established-store threshold through an established platform or
  measured domain age plus sustained popularity. It is not an endorsement.
- `unknown`: no positive history. This is the no-history floor, not a negative judgment.
- `flagged`: deny-grade evidence only, from the local deployer's deny seed or a curated fraud source.
  Automated age, rank, platform, or missing-data heuristics cannot produce it.

Trust verification is bounded by the inputs and evidence disclosed. The buyer or independent
deployer controls the configured feeds and is responsible for their provenance and retention; the
repository owner does not collect or operate them.

<!-- BEGIN GENERATED: northcinder-trust-spec (do not edit by hand) -->

### Level derivation (`deriveTrustLevel` in `packages/protocol/src/trust/derive.ts`)

Pure and deterministic: no clock, no randomness, no I/O; same inputs →
byte-identical output. Inputs are MEASUREMENTS and curation hits (never raw
provider output, never seller-controlled data). Rule table, first match wins:

| # | Rule | Level | Machine reason code |
| --- | --- | --- | --- |
| 1 | locally configured deny-seed hit | `flagged` | `deny_listed` |
| 2 | curated external fraud-list hit | `flagged` | `curated_fraud_listed` |
| 3 | locally configured allow-seed hit | `trusted` | `allow_listed` |
| 4 | storefront on an established platform domain | `known` | `platform_hosted` |
| 5 | domain age ≥ `knownMinDomainAgeDays` AND popularity rank ≤ `knownMaxPopularityRank` | `known` | `established_domain` |
| 6 | otherwise | `unknown` | `no_positive_history` |

### Thresholds (`TRUST_THRESHOLDS`), with rationale

| Threshold | Value | Why this value |
| --- | --- | --- |
| `knownMinDomainAgeDays` | 1095 | minimum measured domain age (days) for the established-domain rule — 3 years; domain age is the single most predictive fake-shop signal in the research corpus, and an aged domain costs an attacker real money (≥ $1k), so it is cost-asymmetric, not seller-controllable |
| `knownMaxPopularityRank` | 1000000 | maximum measured popularity rank (e.g. Tranco; 1 = most popular) for the established-domain rule — sustained real-traffic popularity at top-1M scale is expensive to fake |

### Hard invariants (property-tested)

- **`flagged` requires deny-grade evidence** (deny seed or a curated fraud
  list). No combination of automated signals — age, rank, platform, or their
  absence — can ever produce `flagged`.
- **Absence of history is never negative evidence.** A young, unranked, or
  unmeasured domain can prevent `known`; it can never push a merchant below
  `unknown` — `unknown` is the floor for no-history.
- **No seller-controlled input can raise trust.** Every input is either
  locally curated by the deployer or attacker-cost-asymmetric.

### Trust keying (`trustKey` in `packages/protocol/src/trust/key.ts`)

Trust maps are keyed by the merchant's verifiable identity, not the bare
`merchant.id` (which collides across stores):

- `merchant.domain` when `merchant.id === merchant.domain` (domain-anchored stores);
- `${domain}#${id}` otherwise (sub-merchants on a shared platform domain,
  e.g. marketplace sellers).

`RankingInputs.trust`, the `rankOffers` lookup, the `/v1/search` trustSignals
map, the client's re-rank verification and the remote bridge's re-verification
all use this key in lockstep. `TrustSignal.merchantId` is unchanged — it names
the merchant; only how trust maps are keyed changed.

<!-- END GENERATED: northcinder-trust-spec -->
