import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RANK_WEIGHTS } from "../src/ranking/rank.js";
import { NEUTRALITY_AUDIT_SEED, runNeutralityAudit } from "../src/ranking/neutrality-audit.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AUDIT_DOC_PATH = join(REPO_ROOT, "docs", "NEUTRALITY-AUDIT.md");

describe("neutrality self-audit — ACES-style probe batteries over the published ranking", () => {
  it("is deterministic: two runs produce byte-identical reports", () => {
    const a = runNeutralityAudit();
    const b = runNeutralityAudit();
    expect(a.report).toBe(b.report);
    expect(a).toEqual(b);
  });

  it("all audit checks pass (a regression in ranking neutrality fails CI here)", () => {
    const audit = runNeutralityAudit();
    const failed = audit.checks.filter((c) => !c.pass);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(audit.allPassed).toBe(true);
    // The batteries actually exercised something.
    expect(audit.checks.length).toBeGreaterThanOrEqual(3);
  });

  it("the report contains PASS verdicts for the three probe batteries and no timestamps", () => {
    const { report } = runNeutralityAudit();
    expect(report).toContain("position-shuffle");
    expect(report).toContain("sponsored-flag injection");
    expect(report).toContain("attribute-weight probes");
    expect(report).toContain(`seed ${NEUTRALITY_AUDIT_SEED}`);
    expect(report).not.toContain("FAIL");
    // Deterministic artifact: no wall-clock content of any form.
    expect(report).not.toMatch(/20\d\d-\d\d-\d\dT/);
  });

  it("the choice profile measures every scoring dimension against RANK_WEIGHTS", () => {
    const { choiceProfile, report } = runNeutralityAudit();
    const dims = choiceProfile.map((p) => p.dimension);
    for (const dim of ["price", "spec_match", "delivery", "availability", "trust", "ethics", "sponsored"]) {
      expect(dims).toContain(dim);
    }
    for (const probe of choiceProfile) {
      expect(probe.measuredScoreDelta, `dimension ${probe.dimension}/${probe.probe}`).toBe(probe.expectedScoreDelta);
    }
    // The sponsored flag must measure ZERO score influence — de-prioritization
    // is tier-only, never a score input.
    const sponsored = choiceProfile.find((p) => p.dimension === "sponsored")!;
    expect(sponsored.measuredScoreDelta).toBe(0);
    // The flagged-merchant penalty shows up as documented.
    expect(report).toContain(String(RANK_WEIGHTS.flaggedPenalty));
  });

  it("the committed docs/NEUTRALITY-AUDIT.md is exactly the regenerated report (drift = failure)", () => {
    const committed = readFileSync(AUDIT_DOC_PATH, "utf8");
    // If this fails, ranking behavior changed without regenerating the audit:
    // run `pnpm --filter @northcinder/protocol neutrality-audit` and commit.
    expect(committed).toBe(runNeutralityAudit().report);
  });
});
