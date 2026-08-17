import { describe, expect, it } from "vitest";
import type { ProfileEntry, SearchQuery } from "@northcinder/protocol";
import { interpretQuery } from "../src/index.js";

const NOW = () => new Date("2026-07-05T10:00:00.000Z");

function entry(partial: Record<string, unknown>): ProfileEntry {
  return {
    id: "pref_1",
    origin: "stated",
    source: "update_profile",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...partial,
  } as ProfileEntry;
}

describe("interpretQuery — profile-defaults merge with per-query precedence", () => {
  const budget = entry({ kind: "budget", category: "sneakers", maxPrice: { amount: 12000, currency: "USD" } });

  it("applies a category-matched budget default when the query has no maxPrice, cited by exact id+origin", () => {
    const query: SearchQuery = { text: "wool sneakers" };
    const out = interpretQuery(query, [budget], NOW);
    expect(out.criteria.maxPrice).toEqual({ amount: 12000, currency: "USD" });
    expect(out.appliedProfileEntries).toEqual([
      {
        id: "pref_1",
        origin: "stated",
        kind: "budget",
        appliedTo: "maxPrice",
        detail: 'budget for "sneakers": 120.00 USD',
      },
    ]);
    expect(out.overriddenProfileEntries).toEqual([]);
  });

  it("PRECEDENCE: a per-query maxPrice overrides the profile budget — and BOTH are visible", () => {
    const query: SearchQuery = { text: "wool sneakers", maxPrice: { amount: 9000, currency: "USD" } };
    const out = interpretQuery(query, [budget], NOW);
    expect(out.criteria.maxPrice).toEqual({ amount: 9000, currency: "USD" }); // per-query wins
    expect(out.appliedProfileEntries).toEqual([]);
    expect(out.overriddenProfileEntries).toEqual([
      {
        id: "pref_1",
        origin: "stated",
        kind: "budget",
        appliedTo: "maxPrice",
        detail: 'budget for "sneakers": 120.00 USD',
        overriddenBy: "per-query maxPrice",
      },
    ]);
  });

  it("ignores budget entries whose category does not appear in the query text", () => {
    const out = interpretQuery({ text: "standing desk" }, [budget], NOW);
    expect(out.criteria.maxPrice).toBeUndefined();
    expect(out.appliedProfileEntries).toEqual([]);
    expect(out.overriddenProfileEntries).toEqual([]);
  });

  it("matches categories across singular/plural (category 'sneakers' matches 'sneaker')", () => {
    const out = interpretQuery({ text: "wool sneaker" }, [budget], NOW);
    expect(out.criteria.maxPrice).toEqual({ amount: 12000, currency: "USD" });
  });

  it("when several budgets match, the most recently created one wins (latest default)", () => {
    const older = budget;
    const newer = entry({
      id: "pref_2",
      createdAt: "2026-07-03T00:00:00.000Z",
      kind: "budget",
      category: "sneakers",
      maxPrice: { amount: 8000, currency: "USD" },
    });
    const out = interpretQuery({ text: "sneakers" }, [older, newer], NOW);
    expect(out.criteria.maxPrice).toEqual({ amount: 8000, currency: "USD" });
    expect(out.appliedProfileEntries.map((e) => e.id)).toEqual(["pref_2"]);
  });

  it("appends a category-matched size to mustHaveAttributes (deduplicated case-insensitively)", () => {
    const size = entry({ id: "pref_s", kind: "size", category: "sneakers", value: "EU 43" });
    const applied = interpretQuery({ text: "sneakers" }, [size], NOW);
    expect(applied.criteria.mustHaveAttributes).toEqual(["EU 43"]);
    expect(applied.appliedProfileEntries).toEqual([
      { id: "pref_s", origin: "stated", kind: "size", appliedTo: "mustHaveAttributes", detail: 'size for "sneakers": EU 43' },
    ]);
    const dup = interpretQuery({ text: "sneakers", mustHaveAttributes: ["eu 43"] }, [size], NOW);
    expect(dup.criteria.mustHaveAttributes).toEqual(["eu 43"]);
    expect(dup.overriddenProfileEntries[0]?.overriddenBy).toBe("per-query mustHaveAttributes");
  });

  it("CONFLICT: a per-query size beats a conflicting profile size — the gift scenario", () => {
    // The user's own size is EU 43, but this search is a gift in EU 38. Merging
    // BOTH sizes would downrank the correct EU-38 offers — worse than a miss.
    const size = entry({ id: "pref_s", kind: "size", category: "sneakers", value: "EU 43" });
    const out = interpretQuery({ text: "sneakers for a gift", mustHaveAttributes: ["EU 38"] }, [size], NOW);
    expect(out.criteria.mustHaveAttributes).toEqual(["EU 38"]); // ONLY the per-query size
    expect(out.appliedProfileEntries).toEqual([]);
    expect(out.overriddenProfileEntries).toEqual([
      {
        id: "pref_s",
        origin: "stated",
        kind: "size",
        appliedTo: "mustHaveAttributes",
        detail: 'size for "sneakers": EU 43',
        overriddenBy: 'per-query mustHaveAttributes ("EU 38")',
      },
    ]);
  });

  it("a NON-size must-have does not suppress the profile size (no generic conflict logic)", () => {
    const size = entry({ id: "pref_s", kind: "size", category: "sneakers", value: "EU 43" });
    const out = interpretQuery({ text: "sneakers", mustHaveAttributes: ["waterproof"] }, [size], NOW);
    expect(out.criteria.mustHaveAttributes).toEqual(["waterproof", "EU 43"]);
  });

  it("unions standing ethics flags into ethicsFlags, keeping per-query flags first", () => {
    const ethics = entry({ id: "pref_e", kind: "ethics", flag: "fair-trade", origin: "inferred" });
    const out = interpretQuery({ text: "coffee beans", ethicsFlags: ["organic"] }, [ethics], NOW);
    expect(out.criteria.ethicsFlags).toEqual(["organic", "fair-trade"]);
    expect(out.appliedProfileEntries).toEqual([
      { id: "pref_e", origin: "inferred", kind: "ethics", appliedTo: "ethicsFlags", detail: 'ethics flag "fair-trade"' },
    ]);
  });

  it("fills deliveryBy from a delivery default (now + maxDays) only when the query has none", () => {
    const delivery = entry({ id: "pref_d", kind: "delivery", maxDays: 5 });
    const filled = interpretQuery({ text: "sneakers" }, [delivery], NOW);
    expect(filled.criteria.deliveryBy).toBe("2026-07-10");
    const kept = interpretQuery({ text: "sneakers", deliveryBy: "2026-07-08" }, [delivery], NOW);
    expect(kept.criteria.deliveryBy).toBe("2026-07-08");
    expect(kept.overriddenProfileEntries[0]?.overriddenBy).toBe("per-query deliveryBy");
  });

  it("brand and notification entries never mutate search criteria (SearchQuery has no such fields)", () => {
    const brand = entry({ id: "pref_b", kind: "brand", brand: "Acme", stance: "deny" });
    const notif = entry({ id: "pref_n", kind: "notification", event: "price_drop", enabled: true });
    const out = interpretQuery({ text: "sneakers" }, [brand, notif], NOW);
    expect(out.criteria).toEqual({ text: "sneakers" });
    expect(out.appliedProfileEntries).toEqual([]);
  });

  it("lists free-text words that map to no structured criterion (the honest 'fuzzy only' disclosure)", () => {
    const size = entry({ id: "pref_s", kind: "size", category: "sneakers", value: "EU 43" });
    const out = interpretQuery({ text: "wool blend sneakers", mustHaveAttributes: ["wool"] }, [size], NOW);
    // "wool" is a must-have attribute; "sneakers" matched the size entry's category; "blend" matched nothing
    expect(out.unmatchedQueryWords).toEqual(["blend"]);
  });

  it("with an empty profile it still echoes: criteria unchanged, nothing applied, all words unmatched", () => {
    const out = interpretQuery({ text: "wool sneakers" }, [], NOW);
    expect(out.criteria).toEqual({ text: "wool sneakers" });
    expect(out.appliedProfileEntries).toEqual([]);
    expect(out.overriddenProfileEntries).toEqual([]);
    expect(out.unmatchedQueryWords).toEqual(["wool", "sneakers"]);
  });
});
