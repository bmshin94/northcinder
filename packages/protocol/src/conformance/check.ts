import { z } from "zod";
import { OfferSchema, type SearchQuery } from "../schemas/core.js";
import { StoreErrorSchema } from "../schemas/errors.js";
import { AdapterManifestSchema, AllowedHostSchema } from "../adapter/manifest.js";
import type { StoreAdapter } from "../adapter/store-adapter.js";
import {
  REFERENCE_KNOWN_OFFER_ID,
  REFERENCE_KNOWN_QUERY,
} from "../reference/reference-adapter.js";

export interface ConformanceOptions {
  /**
   * A query the adapter is expected to answer with ≥1 offer (fixture-backed
   * where the store is key-gated). Every adapter package MUST supply its own;
   * the default only fits the in-memory reference adapter.
   */
  searchQuery?: SearchQuery;
  /** An offer id the adapter is expected to resolve via getOffer. */
  knownOfferId?: string;
  /** Per-call budget handed to the adapter (default 1000ms). */
  timeoutMs?: number;
  /**
   * Extra time the harness waits beyond timeoutMs before declaring the call
   * hung (default 500ms).
   */
  timeoutGraceMs?: number;
}

export interface ConformanceRuleResult {
  rule: string;
  passed: boolean;
  errors: string[];
}

export interface ConformanceReport {
  adapterId: string;
  passed: boolean;
  results: ConformanceRuleResult[];
}

/** Ordered list of rules the harness enforces (stable ids — assert on these). */
export const CONFORMANCE_RULES = [
  "manifest-schema",
  "manifest-permission-scope",
  "search-offers-schema-valid",
  "search-provenance-matches-manifest",
  "search-timeout-graceful",
  "get-offer-known-id",
  "get-offer-unknown-id-structured",
] as const;
export type ConformanceRule = (typeof CONFORMANCE_RULES)[number];

type Settled<T> =
  | { settled: true; outcome: "resolved"; value: T }
  | { settled: true; outcome: "rejected"; reason: unknown }
  | { settled: false };

async function settleWithin<T>(run: () => Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  const attempt: Promise<Settled<T>> = (async () => {
    try {
      const value = await run();
      return { settled: true, outcome: "resolved", value } as const;
    } catch (reason) {
      return { settled: true, outcome: "rejected", reason } as const;
    }
  })();
  const result = await Promise.race([attempt, timeout]);
  clearTimeout(timer!);
  return result;
}

function zodIssues(error: z.ZodError, prefix: string): string[] {
  return error.issues.map(
    (i) => `${prefix}${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`,
  );
}

/**
 * Run every conformance rule against an adapter and return a full report.
 * Pure (no vitest dependency) so services/tools can gate on it too; the
 * Vitest wrapper is `runConformanceSuite` in `@northcinder/protocol/conformance`.
 */
