# NorthCinder ranking: the deterministic, auditable spec

This document is the human-readable specification of how NorthCinder orders offers.
The ranking is **deterministic and auditable** (never "provably neutral"): the
ordering itself is a check your own machine runs, not a promise you take on
faith — with an honest scope, spelled out in
[What verification proves — and what it doesn't](#what-verification-proves--and-what-it-doesnt):

- The implementation is **open**: [`packages/protocol/src/ranking/rank.ts`](../packages/protocol/src/ranking/rank.ts),
  shipped in `@northcinder/protocol`. The aggregation service implementation in this source tree uses
  this open ranker when run locally.
- Every `/v1/search` response returns **all the ranking inputs** — the offers
  and the `trustSignals` the ranking consumed — so the open client re-runs
  `rankOffers` locally and diffs the service's order (`verifySearchRanking`).
  A boosted re-order is flagged `rankingVerified: false` with the exact
  divergence, in both the tool output and your local audit log.
- The section between the markers below is **generated from the code** by
  `corepack pnpm --filter @northcinder/protocol gen:ranking-doc`. The protocol drift test
  (`packages/protocol/test/ranking-doc.test.ts`) compares the committed generated section with the
  exact renderer output and fails when they differ.
- A deterministic, on-demand probe battery is recorded in
  [NEUTRALITY-AUDIT.md](./NEUTRALITY-AUDIT.md) for the measured choice profile
  (position-shuffle, sponsored-injection, and attribute-weight probe batteries).

## What verification proves — and what it doesn't

Client-side verification proves that the **ordering, scores, and reasons are
exactly what the open `rankOffers` produces GIVEN the inputs the service
disclosed**. Within that scope it is airtight: the service cannot boost, bury,
or re-score any offer relative to the data it showed you without being flagged.

It does **not** prove the disclosed inputs are themselves honest. A dishonest
service could fabricate trust levels, strip an offer's `sponsored` flag, or
curate the offer set (drop or invent offers) — and then rank honestly over
those doctored inputs, passing with `rankingVerified: true`. The trust levels,
sponsored flags, and offer-set completeness are the service's **claims**, and
today they are only partially cross-checkable: you can independently re-query
any merchant's trust level via `/v1/trust`, and the evidence strings inside
each result's `reasons` expose what the ranking believed about each merchant.
Offer-set and flag honesty ultimately rest on the service and its adapters
being truthful about their sources — which is why the client's audit log keeps
a summary of every ranked response (per-offer id, store, price, sponsored flag,
score, reasons, and the verification outcome), so after-the-fact comparison
against the stores themselves stays possible.

## What the ranking optimizes

Only the buyer's criteria, exactly as sent in the search query: price, budget,
must-have attributes, delivery deadline, availability, merchant trust, and
ethics preferences. Every ranked result carries machine-readable `reasons`
naming the criteria that produced its position.

<!-- BEGIN GENERATED: northcinder-ranking-spec (do not edit by hand) -->

### Score weights (`RANK_WEIGHTS` in `packages/protocol/src/ranking/rank.ts`)

| Weight | Points | Applies when |
| --- | --- | --- |
| `priceBest` | +40 | linear within a currency group: cheapest offer earns the full points, priciest earns 0 |
| `overBudgetPenalty` | −25 | the offer price exceeds the buyer's `maxPrice` budget (same currency) |
| `specMatchFull` | +30 | scaled by the fraction of `mustHaveAttributes` the offer matches |
| `specMissPenaltyEach` | −10 | per required attribute the offer is missing |
| `deliveryMeets` | +10 | the promised delivery date meets the buyer's `deliveryBy` |
| `deliveryMissesPenalty` | −15 | the promised delivery date misses the buyer's `deliveryBy` |
| `inStock` | +5 | availability is `in_stock` |
| `preorderPenalty` | −5 | availability is `preorder` |
| `outOfStockPenalty` | −20 | availability is `out_of_stock` |
| `trustTrusted` | +10 | the merchant's trust signal is `trusted` |
| `trustKnown` | +5 | the merchant's trust signal is `known` |
| `flaggedPenalty` | −40 | the merchant's trust signal is `flagged` |
| `ethicsMatchFull` | +8 | scaled by the fraction of the buyer's `ethicsFlags` the offer matches |

### Rules the score never sees

- **Sponsored placement is NOT a score input.** `sponsored: true` contributes zero
  points in either direction. Instead, every sponsored offer is placed in a
  **strictly lower tier** than every non-sponsored offer, is always labeled, and
  always carries the reason: `sponsored listing: labeled and ranked below all non-sponsored offers`.
  Tested property: setting `sponsored: true` on any offer can never raise its rank.
- **There is no input a seller can pay to influence.** Scores derive only from the
  buyer's criteria: price, spec match, delivery, availability, merchant trust, ethics.

### Ordering

Tiers, in order: non-sponsored before sponsored (primary — the brand promise),
then buyable before out-of-stock (secondary — a buyer cannot buy what isn't there;
tested property: setting `out_of_stock` can never raise a rank). Within a tier,
offers are ordered by score (desc), then price (asc), then offer id (asc) — a
total, input-order-independent order. The ranking is pure and deterministic: no
clock, no randomness, no I/O; same inputs → byte-identical output.

<!-- END GENERATED: northcinder-ranking-spec -->

## How to verify a service response

1. Search via the open client (`@northcinder/client`): every `search_products`
   result includes `rankingVerified`, computed on YOUR machine by re-running
   the open `rankOffers` over the offers + trust signals the service returned.
2. Or do it by hand: take any `/v1/search` response, feed `results[].offer`
   and `trustSignals` to `rankOffers(offers, query, { trust })` from
   `@northcinder/protocol`, and compare orders, scores, and reasons.

Both checks verify the ordering **over the inputs the service disclosed** —
see [What verification proves — and what it doesn't](#what-verification-proves--and-what-it-doesnt)
for exactly what that does and does not cover. To probe input honesty, spot-check
merchants independently via `/v1/trust` and compare the evidence strings in
`reasons` against what you know about the merchant.
