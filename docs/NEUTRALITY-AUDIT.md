# Neutrality self-audit — measured choice profile

GENERATED FILE — do not edit. Emitted by `packages/protocol/scripts/neutrality-audit.ts`
(deterministic: fixed seed 20260705, no clock, no unseeded randomness — the same run is
byte-identical every time). Regenerate with `pnpm --filter @northcinder/protocol neutrality-audit`;
the drift test `packages/protocol/test/neutrality-audit.test.ts` regenerates this report in CI
and a neutrality regression or a stale committed copy is a test failure.

ACES-style probe batteries (dimensions after arXiv:2508.02630) run against the OPEN,
published ranking `rankOffers` (`packages/protocol/src/ranking/rank.ts`) — the same code
the client re-runs to verify the deployed service. The claim under audit is
"deterministic and auditable" ranking: rank order derives only from the buyer's criteria,
and paid placement can never help.

## Battery verdicts

| Battery | Verdict | Measurement |
| --- | --- | --- |
| position-shuffle invariance (input order can never influence the ranking) | PASS | 50 synthetic offer sets × 5 shuffles each = 250 re-rankings; 0 diverged from the canonical order |
| sponsored-flag injection (paying for placement can only ever hurt) | PASS | 99 sponsored-flag flips on organic offers: 0 rank improvements, 0 score changes, 0 offers left above an organic offer, 0 missing de-prioritization labels |
| attribute-weight probes (every measured score delta equals the published weight) | PASS | 11 single-dimension probes; 0 measured deltas diverged from the published RANK_WEIGHTS |

## Measured choice profile (attribute-weight probes)

Each probe perturbs exactly one dimension between otherwise-identical synthetic offers
and measures the score response. Measured deltas must equal the published `RANK_WEIGHTS`
(see docs/RANKING.md) — including the sponsored row, which must measure exactly 0:
paid placement is tier-and-label only, never a score input.

| Dimension | Probe | Expected Δscore | Measured Δscore |
| --- | --- | --- | --- |
| price | cheapest vs priciest offer in the set (all else identical) | +40 | +40 |
| price | same offer, over the buyer's budget vs within it | -25 | -25 |
| spec_match | matches the required attribute vs missing it (1 must-have) | +40 | +40 |
| delivery | promised delivery meets vs misses the buyer's deadline | +25 | +25 |
| availability | in_stock vs out_of_stock | +25 | +25 |
| availability | in_stock vs preorder | +10 | +10 |
| trust | merchant trust level `trusted` vs no trust signal | +10 | +10 |
| trust | merchant trust level `known` vs no trust signal | +5 | +5 |
| trust | merchant trust level `flagged` vs no trust signal | -40 | -40 |
| ethics | matches the buyer's ethics preference vs not | +8 | +8 |
| sponsored | identical offers, sponsored flag flipped (paid placement as the ONLY difference) | 0 | 0 |
