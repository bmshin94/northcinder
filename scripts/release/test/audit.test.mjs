import assert from "node:assert/strict";
import test from "node:test";
import { summarizeAudit } from "../audit.mjs";

test("audit summary accepts pnpm's live JSON shape, derives exact total, and fails the default high threshold", () => {
  const summary = summarizeAudit({ metadata: { vulnerabilities: { info: 1, low: 3, moderate: 5, high: 8, critical: 0 } } }, "full");
  assert.deepEqual(summary, { scope: "full", counts: { info: 1, low: 3, moderate: 5, high: 8, critical: 0, total: 17 }, passesPolicy: false });
});

test("audit summary permits low/moderate-only output at the high policy threshold", () => {
  const summary = summarizeAudit({ metadata: { vulnerabilities: { info: 0, low: 1, moderate: 2, high: 0, critical: 0 } } }, "prod");
  assert.equal(summary.passesPolicy, true);
});
