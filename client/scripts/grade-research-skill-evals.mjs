#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ResearchChecklistReceiptSchema, SourcedClaimSchema } from "@northcinder/protocol";

const REQUIRED_RUN_NAMES = [
  "with-skill-01.json",
  "with-skill-02.json",
  "with-skill-03.json",
  "with-skill-04.json",
  "with-skill-05.json",
];

const REQUIRED_OUTPUT_FIELDS = [
  "scenarioId",
  "subjectIdentity",
  "selectedSourceIds",
  "claims",
  "unknowns",
  "conflicts",
  "counterevidenceSourceIds",
  "receipt",
];

const CRITICAL_FAILURES = new Set([
  "wrong_identity_binding",
  "seller_affiliate_laundering",
  "confident_stop_condition_violation",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function unique(values) {
  return [...new Set(values)];
}

function containsAll(actual, required) {
  const values = new Set(actual);
  return required.every((value) => values.has(value));
}

function conflictContains(conflicts, requiredSourceIds) {
  return conflicts.some(
    (conflict) =>
      isRecord(conflict) &&
      isStringArray(conflict.sourceIds) &&
      containsAll(conflict.sourceIds, requiredSourceIds),
  );
}

function validateScenario(scenario, path) {
  if (!isRecord(scenario) || !isNonEmptyString(scenario.scenarioId)) {
    throw new Error(`Invalid scenario at ${path}: scenarioId is required`);
  }
  if (!isRecord(scenario.agentInput) || scenario.agentInput.scenarioId !== scenario.scenarioId) {
    throw new Error(`Invalid scenario ${scenario.scenarioId}: separable agentInput is required`);
  }
  if (!isRecord(scenario.rubric) || !isNonEmptyString(scenario.rubric.expectedSubjectIdentity)) {
    throw new Error(`Invalid scenario ${scenario.scenarioId}: private rubric is required`);
  }
  if (!isRecord(scenario.rubric.sources)) {
    throw new Error(`Invalid scenario ${scenario.scenarioId}: rubric.sources is required`);
  }
  if (!isStringArray(scenario.rubric.requiredChecklistItemIds)) {
    throw new Error(`Invalid scenario ${scenario.scenarioId}: checklist rubric is required`);
  }
  if (typeof scenario.rubric.mustBeProvisional !== "boolean") {
    throw new Error(`Invalid scenario ${scenario.scenarioId}: mustBeProvisional is required`);
  }
}

export function gradeOutput(scenario, output) {
  const failures = [];
  const rubric = scenario.rubric;
  const sourceExists = (sourceId) => Object.hasOwn(rubric.sources, sourceId);

  if (!isRecord(output)) {
    return { passed: false, failureCategories: ["malformed_output"] };
  }
  const selectedSources = new Set(isStringArray(output.selectedSourceIds) ? output.selectedSourceIds : []);
  const receipt = ResearchChecklistReceiptSchema.safeParse(output.receipt);

  const topLevelValid =
    REQUIRED_OUTPUT_FIELDS.every((field) => Object.hasOwn(output, field)) &&
    isNonEmptyString(output.scenarioId) &&
    isNonEmptyString(output.subjectIdentity) &&
    isStringArray(output.selectedSourceIds) && output.selectedSourceIds.every(sourceExists) &&
    Array.isArray(output.claims) &&
    isStringArray(output.unknowns) &&
    Array.isArray(output.conflicts) && output.conflicts.every(
      (conflict) =>
        isRecord(conflict) &&
        isNonEmptyString(conflict.description) &&
        isStringArray(conflict.sourceIds) &&
        conflict.sourceIds.length > 0 &&
        conflict.sourceIds.every(sourceExists),
    ) &&
    isStringArray(output.counterevidenceSourceIds) && output.counterevidenceSourceIds.every(sourceExists) &&
    receipt.success;

  if (!topLevelValid) failures.push("malformed_output");

  if (
    (isNonEmptyString(output.scenarioId) && output.scenarioId !== scenario.scenarioId) ||
    (isNonEmptyString(output.subjectIdentity) && output.subjectIdentity !== rubric.expectedSubjectIdentity)
  ) {
    failures.push("wrong_identity_binding");
  }

  let claimsMalformed = !Array.isArray(output.claims) || output.claims.length === 0;
  if (Array.isArray(output.claims)) {
    for (const claim of output.claims) {
      const runtimeClaim = SourcedClaimSchema.safeParse(claim);
      if (
        !runtimeClaim.success ||
        !runtimeClaim.data.sourceIds.every(
          (sourceId) => selectedSources.has(sourceId) && Object.hasOwn(rubric.sources, sourceId),
        )
      ) {
        claimsMalformed = true;
        continue;
      }
      const validClaim = runtimeClaim.data;

      if (validClaim.subjectIdentity !== rubric.expectedSubjectIdentity) {
        failures.push("wrong_identity_binding");
      }

      if (
        validClaim.sourceUse === "subject_evidence" &&
        validClaim.sourceIds.some((sourceId) => rubric.forbiddenSubjectEvidenceSourceIds.includes(sourceId))
      ) {
        failures.push("wrong_identity_binding");
      }

      if (
        validClaim.sourceRelationship === "independent" &&
        validClaim.sourceIds.some((sourceId) => rubric.forbiddenIndependentSourceIds.includes(sourceId))
      ) {
        failures.push("seller_affiliate_laundering");
      }

      if (
        validClaim.sourceIds.some(
          (sourceId) => rubric.sources[sourceId].relationship !== validClaim.sourceRelationship,
        )
      ) {
        claimsMalformed = true;
      }
    }
  }
  if (claimsMalformed) failures.push("malformed_claims");

  if (
    !isStringArray(output.counterevidenceSourceIds) ||
    !containsAll(output.counterevidenceSourceIds, rubric.requiredCounterevidenceSourceIds)
  ) {
    failures.push("absent_counterevidence");
  }

  if (
    isStringArray(output.selectedSourceIds) &&
    !containsAll(output.selectedSourceIds, rubric.requiredSelectedSourceIds)
  ) {
    failures.push("missing_required_sources");
  }

  if (
    !Array.isArray(output.conflicts) ||
    rubric.requiredConflictSourceGroups.some((group) => !conflictContains(output.conflicts, group))
  ) {
    failures.push("missing_required_conflicts");
  }

  if (!isStringArray(output.unknowns) || output.unknowns.length < rubric.minimumUnknowns) {
    failures.push("missing_required_unknowns");
  }

  if (
    !receipt.success ||
    !containsAll(receipt.data.checklistItemIds, rubric.requiredChecklistItemIds)
  ) {
    failures.push("missing_checklist_items");
  }

  if (rubric.mustBeProvisional && receipt.success && receipt.data.provisional === false) {
    failures.push("confident_stop_condition_violation");
  }

  const failureCategories = unique(failures);
  return { passed: failureCategories.length === 0, failureCategories };
}

function readJsonArtifact(path) {
  const raw = readFileSync(path);
  try {
    return { raw, parsed: JSON.parse(raw.toString("utf8")), parseError: null };
  } catch (error) {
    return { raw, parsed: null, parseError: error instanceof Error ? error.message : String(error) };
  }
}

function gradeArtifact(scenario, path, rootDir) {
  const { raw, parsed, parseError } = readJsonArtifact(path);
  const grade = parseError
    ? { passed: false, failureCategories: ["malformed_output"] }
    : gradeOutput(scenario, parsed);
  return {
    path: relative(rootDir, path),
    sha256: sha256(raw),
    byteLength: raw.length,
    parseError,
    ...grade,
  };
}

function countFailures(runs) {
  const counts = {};
  for (const run of runs) {
    for (const category of run.failureCategories) {
      counts[category] = (counts[category] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function assertExactlyFiveRuns(scenarioId, runDir) {
  let names;
  try {
    names = readdirSync(runDir).filter((name) => name.startsWith("with-skill-") && name.endsWith(".json")).sort();
  } catch (error) {
    throw new Error(`Scenario ${scenarioId} must have exactly five with-skill runs; run directory is unreadable`);
  }
  if (JSON.stringify(names) !== JSON.stringify(REQUIRED_RUN_NAMES)) {
    throw new Error(
      `Scenario ${scenarioId} must have exactly five with-skill runs named ${REQUIRED_RUN_NAMES.join(", ")}; found ${names.join(", ") || "none"}`,
    );
  }
}

function loadSkillHashes(skillsDir) {
  const productPath = join(skillsDir, "product-research", "SKILL.md");
  const sellerPath = join(skillsDir, "seller-research", "SKILL.md");
  return {
    productResearch: {
      path: relative(skillsDir, productPath),
      sha256: sha256(readFileSync(productPath)),
    },
    sellerResearch: {
      path: relative(skillsDir, sellerPath),
      sha256: sha256(readFileSync(sellerPath)),
    },
  };
}

export function gradeEvaluation({ runsDir, scenariosDir, skillsDir, host, model, modelVersion }) {
  for (const [name, value] of Object.entries({ runsDir, scenariosDir, skillsDir, host, model, modelVersion })) {
    if (!isNonEmptyString(value)) throw new Error(`${name} is required`);
  }

  const scenarioNames = readdirSync(scenariosDir).filter((name) => name.endsWith(".json")).sort();
  if (scenarioNames.length === 0) throw new Error("No evaluation scenarios found");

  const scenarioRecords = [];
  for (const scenarioName of scenarioNames) {
    const scenarioPath = join(scenariosDir, scenarioName);
    const scenarioRaw = readFileSync(scenarioPath);
    const scenario = JSON.parse(scenarioRaw.toString("utf8"));
    validateScenario(scenario, scenarioPath);

    const runDir = join(runsDir, scenario.scenarioId);
    assertExactlyFiveRuns(scenario.scenarioId, runDir);
    const baselinePath = join(runDir, "baseline.json");
    if (!statSync(baselinePath).isFile()) {
      throw new Error(`Scenario ${scenario.scenarioId} must have one baseline.json artifact`);
    }

    const baseline = gradeArtifact(scenario, baselinePath, runsDir);
    const withSkillRuns = REQUIRED_RUN_NAMES.map((name) => gradeArtifact(scenario, join(runDir, name), runsDir));
    const failureCategories = countFailures(withSkillRuns);
    const criticalFailureCount = [...CRITICAL_FAILURES].reduce(
      (total, category) => total + (failureCategories[category] ?? 0),
      0,
    );
    const otherPassCount = withSkillRuns.filter((run) =>
      run.failureCategories.every((category) => CRITICAL_FAILURES.has(category)),
    ).length;
    const passCount = withSkillRuns.filter((run) => run.passed).length;
    const qualified = criticalFailureCount === 0 && otherPassCount >= 4;

    scenarioRecords.push({
      scenarioId: scenario.scenarioId,
      skill: scenario.skill,
      scenarioPath: relative(scenariosDir, scenarioPath),
      scenarioSha256: sha256(scenarioRaw),
      inputSha256: sha256(Buffer.from(JSON.stringify(scenario.agentInput), "utf8")),
      skillSha256:
        scenario.skill === "product-research"
          ? loadSkillHashes(skillsDir).productResearch.sha256
          : loadSkillHashes(skillsDir).sellerResearch.sha256,
      baseline,
      withSkillRuns,
      passCount,
      passRate: passCount / REQUIRED_RUN_NAMES.length,
      otherPassCount,
      failureCategories,
      criticalFailureCount,
      qualified,
    });
  }

  const skills = loadSkillHashes(skillsDir);
  return {
    schemaVersion: 1,
    evaluation: {
      host,
      model,
      modelVersion,
      withSkillRunsRequiredPerScenario: 5,
    },
    thresholds: {
      wrongIdentityBindings: 0,
      sellerAffiliateLaundering: 0,
      confidentStopConditionViolations: 0,
      minimumOtherPassingRunsPerScenario: 4,
    },
    skills,
    scenarios: scenarioRecords,
    qualifiesRoutineSupport: scenarioRecords.every((record) => record.qualified),
  };
}

function parseArgs(argv) {
  const allowed = new Set([
    "--runs-dir",
    "--scenarios-dir",
    "--skills-dir",
    "--host",
    "--model",
    "--model-version",
    "--out",
  ]);
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid grader arguments near ${flag ?? "end of command"}`);
    }
    args[flag.slice(2).replaceAll("-", "_")] = value;
  }
  for (const flag of allowed) {
    const key = flag.slice(2).replaceAll("-", "_");
    if (!isNonEmptyString(args[key])) throw new Error(`${flag} is required`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = gradeEvaluation({
    runsDir: resolve(args.runs_dir),
    scenariosDir: resolve(args.scenarios_dir),
    skillsDir: resolve(args.skills_dir),
    host: args.host,
    model: args.model,
    modelVersion: args.model_version,
  });
  const out = resolve(args.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "w" });
  process.stdout.write(`${out}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
