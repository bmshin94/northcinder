import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gradeOutput } from "../scripts/grade-research-skill-evals.mjs";

const CLIENT_DIR = new URL("../", import.meta.url);
const SCENARIOS_DIR = new URL("evals/research-skills/scenarios/", CLIENT_DIR);
const GRADER_PATH = new URL("scripts/grade-research-skill-evals.mjs", CLIENT_DIR);
const SKILLS_DIR = new URL("research-skills/", CLIENT_DIR);

const EXPECTED_SCENARIOS = [
  "contradictory-specs",
  "evidence-poor",
  "fit-sensitive",
  "fuzzy-request",
  "multi-merchant",
  "suspicious-indie",
];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "northcinder-research-evals-"));
  tempDirs.push(dir);
  return dir;
}

function loadScenario(name = "fit-sensitive") {
  return JSON.parse(readFileSync(new URL(`${name}.json`, SCENARIOS_DIR), "utf8"));
}

function validFitOutput() {
  return {
    scenarioId: "fit-sensitive",
    subjectIdentity: "AlderWorks CarryFrame 38, women's XS/S torso, 2026 revision",
    selectedSourceIds: ["manual-2026-xs", "lab-2025-xs", "retailer-mixed", "owner-2026-xs"],
    claims: [
      {
        lane: "product",
        checklistIds: ["product.identity", "product.primary-facts", "product.fit-compatibility"],
        claim: "The exact 2026 XS/S manual states a 14-17 inch torso range and a 12 kg maximum recommended load.",
        subjectIdentity: "AlderWorks CarryFrame 38, women's XS/S torso, 2026 revision",
        sourceIds: ["manual-2026-xs"],
        sourceRelationship: "primary",
        sourceUse: "subject_evidence",
        sourceUrl: "https://manual.example.test/carryframe-38-2026-xs",
        sourceType: "official manual",
        observedAt: "2026-08-19T12:00:00Z",
        confidence: "high",
        conflicts: [],
        unknowns: [],
      },
      {
        lane: "product",
        checklistIds: ["product.independent-evidence", "product.counterevidence"],
        claim: "The 2025 XS/S test is context only and cannot establish comfort for the 2026 revision.",
        subjectIdentity: "AlderWorks CarryFrame 38, women's XS/S torso, 2026 revision",
        sourceIds: ["lab-2025-xs"],
        sourceRelationship: "independent",
        sourceUse: "context_only",
        sourceUrl: "https://lab.example.test/carryframe-38-2025-xs",
        sourceType: "independent harness test",
        observedAt: "2026-08-19T12:00:00Z",
        confidence: "medium",
        conflicts: [],
        unknowns: [],
      },
      {
        lane: "product",
        checklistIds: ["product.commercial-claims"],
        claim: "The mixed retailer listing advertises 15 kg without identifying the size or revision.",
        subjectIdentity: "AlderWorks CarryFrame 38, women's XS/S torso, 2026 revision",
        sourceIds: ["retailer-mixed"],
        sourceRelationship: "commercial",
        sourceUse: "commercial_claim",
        sourceUrl: "https://retailer.example.test/carryframe-38",
        sourceType: "retailer listing",
        observedAt: "2026-08-19T12:00:00Z",
        confidence: "unverified",
        conflicts: [],
        unknowns: [],
      },
      {
        lane: "product",
        checklistIds: ["product.failure-modes", "product.counterevidence"],
        claim: "Two exact-variant owner reports give mixed comfort outcomes below the buyer's 13 kg load.",
        subjectIdentity: "AlderWorks CarryFrame 38, women's XS/S torso, 2026 revision",
        sourceIds: ["owner-2026-xs"],
        sourceRelationship: "owner",
        sourceUse: "counterevidence",
        sourceUrl: "https://owners.example.test/carryframe-38-2026-xs",
        sourceType: "owner reports",
        observedAt: "2026-08-19T12:00:00Z",
        confidence: "low",
        conflicts: [],
        unknowns: ["No independent exact-revision comfort measurement was available."],
      },
    ],
    unknowns: [
      "No independent comfort test for the exact 2026 XS/S revision at 13 kg is available.",
    ],
    conflicts: [
      {
        description: "The unsized retailer maximum conflicts with the exact-size manual.",
        sourceIds: ["manual-2026-xs", "retailer-mixed"],
      },
    ],
    counterevidenceSourceIds: ["lab-2025-xs", "owner-2026-xs"],
    receipt: {
      checklistItemIds: [
        "product.identity",
        "product.intended-use",
        "product.primary-facts",
        "product.independent-evidence",
        "product.fit-compatibility",
        "product.failure-modes",
        "product.counterevidence",
        "product.commercial-claims",
        "product.unknowns",
        "product.stop-receipt",
      ],
      openChecklistItemIds: ["product.fit-compatibility", "product.unknowns"],
      provisional: true,
    },
  };
}

