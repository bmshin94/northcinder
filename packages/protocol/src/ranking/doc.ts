import {
  PREFERRED_CRITERION_POINTS,
  RANK_ELIMINATION_CODES,
  RANK_WEIGHTS,
  SPONSORED_DEPRIORITIZATION_DETAIL,
} from "./rank.js";

/**
 * Generator for the machine-verified section of docs/RANKING.md.
 *
 * The doc-drift test (packages/protocol/test/ranking-doc.test.ts) regenerates
 * this block and diffs it against the committed file: change a weight in
 * rank.ts without regenerating the doc and CI fails. Regenerate with
 * `pnpm --filter @northcinder/protocol gen:ranking-doc`.
 */

export const RANKING_DOC_BEGIN_MARKER = "<!-- BEGIN GENERATED: northcinder-ranking-spec (do not edit by hand) -->";
export const RANKING_DOC_END_MARKER = "<!-- END GENERATED: northcinder-ranking-spec -->";

/**
 * Human meaning of every RANK_WEIGHTS entry. Typed against the weights object
 * itself, so adding a weight without documenting it is a COMPILE error.
 */
const WEIGHT_DOCS: Record<keyof typeof RANK_WEIGHTS, { direction: "+" | "−"; when: string }> = {
  priceBest: { direction: "+", when: "linear within a currency group: cheapest offer earns the full points, priciest earns 0" },
  overBudgetPenalty: { direction: "−", when: "the offer price exceeds the buyer's `maxPrice` budget (same currency)" },
  specMatchFull: { direction: "+", when: "scaled by the fraction of `mustHaveAttributes` the offer matches" },
  specMissPenaltyEach: { direction: "−", when: "per required attribute the offer is missing" },
  deliveryMeets: { direction: "+", when: "the promised delivery date meets the buyer's `deliveryBy`" },
  deliveryMissesPenalty: { direction: "−", when: "the promised delivery date misses the buyer's `deliveryBy`" },
  inStock: { direction: "+", when: "availability is `in_stock`" },
  preorderPenalty: { direction: "−", when: "availability is `preorder`" },
  outOfStockPenalty: { direction: "−", when: "availability is `out_of_stock`" },
  trustTrusted: { direction: "+", when: "the merchant's trust signal is `trusted`" },
  trustKnown: { direction: "+", when: "the merchant's trust signal is `known`" },
  flaggedPenalty: { direction: "−", when: "the merchant's trust signal is `flagged`" },
  ethicsMatchFull: { direction: "+", when: "scaled by the fraction of the buyer's `ethicsFlags` the offer matches" },
};

/** The full generated block, markers included. */
export function renderRankingDoc(): string {
  const rows = (Object.keys(RANK_WEIGHTS) as Array<keyof typeof RANK_WEIGHTS>).map((key) => {
    const doc = WEIGHT_DOCS[key];
    return `| \`${key}\` | ${doc.direction}${RANK_WEIGHTS[key]} | ${doc.when} |`;
  });
  const preferredRows = (
    Object.keys(PREFERRED_CRITERION_POINTS) as Array<keyof typeof PREFERRED_CRITERION_POINTS>
  ).map(
    (kind) => `| \`${kind}\` | +${PREFERRED_CRITERION_POINTS[kind]} on match; 0 on miss |`,
  );

  return [
    RANKING_DOC_BEGIN_MARKER,
    "",
    "### Score weights (`RANK_WEIGHTS` in `packages/protocol/src/ranking/rank.ts`)",
    "",
    "| Weight | Points | Applies when |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "### Named criteria policy",
    "",
    "- **`required` criteria do not change scores.** A failed requirement places the",
    "  offer in the eliminated tier and adds the criterion id, importance, and one of",
    "  these stable codes:",
    `  \`${RANK_ELIMINATION_CODES.REQUIRED_ATTRIBUTE_MISSING}\`,`,
    `  \`${RANK_ELIMINATION_CODES.REQUIRED_PRICE_EXCEEDED}\`,`,
    `  \`${RANK_ELIMINATION_CODES.REQUIRED_DELIVERY_MISSED}\`,`,
    `  \`${RANK_ELIMINATION_CODES.REQUIRED_DELIVERY_UNKNOWN}\`,`,
    `  \`${RANK_ELIMINATION_CODES.REQUIRED_ETHICS_MISSING}\`, or`,
    `  \`${RANK_ELIMINATION_CODES.REQUIRED_AVAILABILITY_MISMATCH}\`.`,
    "- **`preferred` criteria use fixed code-owned points.** Callers cannot provide",
    "  weights, component scores, or final scores.",
    "",
    "| Preferred kind | Fixed points |",
    "| --- | --- |",
    ...preferredRows,
    "",
    "- **`tie_breaker` criteria add zero points.** They compare typed facts only when",
    "  main scores are equal: lower price, earlier known delivery, an attribute or",
    "  ethics match, then equality with the requested availability value.",
    "",
    "### Rules the score never sees",
    "",
    "- **Sponsored placement is NOT a score input.** `sponsored: true` contributes zero",
    "  points in either direction. Instead, every sponsored offer is placed in a",
    "  **strictly lower tier** than every non-sponsored offer, is always labeled, and",
    `  always carries the reason: \`${SPONSORED_DEPRIORITIZATION_DETAIL}\`.`,
    "  Tested property: setting `sponsored: true` on any offer can never raise its rank.",
    "- **There is no input a seller can pay to influence.** Scores derive only from the",
    "  buyer's criteria: price, spec match, delivery, availability, merchant trust, ethics.",
    "",
    "### Ordering",
    "",
    "Tiers, in order: non-sponsored before sponsored (primary — the brand promise),",
    "then candidates meeting all named requirements before eliminated candidates, then",
    "buyable before out-of-stock (a buyer cannot buy what isn't there; tested property:",
    "setting `out_of_stock` can never raise a rank). Main score follows. When scores are",
    "equal, named tie breakers run in query order, then price (asc), then the canonical",
    "JSON `[sourceStore, offerId]` tuple (asc) provides a collision-free total,",
    "input-order-independent order. The ranking is pure and",
    "deterministic: no clock, no randomness, no I/O; same inputs → byte-identical output.",
    "Without named tie breakers, the legacy fallback remains score (desc), then price (asc), then the canonical store-scoped offer tuple (asc).",
    "Within one source store, that reduces to score (desc), then price (asc), then offer id (asc).",
    "",
    RANKING_DOC_END_MARKER,
  ].join("\n");
}
