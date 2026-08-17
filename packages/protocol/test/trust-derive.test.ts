import { describe, expect, it } from "vitest";
import {
  deriveTrustLevel,
  TRUST_THRESHOLDS,
  type TrustDerivationInputs,
} from "../src/trust/derive.js";

/** Deterministic mulberry32 PRNG — property batteries must be reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random inputs with NO deny-grade hit — the automated-signals universe. */
function randomAutomatedInputs(rnd: () => number): TrustDerivationInputs {
  return {
    allowHit: rnd() < 0.3,
    denyHit: false,
    curatedFraudHit: false,
    platformHit: rnd() < 0.3,
    ...(rnd() < 0.7 ? { domainAgeDays: Math.floor(rnd() * 12_000) } : {}),
    ...(rnd() < 0.7 ? { popularityRank: 1 + Math.floor(rnd() * 5_000_000) } : {}),
  };
}

describe("deriveTrustLevel — rule table (spec §5.1)", () => {
  it("deny-seed hit → flagged, with a machine reason naming the rule", () => {
    const d = deriveTrustLevel({ denyHit: true, allowHit: true, platformHit: true });
    expect(d.level).toBe("flagged");
    expect(d.reasons.map((r) => r.code)).toContain("deny_listed");
  });

  it("curated-fraud-list hit → flagged", () => {
    const d = deriveTrustLevel({ curatedFraudHit: true });
    expect(d.level).toBe("flagged");
    expect(d.reasons.map((r) => r.code)).toContain("curated_fraud_listed");
  });

  it("allow-seed hit → trusted", () => {
    const d = deriveTrustLevel({ allowHit: true });
    expect(d.level).toBe("trusted");
    expect(d.reasons.map((r) => r.code)).toContain("allow_listed");
  });

  it("platform heuristic alone → known", () => {
    const d = deriveTrustLevel({ platformHit: true });
    expect(d.level).toBe("known");
    expect(d.reasons.map((r) => r.code)).toContain("platform_hosted");
  });

  it("domain age ≥ threshold AND popularity ≤ threshold → known", () => {
    const d = deriveTrustLevel({
      domainAgeDays: TRUST_THRESHOLDS.knownMinDomainAgeDays,
      popularityRank: TRUST_THRESHOLDS.knownMaxPopularityRank,
    });
    expect(d.level).toBe("known");
    expect(d.reasons.map((r) => r.code)).toContain("established_domain");
  });

  it("old domain but unranked → unknown (age alone does not clear the bar)", () => {
    const d = deriveTrustLevel({ domainAgeDays: 10_000 });
    expect(d.level).toBe("unknown");
  });

  it("popular but young domain → unknown", () => {
    const d = deriveTrustLevel({
      domainAgeDays: TRUST_THRESHOLDS.knownMinDomainAgeDays - 1,
      popularityRank: 1,
    });
    expect(d.level).toBe("unknown");
  });

  it("no signals at all → unknown, and reasons still say WHY it is unknown", () => {
    const d = deriveTrustLevel({});
    expect(d.level).toBe("unknown");
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(d.reasons.map((r) => r.code)).toContain("no_positive_history");
  });
});

describe("deriveTrustLevel — §4 invariant properties", () => {
  it("(a) NO combination of automated signals yields flagged without a deny/curated hit", () => {
    const rnd = mulberry32(42);
    for (let i = 0; i < 2_000; i++) {
      const d = deriveTrustLevel(randomAutomatedInputs(rnd));
      expect(d.level).not.toBe("flagged");
    }
  });

  it("(b) absence of history is never negative evidence: a young/unranked domain alone never lowers below unknown", () => {
    const floors: TrustDerivationInputs[] = [
      { domainAgeDays: 0 },
      { domainAgeDays: 1 },
      { popularityRank: 5_000_000 },
      { domainAgeDays: 3, popularityRank: 9_999_999 },
      {},
    ];
    for (const inputs of floors) {
      const level = deriveTrustLevel(inputs).level;
      expect(level === "unknown").toBe(true);
    }
  });

  it("(c) pure and deterministic: same inputs → byte-identical output, input not mutated", () => {
    const rnd = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const inputs = randomAutomatedInputs(rnd);
      const frozen = JSON.stringify(inputs);
      const a = JSON.stringify(deriveTrustLevel(inputs));
      const b = JSON.stringify(deriveTrustLevel(JSON.parse(frozen)));
      expect(a).toBe(b);
      expect(JSON.stringify(inputs)).toBe(frozen);
    }
  });

  it("adding a measured signal can never LOWER the level (monotone: more positive evidence only helps)", () => {
    const order = { flagged: 0, unknown: 1, known: 2, trusted: 3 } as const;
    const base = deriveTrustLevel({ platformHit: true }).level;
    const withAge = deriveTrustLevel({ platformHit: true, domainAgeDays: 1 }).level;
    expect(order[withAge]).toBeGreaterThanOrEqual(order[base]);
  });

  it("(d) garbage measurements (NaN/Infinity/negative) never grant 'known' — they degrade to unavailable", () => {
    // A probe bug producing a non-finite or negative measurement must not
    // silently clear the "established" bar (adversarial finding, fixed).
    for (const bad of [Infinity, -Infinity, NaN, -5, -0.001]) {
      expect(deriveTrustLevel({ domainAgeDays: bad, popularityRank: 100 }).level).toBe("unknown");
      expect(deriveTrustLevel({ domainAgeDays: 5000, popularityRank: bad }).level).toBe("unknown");
    }
    // A rank of 0 is nonsensical (ranks start at 1) — also rejected.
    expect(deriveTrustLevel({ domainAgeDays: 5000, popularityRank: 0 }).level).toBe("unknown");
    // Sanity: valid finite measurements still reach "known".
    expect(deriveTrustLevel({ domainAgeDays: 5000, popularityRank: 100 }).level).toBe("known");
  });
});
