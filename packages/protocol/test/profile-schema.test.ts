import { describe, expect, it } from "vitest";
import {
  InterpretedQuerySchema,
  ProfileEntryInputSchema,
  ProfileEntrySchema,
  ProfileOriginSchema,
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