export async function checkConformance(
  adapter: StoreAdapter,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const query = options.searchQuery ?? REFERENCE_KNOWN_QUERY;
  const knownOfferId = options.knownOfferId ?? REFERENCE_KNOWN_OFFER_ID;
  const timeoutMs = options.timeoutMs ?? 1000;
  const graceMs = options.timeoutGraceMs ?? 500;
  const budget = timeoutMs + graceMs;
  const manifest = adapter.manifest;

  const results: ConformanceRuleResult[] = [];
  const record = (rule: ConformanceRule, errors: string[]) =>
    results.push({ rule, passed: errors.length === 0, errors });

  // --- Rule: manifest-schema -----------------------------------------------
  {
    const parsed = AdapterManifestSchema.safeParse(manifest);
    record(
      "manifest-schema",
      parsed.success ? [] : zodIssues(parsed.error, "manifest."),
    );
  }

  // --- Rule: manifest-permission-scope -------------------------------------
  {
    const errors: string[] = [];
    const permissions = (manifest as { permissions?: unknown }).permissions;
    if (permissions === null || typeof permissions !== "object") {
      errors.push("manifest declares no permissions block");
    } else {
      const { allowedHosts, userSession } = permissions as {
        allowedHosts?: unknown;
        userSession?: unknown;
      };
      if (!Array.isArray(allowedHosts)) {
        errors.push("permissions.allowedHosts must be an array of hostnames");
      } else {
        for (const host of allowedHosts) {
          const parsed = AllowedHostSchema.safeParse(host);
          if (!parsed.success) {
            errors.push(
              `out-of-scope host in manifest permissions: ${JSON.stringify(host)} — ${
                parsed.error.issues[0]?.message ?? "invalid host entry"
              }`,
            );
          }
        }
      }
      if (typeof userSession !== "boolean") {
        errors.push("permissions.userSession must be explicitly declared as a boolean");
      }
    }
    record("manifest-permission-scope", errors);
  }

  // --- Shared search invocation (rules 3+4 observe the same call) ----------
  const searchOutcome = await settleWithin(
    () => adapter.search(query, { timeoutMs }),
    budget,
  );

  // --- Rule: search-offers-schema-valid ------------------------------------
  {
    const errors: string[] = [];
    if (!searchOutcome.settled) {
      errors.push(
        `search(${JSON.stringify(query.text)}) did not settle within ${budget}ms — hung stores must degrade to a structured error`,
      );
    } else if (searchOutcome.outcome === "rejected") {
      errors.push(
        `search rejected (${String(searchOutcome.reason)}) — adapters must resolve with a structured StoreError, never throw`,
      );
    } else if (!searchOutcome.value.ok) {
      errors.push(
        `search returned an error for the adapter's own known-good query: [${searchOutcome.value.error.code}] ${searchOutcome.value.error.message}`,
      );
    } else if (searchOutcome.value.offers.length === 0) {
      errors.push(
        `search(${JSON.stringify(query.text)}) returned 0 offers — the conformance query must produce at least one offer, otherwise schema conformance is unverifiable`,
      );
    } else {
      for (const offer of searchOutcome.value.offers) {
        const parsed = OfferSchema.safeParse(offer);
        if (!parsed.success) {
          errors.push(...zodIssues(parsed.error, `offer(${(offer as { id?: string }).id ?? "?"}).`));
        }
      }
    }
    record("search-offers-schema-valid", errors);
  }

  // --- Rule: search-provenance-matches-manifest -----------------------------
  {
    const errors: string[] = [];
    if (!searchOutcome.settled || searchOutcome.outcome !== "resolved") {
      errors.push("provenance unverifiable: search did not resolve (see search rules)");
    } else if (searchOutcome.value.ok) {
      for (const offer of searchOutcome.value.offers) {
        if (offer.sourceStore !== manifest.id) {
          errors.push(
            `offer ${offer.id} declares sourceStore=${JSON.stringify(offer.sourceStore)} but the manifest id is ${JSON.stringify(manifest.id)}`,
          );
        }
      }
    }
    record("search-provenance-matches-manifest", errors);
  }

  // --- Rule: search-timeout-graceful ----------------------------------------
  {
    const errors: string[] = [];
    // Fresh call so caching in rule 3 can't mask hanging behavior.
    const outcome = await settleWithin(() => adapter.search(query, { timeoutMs }), budget);
    if (!outcome.settled) {
      errors.push(
        `search did not settle within timeoutMs(${timeoutMs}) + grace(${graceMs}) — a timed-out store must resolve with a structured timeout/unavailable error, not hang`,
      );
    } else if (outcome.outcome === "rejected") {
      errors.push(
        `search rejected under a timeout budget (${String(outcome.reason)}) — must resolve with a structured StoreError`,
      );
    } else if (!outcome.value.ok) {
      const parsed = StoreErrorSchema.safeParse(outcome.value.error);
      if (!parsed.success) {
        errors.push(...zodIssues(parsed.error, "search error."));
      }
    }
    record("search-timeout-graceful", errors);
  }

  // --- Rule: get-offer-known-id ---------------------------------------------
  {
    const errors: string[] = [];
    const outcome = await settleWithin(() => adapter.getOffer(knownOfferId, { timeoutMs }), budget);
    if (!outcome.settled) {
      errors.push(`getOffer(${JSON.stringify(knownOfferId)}) did not settle within ${budget}ms`);
    } else if (outcome.outcome === "rejected") {
      errors.push(`getOffer rejected (${String(outcome.reason)}) — must resolve with a structured StoreError`);
    } else if (!outcome.value.ok) {
      errors.push(
        `getOffer for the adapter's known offer id failed: [${outcome.value.error.code}] ${outcome.value.error.message}`,
      );
    } else {
      const parsed = OfferSchema.safeParse(outcome.value.offer);
      if (!parsed.success) {
        errors.push(...zodIssues(parsed.error, "offer."));
      }
    }
    record("get-offer-known-id", errors);
  }

  // --- Rule: get-offer-unknown-id-structured ---------------------------------
  {
    const errors: string[] = [];
    const bogusId = "__northcinder-conformance-nonexistent-offer__";
    const outcome = await settleWithin(() => adapter.getOffer(bogusId, { timeoutMs }), budget);
    if (!outcome.settled) {
      errors.push(`getOffer(unknown id) did not settle within ${budget}ms`);
    } else if (outcome.outcome === "rejected") {
      errors.push(
        `getOffer(unknown id) rejected (${String(outcome.reason)}) — must resolve with a structured not_found StoreError`,
      );
    } else if (outcome.value.ok) {
      errors.push(
        "getOffer returned ok for a nonexistent offer id — must return a structured not_found error",
      );
    } else {
      const parsed = StoreErrorSchema.safeParse(outcome.value.error);
      if (!parsed.success) {
        errors.push(...zodIssues(parsed.error, "getOffer error."));
      } else if (parsed.data.code !== "not_found") {
        errors.push(
          `getOffer(unknown id) returned code ${JSON.stringify(parsed.data.code)} — expected "not_found"`,
        );
      }
    }
    record("get-offer-unknown-id-structured", errors);
  }

  return {
    adapterId: String(manifest?.id ?? "unknown"),
    passed: results.every((r) => r.passed),
    results,
  };
}
