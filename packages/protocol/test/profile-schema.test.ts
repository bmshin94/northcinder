import { describe, expect, it } from "vitest";
import {
  InterpretedQuerySchema,
  BrandPreferenceProposalSchema,
  BuyerContextSchema,
  ProfileEntryInputSchema,
  ProfileEntrySchema,
  ProfileOriginSchema,
  PreferenceReasonSchema,
  PreferenceScopeSchema,
} from "../src/index.js";

const BASE = {
  id: "pref_1",
  origin: "stated" as const,
  source: "update_profile (user-stated via host agent)",
  createdAt: "2026-07-05T10:00:00.000Z",
};

describe("profile entry schemas (open contract)", () => {
  it("accepts every entry kind with the mandatory origin/source/createdAt trio", () => {
    const entries = [
      { ...BASE, kind: "size", category: "sneakers", value: "EU 43" },
      { ...BASE, kind: "budget", category: "sneakers", maxPrice: { amount: 12000, currency: "USD" } },
      { ...BASE, kind: "brand", brand: "Acme", stance: "deny" },
      { ...BASE, kind: "ethics", flag: "fair-trade" },
      { ...BASE, kind: "delivery", maxDays: 5 },
      { ...BASE, kind: "notification", event: "price_drop", enabled: true },
    ];
    for (const entry of entries) {
      const parsed = ProfileEntrySchema.safeParse(entry);
      expect(parsed.success, `kind ${entry.kind} should parse`).toBe(true);
    }
  });

  it("requires origin to be exactly stated|inferred — no default, no third value", () => {
    expect(ProfileOriginSchema.safeParse("stated").success).toBe(true);
    expect(ProfileOriginSchema.safeParse("inferred").success).toBe(true);
    expect(ProfileOriginSchema.safeParse("guessed").success).toBe(false);
    const missingOrigin = { ...BASE, kind: "ethics", flag: "fair-trade" } as Record<string, unknown>;
    delete missingOrigin.origin;
    expect(ProfileEntrySchema.safeParse(missingOrigin).success).toBe(false);
  });

  it("rejects entries missing source or createdAt (attribution is mandatory)", () => {
    const noSource = { ...BASE, kind: "ethics", flag: "fair-trade" } as Record<string, unknown>;
    delete noSource.source;
    expect(ProfileEntrySchema.safeParse(noSource).success).toBe(false);
    const noCreatedAt = { ...BASE, kind: "ethics", flag: "fair-trade" } as Record<string, unknown>;
    delete noCreatedAt.createdAt;
    expect(ProfileEntrySchema.safeParse(noCreatedAt).success).toBe(false);
  });

  it("rejects unknown kinds", () => {
    expect(ProfileEntrySchema.safeParse({ ...BASE, kind: "telemetry", anything: true }).success).toBe(false);
  });

  it("entry INPUT shape carries no id/origin/source/createdAt — the store assigns those", () => {
    const parsed = ProfileEntryInputSchema.safeParse({ kind: "budget", category: "sneakers", maxPrice: { amount: 12000, currency: "USD" } });
    expect(parsed.success).toBe(true);
    // a caller-supplied origin must not survive parsing (it is store-assigned)
    const smuggled = ProfileEntryInputSchema.parse({
      kind: "ethics",
      flag: "fair-trade",
      origin: "stated",
      id: "pref_fake",
    } as Record<string, unknown>);
    expect("origin" in smuggled).toBe(false);
    expect("id" in smuggled).toBe(false);
  });

  it("accepts bounded, strict preference scopes and caller-supplied scope/expiry entries", () => {
    for (const kind of ["subject", "category", "project"] as const) {
      expect(PreferenceScopeSchema.safeParse({ kind, value: "sneakers" }).success).toBe(true);
    }
    expect(PreferenceScopeSchema.safeParse({ kind: "subject", value: "" }).success).toBe(false);
    expect(PreferenceScopeSchema.safeParse({ kind: "subject", value: "sneakers", extra: true }).success).toBe(false);
    expect(
      ProfileEntryInputSchema.safeParse({
        kind: "brand",
        brand: "Acme",
        stance: "deny",
        scope: { kind: "project", value: "birthday" },
        expiresAt: "2026-08-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("keeps buyerContext.project bounded and ephemeral at the query schema boundary", () => {
    expect(BuyerContextSchema.safeParse({ project: "birthday" }).success).toBe(true);
    expect(BuyerContextSchema.safeParse({ project: "x".repeat(501) }).success).toBe(false);
  });

  it("exposes strict conservative brand proposals with unique evidence", () => {
    expect(PreferenceReasonSchema.safeParse("wrong_recipient").success).toBe(true);
    expect(PreferenceReasonSchema.safeParse("because").success).toBe(false);
    const proposal = {
      id: "proposal_1",
      kind: "brand",
      brand: "Acme",
      stance: "deny",
      reason: "fit",
      scope: { kind: "subject", value: "dad" },
      evidenceKeys: ["ebay:item-1"],
      source: "record_feedback:not_interested offer ebay:item-1",
      createdAt: "2026-07-05T10:00:00.000Z",
      updatedAt: "2026-07-05T10:00:00.000Z",
    };
    expect(BrandPreferenceProposalSchema.safeParse(proposal).success).toBe(true);
    expect(BrandPreferenceProposalSchema.safeParse({ ...proposal, evidenceKeys: ["ebay:item-1", "ebay:item-1"] }).success).toBe(false);
    expect(BrandPreferenceProposalSchema.safeParse({ ...proposal, extra: true }).success).toBe(false);
  });

  it("InterpretedQuery discloses merged criteria, applied entries by id+origin, overridden entries, and unmatched words", () => {
    const parsed = InterpretedQuerySchema.safeParse({
      criteria: { text: "wool sneakers", maxPrice: { amount: 12000, currency: "USD" } },
      appliedProfileEntries: [
        { id: "pref_1", origin: "stated", kind: "budget", appliedTo: "maxPrice", detail: 'budget for "sneakers": 120.00 USD' },
      ],
      overriddenProfileEntries: [
        { id: "pref_2", origin: "inferred", kind: "budget", appliedTo: "maxPrice", detail: 'budget for "sneakers": 90.00 USD', overriddenBy: "per-query maxPrice" },
      ],
      unmatchedQueryWords: ["wool"],
    });
    expect(parsed.success).toBe(true);
    const noOverriddenBy = InterpretedQuerySchema.safeParse({
      criteria: { text: "wool sneakers" },
      appliedProfileEntries: [],
      overriddenProfileEntries: [{ id: "pref_2", origin: "inferred", kind: "budget", appliedTo: "maxPrice", detail: "x" }],
      unmatchedQueryWords: [],
    });
    expect(noOverriddenBy.success).toBe(false);
  });
});