describe("research-skill evaluation scenarios", () => {
  it("exposes six non-leaking agent inputs and keeps grading rubrics private", () => {
    expect(readdirSync(SCENARIOS_DIR).sort()).toEqual(EXPECTED_SCENARIOS.map((id) => `${id}.json`));

    for (const id of EXPECTED_SCENARIOS) {
      const scenario = loadScenario(id);
      expect(scenario).toMatchObject({
        scenarioId: id,
        agentInput: {
          scenarioId: id,
          outputContract: {
            format: "json_only",
            requiredTopLevelFields: [
              "scenarioId",
              "subjectIdentity",
              "selectedSourceIds",
              "claims",
              "unknowns",
              "conflicts",
              "counterevidenceSourceIds",
              "receipt",
            ],
          },
        },
      });
      expect(scenario.agentInput).not.toHaveProperty("rubric");
      expect(scenario.rubric.requiredChecklistItemIds.length).toBeGreaterThan(0);
      expect(scenario.rubric).toHaveProperty("mustBeProvisional");
      expect(scenario.rubric.forbiddenIndependentSourceIds.length).toBeGreaterThan(0);
    }
  });
});

describe("deterministic output grading", () => {
  it("passes a schema-valid provisional result with exact identity, quarantined commercial evidence, and counterevidence", () => {
    expect(gradeOutput(loadScenario(), validFitOutput())).toEqual({
      passed: true,
      failureCategories: [],
    });
  });

  it("classifies a different-revision source bound as exact-variant evidence", () => {
    const output = validFitOutput();
    output.claims[1]!.sourceUse = "subject_evidence";
    expect(gradeOutput(loadScenario(), output).failureCategories).toContain("wrong_identity_binding");
  });

  it("classifies retailer evidence presented as independent", () => {
    const output = validFitOutput();
    output.claims[2]!.sourceRelationship = "independent";
    expect(gradeOutput(loadScenario(), output).failureCategories).toContain("seller_affiliate_laundering");
  });

  it("classifies absent required counterevidence", () => {
    const output = validFitOutput();
    output.counterevidenceSourceIds = [];
    expect(gradeOutput(loadScenario(), output).failureCategories).toContain("absent_counterevidence");
  });

  it("classifies a confident answer when a stop condition applies", () => {
    const output = validFitOutput();
    output.receipt.openChecklistItemIds = [];
    output.receipt.provisional = false;
    expect(gradeOutput(loadScenario(), output).failureCategories).toContain(
      "confident_stop_condition_violation",
    );
  });

  it("classifies malformed claims instead of accepting prose-shaped records", () => {
    const output = validFitOutput();
    delete (output.claims[0] as Partial<(typeof output.claims)[number]>).sourceUse;
    expect(gradeOutput(loadScenario(), output).failureCategories).toContain("malformed_claims");
  });

  it("uses the runtime claim schema instead of a looser evaluator-only claim shape", () => {
    const output = validFitOutput();
    delete (output.claims[0] as Partial<(typeof output.claims)[number]>).lane;
    expect(gradeOutput(loadScenario(), output).failureCategories).toContain("malformed_claims");
  });

  it("classifies a claim with no cited source IDs as malformed", () => {
    const output = validFitOutput();
    output.claims[0]!.sourceIds = [];
    expect(gradeOutput(loadScenario(), output).failureCategories).toContain("malformed_claims");
  });

  it("classifies a claim that cites a supplied but unselected source as malformed", () => {
    const output = validFitOutput();
    output.claims.push({
      ...output.claims[0]!,
      claim: "The different M/L sizing line is context only and cannot establish fit for the XS/S subject.",
      sourceIds: ["maker-2026-ml"],
      sourceRelationship: "primary",
      sourceUse: "context_only",
      sourceUrl: "https://maker.example.test/carryframe-38-2026-ml",
    });
    expect(gradeOutput(loadScenario(), output).failureCategories).toContain("malformed_claims");
  });

  it("classifies malformed conflict records and invented source IDs as malformed output", () => {
    const output = validFitOutput();
    output.selectedSourceIds.push("invented-source");
    output.conflicts = [{ description: "Missing source IDs", sourceIds: [] }];
    expect(gradeOutput(loadScenario(), output).failureCategories).toContain("malformed_output");
  });

  it("classifies missing canonical checklist items", () => {
    const output = validFitOutput();
    output.receipt.checklistItemIds = output.receipt.checklistItemIds.filter(
      (id) => id !== "product.stop-receipt",
    );
    expect(gradeOutput(loadScenario(), output).failureCategories).toContain("missing_checklist_items");
  });
});

