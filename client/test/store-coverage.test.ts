import { describe, expect, it } from "vitest";
import type { StoreStatus } from "@northcinder/protocol";
import { verifyStoreCoverage } from "../src/store-coverage.js";

const statuses: StoreStatus[] = [{ store: "shopify", ok: true, offerCount: 1, durationMs: 1 }];

describe("registered-store coverage verification", () => {
  it("flags a service response that omits a registered store status", () => {
    expect(verifyStoreCoverage(["shopify", "amazon"], statuses)).toEqual({ verified: false, missing: ["amazon"], unexpected: [] });
  });

  it("accepts exactly one status for each registered store", () => {
    expect(verifyStoreCoverage(["shopify"], statuses)).toEqual({ verified: true, missing: [], unexpected: [] });
  });

  it("flags duplicate status rows instead of treating set membership as complete coverage", () => {
    expect(verifyStoreCoverage(["shopify"], [...statuses, statuses[0]!])).toMatchObject({ verified: false, unexpected: ["shopify"] });
  });

  it("is explicitly not applicable to a legacy service with no registered-store enumeration", () => {
    expect(verifyStoreCoverage(undefined, statuses)).toEqual({ verified: "not_applicable", missing: [], unexpected: [] });
  });
});
