import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProfileStore, PROFILE_FILENAME } from "../src/index.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "northcinder-profile-"));
}

describe("profile store — stated vs inferred lifecycle", () => {
  it("add() assigns id, createdAt and the CALLER-CHOSEN origin + source; list() returns the entry", () => {
    const dir = tempDir();
    const store = createProfileStore({ configDir: dir, now: () => new Date("2026-07-05T10:00:00.000Z") });
    const stated = store.add(
      { kind: "budget", category: "sneakers", maxPrice: { amount: 12000, currency: "USD" } },
      { origin: "stated", source: "update_profile (user-stated via host agent)" },
    );
    expect(stated.origin).toBe("stated");
    expect(stated.source).toBe("update_profile (user-stated via host agent)");
    expect(stated.createdAt).toBe("2026-07-05T10:00:00.000Z");
    expect(stated.id).toMatch(/^pref_/);
    const inferred = store.add(
      { kind: "brand", brand: "Acme", stance: "deny" },
      { origin: "inferred", source: "record_feedback:not_interested offer ebay:item-1" },
    );
    expect(inferred.origin).toBe("inferred");

    const listed = store.list();
    expect(listed).toHaveLength(2);
    expect(listed.find((e) => e.id === stated.id)).toEqual(stated);
    expect(listed.find((e) => e.id === inferred.id)).toEqual(inferred);
  });

  it("persists across store instances (same file, re-read on every operation)", () => {
    const dir = tempDir();
    const a = createProfileStore({ configDir: dir });
    const entry = a.add({ kind: "ethics", flag: "fair-trade" }, { origin: "stated", source: "update_profile" });
    const b = createProfileStore({ configDir: dir });
    expect(b.list()).toEqual([entry]);
  });

  it("remove() deletes any entry (incl. inferred) in ONE call and returns attribution metadata ONLY — never the value", () => {
    const dir = tempDir();
    const store = createProfileStore({ configDir: dir });
    const inferred = store.add(
      { kind: "brand", brand: "SecretBrandValue", stance: "deny" },
      { origin: "inferred", source: "record_feedback:not_interested offer ebay:item-1" },
    );
    const outcome = store.remove(inferred.id);
    expect(outcome).toEqual({ removed: true, entry: { id: inferred.id, kind: "brand", origin: "inferred" } });
    expect(JSON.stringify(outcome)).not.toContain("SecretBrandValue");
    expect(store.list()).toEqual([]);
    // the deleted value is gone from disk too
    expect(readFileSync(join(dir, PROFILE_FILENAME), "utf8")).not.toContain("SecretBrandValue");
  });

  it("remove() of an unknown id reports removed:false without inventing data", () => {
    const store = createProfileStore({ configDir: tempDir() });
    expect(store.remove("pref_nope")).toEqual({ removed: false });
  });

  it("the profile file is mode 0600 (user data — spec privacy constraint)", () => {
    const dir = tempDir();
    const store = createProfileStore({ configDir: dir });
    store.add({ kind: "delivery", maxDays: 5 }, { origin: "stated", source: "update_profile" });
    const mode = statSync(join(dir, PROFILE_FILENAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("fails CLOSED on a corrupt profile file instead of silently dropping the user's data", () => {
    const dir = tempDir();
    writeFileSync(join(dir, PROFILE_FILENAME), "{not json", { mode: 0o600 });
    const store = createProfileStore({ configDir: dir });
    expect(() => store.list()).toThrow(/profile/i);
  });
});
