/**
 * ACES-style neutrality self-audit (ranking verification): runs the deterministic probe
 * batteries in src/ranking/neutrality-audit.ts over the published ranking and
 * emits docs/NEUTRALITY-AUDIT.md with the measured choice profile.
 *
 * Deterministic by construction (fixed seed, no clock): the same run is
 * byte-identical. Run: pnpm --filter @northcinder/protocol neutrality-audit
 * Exit code 1 if any battery fails — usable directly as a CI gate.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runNeutralityAudit } from "../src/ranking/neutrality-audit.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOC_PATH = join(REPO_ROOT, "docs", "NEUTRALITY-AUDIT.md");

const audit = runNeutralityAudit();
writeFileSync(DOC_PATH, audit.report);
for (const check of audit.checks) {
  console.log(`[neutrality-audit] ${check.pass ? "PASS" : "FAILED"} ${check.id}: ${check.detail}`);
}
console.log(`[neutrality-audit] report written to ${DOC_PATH}`);
if (!audit.allPassed) process.exit(1);
