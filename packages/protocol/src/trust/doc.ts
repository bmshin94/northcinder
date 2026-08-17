import { TRUST_THRESHOLDS, TRUST_DERIVATION_CODES } from "./derive.js";

/**
 * Generator for the machine-verified section of docs/TRUST.md — the exact
 * mirror of the ranking-doc pipeline (src/ranking/doc.ts).
 *
 * The doc-drift test (packages/protocol/test/trust-doc.test.ts) regenerates
 * this block and diffs it against the committed file. SCOPE of the drift
 * guarantee: the THRESHOLD VALUES (`TRUST_THRESHOLDS`) and the derivation
 * CODES (`TRUST_DERIVATION_CODES`) are introspected from derive.ts, so
 * changing either without regenerating fails CI. The rule-table PROSE is
 * hand-authored and NOT introspected — a change to a comparison operator or
 * branch order in derive.ts is caught by the derive unit tests
 * (trust-derive.test.ts boundary cases), not by this doc-drift diff.
 * Regenerate with `pnpm --filter @northcinder/protocol gen:trust-doc`.
 */

export const TRUST_DOC_BEGIN_MARKER = "<!-- BEGIN GENERATED: northcinder-trust-spec (do not edit by hand) -->";
export const TRUST_DOC_END_MARKER = "<!-- END GENERATED: northcinder-trust-spec -->";

/**
 * Human meaning of every TRUST_THRESHOLDS entry. Typed against the thresholds
 * object itself, so adding a threshold without documenting it is a COMPILE error.
 */
const THRESHOLD_DOCS: Record<keyof typeof TRUST_THRESHOLDS, string> = {
  knownMinDomainAgeDays:
    "minimum measured domain age (days) for the established-domain rule — 3 years; domain age is the single most predictive fake-shop signal in the research corpus, and an aged domain costs an attacker real money (≥ $1k), so it is cost-asymmetric, not seller-controllable",
  knownMaxPopularityRank:
    "maximum measured popularity rank (e.g. Tranco; 1 = most popular) for the established-domain rule — sustained real-traffic popularity at top-1M scale is expensive to fake",
};

/** The full generated block, markers included. */
export function renderTrustDoc(): string {
  const rows = (Object.keys(TRUST_THRESHOLDS) as Array<keyof typeof TRUST_THRESHOLDS>).map(
    (key) => `| \`${key}\` | ${TRUST_THRESHOLDS[key]} | ${THRESHOLD_DOCS[key]} |`,
  );

  return [
    TRUST_DOC_BEGIN_MARKER,
    "",
    "### Level derivation (`deriveTrustLevel` in `packages/protocol/src/trust/derive.ts`)",
    "",
    "Pure and deterministic: no clock, no randomness, no I/O; same inputs →",
    "byte-identical output. Inputs are MEASUREMENTS and curation hits (never raw",
    "provider output, never seller-controlled data). Rule table, first match wins:",
    "",
    "| # | Rule | Level | Machine reason code |",
    "| --- | --- | --- | --- |",
    `| 1 | locally configured deny-seed hit | \`flagged\` | \`${TRUST_DERIVATION_CODES.DENY_LISTED}\` |`,
    `| 2 | curated external fraud-list hit | \`flagged\` | \`${TRUST_DERIVATION_CODES.CURATED_FRAUD_LISTED}\` |`,
    `| 3 | locally configured allow-seed hit | \`trusted\` | \`${TRUST_DERIVATION_CODES.ALLOW_LISTED}\` |`,
    `| 4 | storefront on an established platform domain | \`known\` | \`${TRUST_DERIVATION_CODES.PLATFORM_HOSTED}\` |`,
    `| 5 | domain age ≥ \`knownMinDomainAgeDays\` AND popularity rank ≤ \`knownMaxPopularityRank\` | \`known\` | \`${TRUST_DERIVATION_CODES.ESTABLISHED_DOMAIN}\` |`,
    `| 6 | otherwise | \`unknown\` | \`${TRUST_DERIVATION_CODES.NO_POSITIVE_HISTORY}\` |`,
    "",
    "### Thresholds (`TRUST_THRESHOLDS`), with rationale",
    "",
    "| Threshold | Value | Why this value |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "### Hard invariants (property-tested)",
    "",
    "- **`flagged` requires deny-grade evidence** (deny seed or a curated fraud",
    "  list). No combination of automated signals — age, rank, platform, or their",
    "  absence — can ever produce `flagged`.",
    "- **Absence of history is never negative evidence.** A young, unranked, or",
    "  unmeasured domain can prevent `known`; it can never push a merchant below",
    "  `unknown` — `unknown` is the floor for no-history.",
    "- **No seller-controlled input can raise trust.** Every input is either",
    "  locally curated by the deployer or attacker-cost-asymmetric.",
    "",
    "### Trust keying (`trustKey` in `packages/protocol/src/trust/key.ts`)",
    "",
    "Trust maps are keyed by the merchant's verifiable identity, not the bare",
    "`merchant.id` (which collides across stores):",
    "",
    "- `merchant.domain` when `merchant.id === merchant.domain` (domain-anchored stores);",
    "- `${domain}#${id}` otherwise (sub-merchants on a shared platform domain,",
    "  e.g. marketplace sellers).",
    "",
    "`RankingInputs.trust`, the `rankOffers` lookup, the `/v1/search` trustSignals",
    "map, the client's re-rank verification and the remote bridge's re-verification",
    "all use this key in lockstep. `TrustSignal.merchantId` is unchanged — it names",
    "the merchant; only how trust maps are keyed changed.",
    "",
    TRUST_DOC_END_MARKER,
  ].join("\n");
}
