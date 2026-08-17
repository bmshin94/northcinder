import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TRUST_THRESHOLDS, TRUST_DERIVATION_CODES } from "../src/trust/derive.js";
import {
  TRUST_DOC_BEGIN_MARKER,
  TRUST_DOC_END_MARKER,
  renderTrustDoc,
} from "../src/trust/doc.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TRUST_DOC_PATH = join(REPO_ROOT, "docs", "TRUST.md");

describe("docs/TRUST.md — generated spec stays in lockstep with derive.ts (doc drift = failure)", () => {
  it("the committed doc contains exactly the block renderTrustDoc() generates", () => {
    const doc = readFileSync(TRUST_DOC_PATH, "utf8");
    const begin = doc.indexOf(TRUST_DOC_BEGIN_MARKER);
    const end = doc.indexOf(TRUST_DOC_END_MARKER);
    expect(begin, `missing ${TRUST_DOC_BEGIN_MARKER} in docs/TRUST.md`).toBeGreaterThanOrEqual(0);
    expect(end, `missing ${TRUST_DOC_END_MARKER} in docs/TRUST.md`).toBeGreaterThan(begin);

    const committed = doc.slice(begin, end + TRUST_DOC_END_MARKER.length);
    // If this fails, a trust threshold or rule changed without regenerating
    // the doc: run `pnpm --filter @northcinder/protocol gen:trust-doc` and commit.
    expect(committed).toBe(renderTrustDoc());
  });

  it("every TRUST_THRESHOLDS key and value appears in the generated block", () => {
    const block = renderTrustDoc();
    for (const [key, value] of Object.entries(TRUST_THRESHOLDS)) {
      expect(block).toContain(key);
      expect(block).toContain(String(value));
    }
  });

  it("the generated block documents every derivation code and the two hard invariants", () => {
    const block = renderTrustDoc();
    for (const code of Object.values(TRUST_DERIVATION_CODES)) {
      expect(block).toContain(code);
    }
    // Invariant 2: automated signals never flag.
    expect(block).toContain("deny-grade evidence");
    // Invariant 1: absence of history is never negative evidence.
    expect(block).toContain("never negative evidence");
  });

  it("the generated block documents the trustKey rule", () => {
    const block = renderTrustDoc();
    expect(block).toContain("`merchant.domain`");
    expect(block).toContain("${domain}#${id}");
  });
});
