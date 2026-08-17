import type { Offer, SearchQuery, TrustSignal } from "../schemas/core.js";
import { RANK_WEIGHTS, rankOffers } from "./rank.js";
import { trustKey } from "../trust/key.js";

/**
 * ACES-style neutrality self-audit (ranking verification; probe dimensions after arXiv:2508.02630):
 * runs the published open ranking over synthetic fixture batteries —
 * position shuffles, sponsored-flag injections, attribute-weight probes — and
 * measures the choice profile. Emitted as docs/NEUTRALITY-AUDIT.md by
 * `scripts/neutrality-audit.ts` and wired as a test so a neutrality
 * regression fails CI.
 *
 * DETERMINISTIC BY CONSTRUCTION: no Date.now, no Math.random — all
 * "randomness" comes from a seeded PRNG with a fixed published seed, so the
 * same audit run twice is byte-identical.
 */

export const NEUTRALITY_AUDIT_SEED = 20260705;

export interface AuditCheck {
  id: string;
  title: string;
  pass: boolean;
  detail: string;
}

export interface ChoiceProfileProbe {
  /** Scoring dimension probed (matches the rank criteria vocabulary). */
  dimension: string;
  /** What was perturbed, holding everything else fixed. */
  probe: string;
  expectedScoreDelta: number;
  measuredScoreDelta: number;
}

export interface NeutralityAuditResult {
  seed: number;
  checks: AuditCheck[];
  choiceProfile: ChoiceProfileProbe[];
  allPassed: boolean;
  /** The full deterministic markdown report (docs/NEUTRALITY-AUDIT.md). */
  report: string;
}