describe("grader run contract", () => {
  function evaluationFixture(runCount = 5) {
    const root = tempDir();
    const scenariosDir = join(root, "scenarios");
    const runsDir = join(root, "runs");
    const skillsDir = join(root, "skills");
    const scenarioRuns = join(runsDir, "fit-sensitive");
    mkdirSync(scenariosDir, { recursive: true });
    mkdirSync(scenarioRuns, { recursive: true });
    cpSync(new URL("fit-sensitive.json", SCENARIOS_DIR), join(scenariosDir, "fit-sensitive.json"));
    cpSync(SKILLS_DIR, skillsDir, { recursive: true });
    writeFileSync(join(scenarioRuns, "baseline.json"), `${JSON.stringify(validFitOutput(), null, 2)}\n`);
    for (let run = 1; run <= runCount; run += 1) {
      writeFileSync(
        join(scenarioRuns, `with-skill-${String(run).padStart(2, "0")}.json`),
        `${JSON.stringify(validFitOutput(), null, 2)}\n`,
      );
    }
    return { root, scenariosDir, runsDir, skillsDir, scenarioRuns };
  }

  it("requires and records exactly five with-skill artifacts without modifying raw evidence", () => {
    const fixture = evaluationFixture();
    const out = join(fixture.root, "manifest.json");
    const rawPath = join(fixture.scenarioRuns, "with-skill-01.json");
    const rawBefore = readFileSync(rawPath);

    execFileSync(
      process.execPath,
      [
        GRADER_PATH.pathname,
        "--runs-dir",
        fixture.runsDir,
        "--scenarios-dir",
        fixture.scenariosDir,
        "--skills-dir",
        fixture.skillsDir,
        "--host",
        "isolated-test-host",
        "--model",
        "weak-test-model",
        "--model-version",
        "2026-08-19-test",
        "--out",
        out,
      ],
      { stdio: "pipe" },
    );

    expect(readFileSync(rawPath)).toEqual(rawBefore);
    const manifest = JSON.parse(readFileSync(out, "utf8"));
    expect(manifest.evaluation).toEqual({
      host: "isolated-test-host",
      model: "weak-test-model",
      modelVersion: "2026-08-19-test",
      withSkillRunsRequiredPerScenario: 5,
    });
    expect(manifest.skills.productResearch.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.skills.sellerResearch.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.scenarios[0].scenarioSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.scenarios[0].inputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.scenarios[0].withSkillRuns).toHaveLength(5);
    expect(manifest.scenarios[0].passRate).toBe(1);
    expect(manifest.scenarios[0].qualified).toBe(true);
    expect(manifest.qualifiesRoutineSupport).toBe(true);
  });

  it.each([4, 6])("rejects %i with-skill artifacts instead of weakening or expanding the sample", (runCount) => {
    const fixture = evaluationFixture(runCount);
    expect(() =>
      execFileSync(
        process.execPath,
        [
          GRADER_PATH.pathname,
          "--runs-dir",
          fixture.runsDir,
          "--scenarios-dir",
          fixture.scenariosDir,
          "--skills-dir",
          fixture.skillsDir,
          "--host",
          "isolated-test-host",
          "--model",
          "weak-test-model",
          "--model-version",
          "2026-08-19-test",
          "--out",
          join(fixture.root, "manifest.json"),
        ],
        { stdio: "pipe" },
      ),
    ).toThrow(/exactly five with-skill runs/i);
  });

  it("allows one non-critical malformed run but not two, while all critical categories remain zero-tolerance", () => {
    const oneMalformed = evaluationFixture();
    writeFileSync(join(oneMalformed.scenarioRuns, "with-skill-05.json"), "{}\n");
    const oneOut = join(oneMalformed.root, "manifest.json");
    execFileSync(
      process.execPath,
      [
        GRADER_PATH.pathname,
        "--runs-dir",
        oneMalformed.runsDir,
        "--scenarios-dir",
        oneMalformed.scenariosDir,
        "--skills-dir",
        oneMalformed.skillsDir,
        "--host",
        "host",
        "--model",
        "model",
        "--model-version",
        "version",
        "--out",
        oneOut,
      ],
    );
    expect(JSON.parse(readFileSync(oneOut, "utf8")).qualifiesRoutineSupport).toBe(true);

    const twoMalformed = evaluationFixture();
    writeFileSync(join(twoMalformed.scenarioRuns, "with-skill-04.json"), "{}\n");
    writeFileSync(join(twoMalformed.scenarioRuns, "with-skill-05.json"), "{}\n");
    const twoOut = join(twoMalformed.root, "manifest.json");
    execFileSync(
      process.execPath,
      [
        GRADER_PATH.pathname,
        "--runs-dir",
        twoMalformed.runsDir,
        "--scenarios-dir",
        twoMalformed.scenariosDir,
        "--skills-dir",
        twoMalformed.skillsDir,
        "--host",
        "host",
        "--model",
        "model",
        "--model-version",
        "version",
        "--out",
        twoOut,
      ],
    );
    expect(JSON.parse(readFileSync(twoOut, "utf8")).qualifiesRoutineSupport).toBe(false);

    const wrongIdentity = evaluationFixture();
    const output = validFitOutput();
    output.subjectIdentity = "AlderWorks CarryFrame 38, women's M/L torso, 2026 revision";
    writeFileSync(
      join(wrongIdentity.scenarioRuns, "with-skill-05.json"),
      `${JSON.stringify(output, null, 2)}\n`,
    );
    const identityOut = join(wrongIdentity.root, "manifest.json");
    execFileSync(
      process.execPath,
      [
        GRADER_PATH.pathname,
        "--runs-dir",
        wrongIdentity.runsDir,
        "--scenarios-dir",
        wrongIdentity.scenariosDir,
        "--skills-dir",
        wrongIdentity.skillsDir,
        "--host",
        "host",
        "--model",
        "model",
        "--model-version",
        "version",
        "--out",
        identityOut,
      ],
    );
    expect(JSON.parse(readFileSync(identityOut, "utf8")).qualifiesRoutineSupport).toBe(false);
  });
});
