import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RANK_WEIGHTS } from "../src/ranking/rank.js";
import {
  RANKING_DOC_BEGIN_MARKER,
  RANKING_DOC_END_MARKER,
  renderRankingDoc,
} from "../src/ranking/doc.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RANKING_DOC_PATH = join(REPO_ROOT, "docs", "RANKING.md");

describe("docs/RANKING.md — generated spec stays in lockstep with rank.ts (doc drift = failure)", () => {
  it("the committed doc contains exactly the block renderRankingDoc() generates from RANK_WEIGHTS", () => {
    const doc = readFileSync(RANKING_DOC_PATH, "utf8");
    const begin = doc.indexOf(RANKING_DOC_BEGIN_MARKER);
    const end = doc.indexOf(RANKING_DOC_END_MARKER);
    expect(begin, `missing ${RANKING_DOC_BEGIN_MARKER} in docs/RANKING.md`).toBeGreaterThanOrEqual(0);
    expect(end, `missing ${RANKING_DOC_END_MARKER} in docs/RANKING.md`).toBeGreaterThan(begin);

    const committed = doc.slice(begin, end + RANKING_DOC_END_MARKER.length);
    // If this fails, a ranking weight or rule changed without regenerating the
    // doc: run `pnpm --filter @northcinder/protocol gen:ranking-doc` and commit.
    expect(committed).toBe(renderRankingDoc());
  });

  it("every RANK_WEIGHTS key and value appears in the generated block", () => {
    const block = renderRankingDoc();
    for (const [key, value] of Object.entries(RANK_WEIGHTS)) {
      expect(block).toContain(key);
      expect(block).toContain(String(value));
    }
  });

  it("the generated block documents the sponsored strict-lower-tier rule and the tie-breaks", () => {
    const block = renderRankingDoc();
    expect(block).toContain("strictly lower tier");
    expect(block).toContain("sponsored");
    expect(block).toContain("score (desc), then price (asc), then offer id (asc)");
  });
});