/** mulberry32 — tiny deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const QUERY: SearchQuery = { text: "audit probe" };

function makeOffer(overrides: {
  id: string;
  priceAmount: number;
  sponsored?: boolean;
  merchantId?: string;
  availability?: Offer["availability"];
  attributes?: Record<string, string>;
  deliveryBy?: string;
}): Offer {
  return {
    id: overrides.id,
    product: {
      id: `prod-${overrides.id}`,
      title: `Synthetic audit product ${overrides.id}`,
      url: `https://audit.invalid/products/${overrides.id}`,
      attributes: overrides.attributes ?? {},
    },
    price: { amount: overrides.priceAmount, currency: "EUR" },
    merchant: {
      id: overrides.merchantId ?? "audit-merchant",
      name: "Audit Merchant",
      domain: "audit.invalid",
    },
    availability: overrides.availability ?? "in_stock",
    ...(overrides.deliveryBy !== undefined ? { shipping: { deliveryBy: overrides.deliveryBy } } : {}),
    sourceStore: "audit-fixture",
    sponsored: overrides.sponsored ?? false,
  };
}

function trustSignal(merchantId: string, level: TrustSignal["level"]): TrustSignal {
  return { merchantId, level, evidence: [{ source: "audit-fixture", detail: `synthetic ${level} signal` }] };
}

function randomOfferSet(rnd: () => number, setIndex: number): { offers: Offer[]; trust: Record<string, TrustSignal> } {
  const n = 3 + Math.floor(rnd() * 8);
  const levels: Array<TrustSignal["level"]> = ["trusted", "known", "unknown", "flagged"];
  const trust: Record<string, TrustSignal> = {};
  const offers = Array.from({ length: n }, (_, i) => {
    const merchantId = `m${setIndex}-${Math.floor(rnd() * 4)}`;
    // Trust maps are keyed by trustKey(merchant) — fixture merchants share the
    // audit domain, so each id gets a distinct `domain#id` sub-key.
    trust[trustKey({ id: merchantId, domain: "audit.invalid" })] = trustSignal(
      merchantId,
      levels[Math.floor(rnd() * levels.length)]!,
    );
    return makeOffer({
      id: `s${setIndex}-o${i}`,
      priceAmount: 100 + Math.floor(rnd() * 100000),
      sponsored: rnd() < 0.3,
      merchantId,
      availability: (["in_stock", "out_of_stock", "preorder", "unknown"] as const)[Math.floor(rnd() * 4)]!,
    });
  });
  return { offers, trust };
}

function shuffled<T>(items: T[], rnd: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

// --- battery 1: position-shuffle invariance -------------------------------
function positionShuffleBattery(rnd: () => number): AuditCheck {
  const SETS = 50;
  const SHUFFLES = 5;
  let mismatches = 0;
  for (let s = 0; s < SETS; s++) {
    const { offers, trust } = randomOfferSet(rnd, s);
    const canonical = JSON.stringify(rankOffers(offers, QUERY, { trust }));
    for (let k = 0; k < SHUFFLES; k++) {
      if (JSON.stringify(rankOffers(shuffled(offers, rnd), QUERY, { trust })) !== canonical) mismatches++;
    }
  }
  return {
    id: "position-shuffle",
    title: "position-shuffle invariance (input order can never influence the ranking)",
    pass: mismatches === 0,
    detail: `${SETS} synthetic offer sets × ${SHUFFLES} shuffles each = ${SETS * SHUFFLES} re-rankings; ${mismatches} diverged from the canonical order`,
  };
}

// --- battery 2: sponsored-flag injection -----------------------------------
function sponsoredInjectionBattery(rnd: () => number): AuditCheck {
  const TRIALS = 100;
  let flips = 0;
  let rankImprovements = 0;
  let scoreChanges = 0;
  let tierViolations = 0;
  let missingLabels = 0;
  for (let t = 0; t < TRIALS; t++) {
    const { offers, trust } = randomOfferSet(rnd, 1000 + t);
    const organicIndexes = offers.map((o, i) => (o.sponsored ? -1 : i)).filter((i) => i >= 0);
    if (organicIndexes.length === 0) continue;
    const target = organicIndexes[Math.floor(rnd() * organicIndexes.length)]!;
    const targetId = offers[target]!.id;
    flips++;

    const before = rankOffers(offers, QUERY, { trust });
    const after = rankOffers(offers.map((o, i) => (i === target ? { ...o, sponsored: true } : o)), QUERY, { trust });

    const rankBefore = before.findIndex((r) => r.offer.id === targetId);
    const rankAfter = after.findIndex((r) => r.offer.id === targetId);
    if (rankAfter < rankBefore) rankImprovements++;
    if (after[rankAfter]!.score !== before[rankBefore]!.score) scoreChanges++;
    if (after.slice(rankAfter + 1).some((r) => !r.offer.sponsored)) tierViolations++;
    if (!after[rankAfter]!.reasons.some((r) => r.criterion === "sponsored_deprioritization")) missingLabels++;
  }
  // flips > 0 guards against a vacuous pass: a seed that produced no organic
  // offers to flip would otherwise "pass" without having tested anything.
  const pass =
    flips > 0 && rankImprovements === 0 && scoreChanges === 0 && tierViolations === 0 && missingLabels === 0;
  return {
    id: "sponsored-injection",
    title: "sponsored-flag injection (paying for placement can only ever hurt)",
    pass,
    detail:
      `${flips} sponsored-flag flips on organic offers: ${rankImprovements} rank improvements, ` +
      `${scoreChanges} score changes, ${tierViolations} offers left above an organic offer, ${missingLabels} missing de-prioritization labels`,
  };
}

// --- battery 3: attribute-weight probes (the measured choice profile) ------
function scoreOf(offers: Offer[], query: SearchQuery, trust: Record<string, TrustSignal>, id: string): number {
  const r = rankOffers(offers, query, { trust }).find((x) => x.offer.id === id);
  if (r === undefined) throw new Error(`audit probe offer ${id} missing from ranking`);
  return r.score;
}

function attributeProbes(): ChoiceProfileProbe[] {
  const probes: ChoiceProfileProbe[] = [];
  const NO_TRUST: Record<string, TrustSignal> = {};

  // price: cheapest vs priciest of a two-offer currency group.
  {
    const a = makeOffer({ id: "price-a", priceAmount: 1000 });
    const b = makeOffer({ id: "price-b", priceAmount: 2000 });
    probes.push({
      dimension: "price",
      probe: "cheapest vs priciest offer in the set (all else identical)",
      expectedScoreDelta: RANK_WEIGHTS.priceBest,
      measuredScoreDelta: scoreOf([a, b], QUERY, NO_TRUST, "price-a") - scoreOf([a, b], QUERY, NO_TRUST, "price-b"),
    });
  }
  // budget: the same offer under a budget it fits vs a budget it exceeds.
  {
    const a = makeOffer({ id: "budget-a", priceAmount: 2000 });
    const within: SearchQuery = { ...QUERY, maxPrice: { amount: 2500, currency: "EUR" } };
    const exceeded: SearchQuery = { ...QUERY, maxPrice: { amount: 1500, currency: "EUR" } };
    probes.push({
      dimension: "price",
      probe: "same offer, over the buyer's budget vs within it",
      expectedScoreDelta: -RANK_WEIGHTS.overBudgetPenalty,
      measuredScoreDelta: scoreOf([a], exceeded, NO_TRUST, "budget-a") - scoreOf([a], within, NO_TRUST, "budget-a"),
    });
  }
  // spec_match: full match vs zero match on one required attribute.
  {
    const query: SearchQuery = { ...QUERY, mustHaveAttributes: ["waterproof"] };
    const match = makeOffer({ id: "spec-a", priceAmount: 1000, attributes: { feature: "waterproof" } });
    const miss = makeOffer({ id: "spec-b", priceAmount: 1000 });
    probes.push({
      dimension: "spec_match",
      probe: "matches the required attribute vs missing it (1 must-have)",
      expectedScoreDelta: RANK_WEIGHTS.specMatchFull + RANK_WEIGHTS.specMissPenaltyEach,
      measuredScoreDelta: scoreOf([match, miss], query, NO_TRUST, "spec-a") - scoreOf([match, miss], query, NO_TRUST, "spec-b"),
    });
  }
  // delivery: promised date meets vs misses the requested deadline.
  {
    const query: SearchQuery = { ...QUERY, deliveryBy: "2030-06-15" };
    const meets = makeOffer({ id: "del-a", priceAmount: 1000, deliveryBy: "2030-06-10" });
    const misses = makeOffer({ id: "del-b", priceAmount: 1000, deliveryBy: "2030-06-20" });
    probes.push({
      dimension: "delivery",
      probe: "promised delivery meets vs misses the buyer's deadline",
      expectedScoreDelta: RANK_WEIGHTS.deliveryMeets + RANK_WEIGHTS.deliveryMissesPenalty,
      measuredScoreDelta: scoreOf([meets, misses], query, NO_TRUST, "del-a") - scoreOf([meets, misses], query, NO_TRUST, "del-b"),
    });
  }
  // availability probes.
  {
    const inStock = makeOffer({ id: "av-a", priceAmount: 1000, availability: "in_stock" });
    const outOfStock = makeOffer({ id: "av-b", priceAmount: 1000, availability: "out_of_stock" });
    const preorder = makeOffer({ id: "av-c", priceAmount: 1000, availability: "preorder" });
    const offers = [inStock, outOfStock, preorder];
    probes.push({
      dimension: "availability",
      probe: "in_stock vs out_of_stock",
      expectedScoreDelta: RANK_WEIGHTS.inStock + RANK_WEIGHTS.outOfStockPenalty,
      measuredScoreDelta: scoreOf(offers, QUERY, NO_TRUST, "av-a") - scoreOf(offers, QUERY, NO_TRUST, "av-b"),
    });
    probes.push({
      dimension: "availability",
      probe: "in_stock vs preorder",
      expectedScoreDelta: RANK_WEIGHTS.inStock + RANK_WEIGHTS.preorderPenalty,
      measuredScoreDelta: scoreOf(offers, QUERY, NO_TRUST, "av-a") - scoreOf(offers, QUERY, NO_TRUST, "av-c"),
    });
  }
  // trust probes: each level vs a merchant with no signal at all.
  {
    const probe = (level: TrustSignal["level"], expected: number): void => {
      const signaled = makeOffer({ id: "tr-a", priceAmount: 1000, merchantId: "signaled" });
      const unsignaled = makeOffer({ id: "tr-b", priceAmount: 1000, merchantId: "unsignaled" });
      const trust = {
        [trustKey({ id: "signaled", domain: "audit.invalid" })]: trustSignal("signaled", level),
      };
      probes.push({
        dimension: "trust",
        probe: `merchant trust level \`${level}\` vs no trust signal`,
        expectedScoreDelta: expected,
        measuredScoreDelta:
          scoreOf([signaled, unsignaled], QUERY, trust, "tr-a") - scoreOf([signaled, unsignaled], QUERY, trust, "tr-b"),
      });
    };
    probe("trusted", RANK_WEIGHTS.trustTrusted);
    probe("known", RANK_WEIGHTS.trustKnown);
    probe("flagged", -RANK_WEIGHTS.flaggedPenalty);
  }
  // ethics: matching the buyer's ethics flags vs not.
  {
    const query: SearchQuery = { ...QUERY, ethicsFlags: ["fair-trade"] };
    const match = makeOffer({ id: "eth-a", priceAmount: 1000, attributes: { sourcing: "fair-trade" } });
    const plain = makeOffer({ id: "eth-b", priceAmount: 1000 });
    probes.push({
      dimension: "ethics",
      probe: "matches the buyer's ethics preference vs not",
      expectedScoreDelta: RANK_WEIGHTS.ethicsMatchFull,
      measuredScoreDelta: scoreOf([match, plain], query, NO_TRUST, "eth-a") - scoreOf([match, plain], query, NO_TRUST, "eth-b"),
    });
  }
  // sponsored: the paid flag must measure ZERO score influence.
  {
    const paid = makeOffer({ id: "sp-a", priceAmount: 1000, sponsored: true });
    const organic = makeOffer({ id: "sp-b", priceAmount: 1000, sponsored: false });
    probes.push({
      dimension: "sponsored",
      probe: "identical offers, sponsored flag flipped (paid placement as the ONLY difference)",
      expectedScoreDelta: 0,
      measuredScoreDelta: scoreOf([paid, organic], QUERY, NO_TRUST, "sp-a") - scoreOf([paid, organic], QUERY, NO_TRUST, "sp-b"),
    });
  }
  return probes;
}

function formatDelta(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

export function runNeutralityAudit(): NeutralityAuditResult {
  const rnd = mulberry32(NEUTRALITY_AUDIT_SEED);
  const shuffle = positionShuffleBattery(rnd);
  const injection = sponsoredInjectionBattery(rnd);
  const choiceProfile = attributeProbes();
  const probesCheck: AuditCheck = {
    id: "attribute-probes",
    title: "attribute-weight probes (every measured score delta equals the published weight)",
    pass: choiceProfile.every((p) => p.measuredScoreDelta === p.expectedScoreDelta),
    detail: `${choiceProfile.length} single-dimension probes; ${
      choiceProfile.filter((p) => p.measuredScoreDelta !== p.expectedScoreDelta).length
    } measured deltas diverged from the published RANK_WEIGHTS`,
  };
  const checks = [shuffle, injection, probesCheck];
  const allPassed = checks.every((c) => c.pass);

  const report = [
    "# Neutrality self-audit — measured choice profile",
    "",
    "GENERATED FILE — do not edit. Emitted by `packages/protocol/scripts/neutrality-audit.ts`",
    `(deterministic: fixed seed ${NEUTRALITY_AUDIT_SEED}, no clock, no unseeded randomness — the same run is`,
    "byte-identical every time). Regenerate with `pnpm --filter @northcinder/protocol neutrality-audit`;",
    "the drift test `packages/protocol/test/neutrality-audit.test.ts` regenerates this report in CI",
    "and a neutrality regression or a stale committed copy is a test failure.",
    "",
    "ACES-style probe batteries (dimensions after arXiv:2508.02630) run against the OPEN,",
    "published ranking `rankOffers` (`packages/protocol/src/ranking/rank.ts`) — the same code",
    "the client re-runs to verify the deployed service. The claim under audit is",
    '"deterministic and auditable" ranking: rank order derives only from the buyer\'s criteria,',
    "and paid placement can never help.",
    "",
    "## Battery verdicts",
    "",
    "| Battery | Verdict | Measurement |",
    "| --- | --- | --- |",
    ...checks.map((c) => `| ${c.title} | ${c.pass ? "PASS" : "FAILED"} | ${c.detail} |`),
    "",
    "## Measured choice profile (attribute-weight probes)",
    "",
    "Each probe perturbs exactly one dimension between otherwise-identical synthetic offers",
    "and measures the score response. Measured deltas must equal the published `RANK_WEIGHTS`",
    "(see docs/RANKING.md) — including the sponsored row, which must measure exactly 0:",
    "paid placement is tier-and-label only, never a score input.",
    "",
    "| Dimension | Probe | Expected Δscore | Measured Δscore |",
    "| --- | --- | --- | --- |",
    ...choiceProfile.map(
      (p) => `| ${p.dimension} | ${p.probe} | ${formatDelta(p.expectedScoreDelta)} | ${formatDelta(p.measuredScoreDelta)} |`,
    ),
    "",
  ].join("\n");

  return { seed: NEUTRALITY_AUDIT_SEED, checks, choiceProfile, allPassed, report };
}
