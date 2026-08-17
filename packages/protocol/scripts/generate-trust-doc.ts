/**
 * Regenerates the machine-verified block of docs/TRUST.md from trust/derive.ts.
 * Run: corepack pnpm --filter @northcinder/protocol gen:trust-doc
 * The drift test (test/trust-doc.test.ts) fails CI if this wasn't rerun
 * after a trust-derivation change.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTrustDoc } from "../src/trust/doc.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOC_PATH = join(REPO_ROOT, "docs", "TRUST.md");

const preamble = `# NorthCinder trust: the deterministic, auditable specification

This document explains how NorthCinder derives a merchant's trust level. Like the
[ranking specification](./RANKING.md), it is **deterministic and auditable**, never a claim that a
merchant is “provably safe”:

- The derivation is open in
  [\`packages/protocol/src/trust/derive.ts\`](../packages/protocol/src/trust/derive.ts) and ships in
  \`@northcinder/protocol\`. The buyer-run aggregation engine uses the same code and is included in this
  MIT-licensed repository. No NorthCinder-operated trust or aggregation endpoint exists.
- Every evidence line names the source and measured fact. Probe-measured lines can carry a
  \`fetchedAt\` timestamp and a \`url\` recheck pointer.
- The generated section below comes from the trust derivation source. Regenerate it with
  \`corepack pnpm --filter @northcinder/protocol gen:trust-doc\`; the protocol drift test compares the
  generated block byte for byte.

## What the levels mean

- \`trusted\`: vetted through the local deployer's allow seed.
- \`known\`: clears the documented established-store threshold through an established platform or
  measured domain age plus sustained popularity. It is not an endorsement.
- \`unknown\`: no positive history. This is the no-history floor, not a negative judgment.
- \`flagged\`: deny-grade evidence only, from the local deployer's deny seed or a curated fraud source.
  Automated age, rank, platform, or missing-data heuristics cannot produce it.

Trust verification is bounded by the inputs and evidence disclosed. The buyer or independent
deployer controls the configured feeds and is responsible for their provenance and retention; the
repository owner does not collect or operate them.

`;

writeFileSync(DOC_PATH, `${preamble}${renderTrustDoc()}\n`);
console.log(`[gen:trust-doc] regenerated the generated block in ${DOC_PATH}`);
