/**
 * Vitest wrapper around the conformance checks. Import this from
 * `@northcinder/protocol/conformance` INSIDE a Vitest test file only (it imports
 * vitest, which is an optional peer of this package):
 *
 * ```ts
 * import { runConformanceSuite } from "@northcinder/protocol/conformance";
 * import { createMyAdapter } from "../src/index.js";
 *
 * runConformanceSuite(() => createMyAdapter(), {
 *   searchQuery: { text: "a query my fixtures answer" },
 *   knownOfferId: "an-offer-my-fixtures-contain",
 * });
 * ```
 */
import { describe, expect, it } from "vitest";
import {
  CONFORMANCE_RULES,
  checkConformance,
  type ConformanceOptions,
  type ConformanceReport,
} from "./check.js";
import type { StoreAdapter } from "../adapter/store-adapter.js";

export function runConformanceSuite(
  adapter: StoreAdapter | (() => StoreAdapter),
  options: ConformanceOptions = {},
): void {
  const instance = typeof adapter === "function" ? adapter() : adapter;

  describe(`adapter conformance: ${instance.manifest?.id ?? "unknown adapter"}`, () => {
    let reportPromise: Promise<ConformanceReport> | undefined;
    const getReport = () => (reportPromise ??= checkConformance(instance, options));

    for (const rule of CONFORMANCE_RULES) {
      it(rule, async () => {
        const report = await getReport();
        const result = report.results.find((r) => r.rule === rule);
        expect(result, `conformance rule ${rule} did not run`).toBeDefined();
        expect(result?.errors ?? [`rule ${rule} missing from report`]).toEqual([]);
      });
    }
  });
}

export { checkConformance, CONFORMANCE_RULES } from "./check.js";
export type { ConformanceOptions, ConformanceReport, ConformanceRuleResult, ConformanceRule } from "./check.js";
