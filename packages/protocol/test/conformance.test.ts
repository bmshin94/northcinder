import { describe, expect, it } from "vitest";
import {
  AdapterManifestSchema,
  checkConformance,
  createBrokenReferenceAdapter,
  createReferenceAdapter,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// AdapterManifest — identity + permission scope (spec §6)
// ---------------------------------------------------------------------------

const validManifest = {
  id: "reference",
  name: "Reference in-memory adapter",
  version: "0.2.0",
  permissions: { allowedHosts: [], userSession: false },
  capabilities: { checkout: false },
};

describe("AdapterManifestSchema", () => {
  it("parses a valid manifest with explicit permission scope", () => {
    const parsed = AdapterManifestSchema.parse(validManifest);
    expect(parsed.id).toBe("reference");
    expect(parsed.permissions.userSession).toBe(false);
    expect(parsed.permissions.allowedHosts).toEqual([]);
  });

  it("accepts real hostnames and subdomain wildcards", () => {
    const parsed = AdapterManifestSchema.parse({
      ...validManifest,
      permissions: {
        allowedHosts: ["catalog.shopify.com", "*.myshopify.com", "localhost"],
        userSession: false,
      },
    });
    expect(parsed.permissions.allowedHosts).toContain("*.myshopify.com");
  });

  it("REJECTS a global wildcard host — an adapter may not call the whole internet", () => {
    const result = AdapterManifestSchema.safeParse({
      ...validManifest,
      permissions: { allowedHosts: ["*"], userSession: false },
    });
    expect(result.success).toBe(false);
  });

  it("rejects host entries carrying schemes or paths (must be bare hostnames)", () => {
    for (const bad of ["https://evil.example/steal", "evil.example/path", "evil.example:8080"]) {
      expect(
        AdapterManifestSchema.safeParse({
          ...validManifest,
          permissions: { allowedHosts: [bad], userSession: false },
        }).success,
      ).toBe(false);
    }
  });

  it("accepts a properly-scoped wildcard but REJECTS a bare-TLD wildcard (*.com)", () => {
    expect(
      AdapterManifestSchema.safeParse({
        ...validManifest,
        permissions: { allowedHosts: ["*.myshopify.com"], userSession: false },
      }).success,
    ).toBe(true);
    expect(
      AdapterManifestSchema.safeParse({
        ...validManifest,
        permissions: { allowedHosts: ["*.com"], userSession: false },
      }).success,
    ).toBe(false);
  });

  it("rejects a manifest that does not declare session access", () => {
    expect(
      AdapterManifestSchema.safeParse({
        ...validManifest,
        permissions: { allowedHosts: [] },
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Conformance harness vs the PASSING reference adapter
// ---------------------------------------------------------------------------

describe("checkConformance: in-memory reference adapter", () => {
  it("passes every rule", async () => {
    const report = await checkConformance(createReferenceAdapter());
    const failed = report.results.filter((r) => !r.passed);
    expect(failed).toEqual([]);
    expect(report.passed).toBe(true);
    // The harness actually ran the substantive rules, not an empty loop.
    const ruleIds = report.results.map((r) => r.rule);
    expect(ruleIds).toContain("manifest-schema");
    expect(ruleIds).toContain("manifest-permission-scope");
    expect(ruleIds).toContain("search-offers-schema-valid");
    expect(ruleIds).toContain("search-provenance-matches-manifest");
    expect(ruleIds).toContain("search-timeout-graceful");
    expect(ruleIds).toContain("get-offer-known-id");
    expect(ruleIds).toContain("get-offer-unknown-id-structured");
  });

  it("reference adapter returns schema-valid offers including a declared sponsored flag", async () => {
    const adapter = createReferenceAdapter();
    const result = await adapter.search({ text: "fairphone" }, { timeoutMs: 1000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.offers.length).toBeGreaterThan(0);
      for (const offer of result.offers) {
        expect(typeof offer.sponsored).toBe("boolean");
        expect(offer.sourceStore).toBe("reference");
      }
    }
  });

  it("reference adapter getOffer returns structured not_found for unknown ids, never throws", async () => {
    const adapter = createReferenceAdapter();
    const result = await adapter.getOffer("no-such-offer", { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
      expect(result.error.store).toBe("reference");
    }
  });
});

// ---------------------------------------------------------------------------
// Conformance harness vs the deliberately-BROKEN reference adapter
// (undeclared sponsored, out-of-scope host in manifest, hang on search)
// ---------------------------------------------------------------------------

describe("checkConformance: deliberately-broken reference adapter", () => {
  it("fails with specific, distinct errors for each defect", async () => {
    const report = await checkConformance(createBrokenReferenceAdapter(), {
      timeoutMs: 300,
      timeoutGraceMs: 200,
    });
    expect(report.passed).toBe(false);

    const failuresByRule = new Map(
      report.results.filter((r) => !r.passed).map((r) => [r.rule, r.errors.join("\n")]),
    );

    // Defect 1: out-of-scope host in the manifest permission scope.
    expect(failuresByRule.get("manifest-permission-scope")).toMatch(/host/i);
    expect(failuresByRule.get("manifest-permission-scope")).toMatch(/\*|evil\.example/);

    // Defect 2: hang on search → must degrade to a structured error, not hang/throw.
    expect(failuresByRule.get("search-timeout-graceful")).toMatch(/did not settle|hung|timeout/i);

    // Defect 3: undeclared sponsored on getOffer output → schema violation naming the field.
    expect(failuresByRule.get("get-offer-known-id")).toMatch(/sponsored/);
  });

  it("a passing rule on a broken adapter is still reported (report covers all rules)", async () => {
    const report = await checkConformance(createBrokenReferenceAdapter(), {
      timeoutMs: 300,
      timeoutGraceMs: 200,
    });
    const ruleIds = report.results.map((r) => r.rule);
    // Every rule ran and reported, pass or fail — no early abort hiding defects.
    expect(ruleIds).toContain("manifest-schema");
    expect(ruleIds).toContain("search-timeout-graceful");
    expect(ruleIds).toContain("get-offer-known-id");
  });
});

// ---------------------------------------------------------------------------
// search-timeout-graceful PASS branch: a structured timeout/unavailable
// StoreError returned WITHIN budget (not a hang) must pass the rule.
// ---------------------------------------------------------------------------

describe("checkConformance: search-timeout-graceful accept branch", () => {
  it("passes when the adapter resolves quickly with a structured unavailable/timeout error", async () => {
    const referenceAdapter = createReferenceAdapter();
    const gracefullyDegradedAdapter = {
      manifest: referenceAdapter.manifest,
      async search() {
        return {
          ok: false as const,
          error: {
            code: "unavailable" as const,
            message: "upstream store did not respond in time",
            store: referenceAdapter.manifest.id,
            retryable: true,
          },
        };
      },
      getOffer: referenceAdapter.getOffer.bind(referenceAdapter),
    };

    const report = await checkConformance(gracefullyDegradedAdapter, {
      timeoutMs: 300,
      timeoutGraceMs: 200,
    });

    const byRule = new Map(report.results.map((r) => [r.rule, r]));
    const graceful = byRule.get("search-timeout-graceful");
    expect(graceful).toBeDefined();
    expect(graceful?.passed).toBe(true);
    expect(graceful?.errors).toEqual([]);
  });
});
