/**
 * Regenerates the machine-verified block of docs/RANKING.md from rank.ts.
 * Run: pnpm --filter @northcinder/protocol gen:ranking-doc
 * The drift test (test/ranking-doc.test.ts) fails CI if this wasn't rerun
 * after a ranking change.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RANKING_DOC_BEGIN_MARKER, RANKING_DOC_END_MARKER, renderRankingDoc } from "../src/ranking/doc.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOC_PATH = join(REPO_ROOT, "docs", "RANKING.md");

const doc = readFileSync(DOC_PATH, "utf8");
const begin = doc.indexOf(RANKING_DOC_BEGIN_MARKER);
const end = doc.indexOf(RANKING_DOC_END_MARKER);
if (begin < 0 || end < begin) {
  console.error(`[gen:ranking-doc] markers not found in ${DOC_PATH}`);
  process.exit(1);
}
const updated = doc.slice(0, begin) + renderRankingDoc() + doc.slice(end + RANKING_DOC_END_MARKER.length);
writeFileSync(DOC_PATH, updated);
console.log(`[gen:ranking-doc] regenerated the generated block in ${DOC_PATH}`);
