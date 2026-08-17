import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveConfigDir } from "../src/index.js";

/**
 * resolveConfigDir lives in @northcinder/protocol (relocated out of
 * @northcinder/checkout's keystore) so checkout-free surfaces — notably the
 * northcinder-watch scheduler — can resolve the config dir without importing any
 * checkout code. @northcinder/checkout re-exports it for backward compatibility.
 */
describe("resolveConfigDir (shared config-dir resolution)", () => {
  it("uses the canonical directory when no discoverable legacy directory exists", () => {
    expect(resolveConfigDir({ NORTHCINDER_CONFIG_DIR: "/tmp/northcinder", XDG_CONFIG_HOME: "/tmp/xdg", HOME: "/tmp/home" })).toBe(
      "/tmp/northcinder",
    );
  });

  it("uses an explicit legacy config directory only as a fallback", () => {
    const legacy = mkdtempSync(join(tmpdir(), "northcinder-legacy-"));
    expect(resolveConfigDir({ EMPTOR_CONFIG_DIR: legacy })).toBe(legacy);
    expect(() => resolveConfigDir({ NORTHCINDER_CONFIG_DIR: "/tmp/canonical", EMPTOR_CONFIG_DIR: legacy })).toThrow(/refusing to split/i);
  });

  it("accepts Brier's config variable without making it canonical", () => {
    const legacy = mkdtempSync(join(tmpdir(), "northcinder-brier-legacy-"));
    expect(resolveConfigDir({ BRIER_CONFIG_DIR: legacy })).toBe(legacy);
    expect(() => resolveConfigDir({ NORTHCINDER_CONFIG_DIR: "/tmp/canonical", BRIER_CONFIG_DIR: legacy })).toThrow(/refusing to split/i);
  });

  it("accepts the earlier Then Again config variable without making it canonical", () => {
    const legacy = mkdtempSync(join(tmpdir(), "northcinder-thenagain-legacy-"));
    expect(resolveConfigDir({ THENAGAIN_CONFIG_DIR: legacy })).toBe(legacy);
    expect(() => resolveConfigDir({ NORTHCINDER_CONFIG_DIR: "/tmp/canonical", THENAGAIN_CONFIG_DIR: legacy })).toThrow(/refusing to split/i);
  });

  it("selects an explicit legacy path even before that directory exists", () => {
    const legacy = join(mkdtempSync(join(tmpdir(), "northcinder-explicit-")), "old-state");
    expect(resolveConfigDir({ EMPTOR_CONFIG_DIR: legacy })).toBe(legacy);
    expect(existsSync(legacy)).toBe(false);
  });

  it("rejects existing explicit aliases that are symlinks or files", () => {
    const root = mkdtempSync(join(tmpdir(), "northcinder-explicit-invalid-"));
    const target = mkdtempSync(join(tmpdir(), "northcinder-explicit-target-"));
    const link = join(root, "old-link");
    symlinkSync(target, link);
    const file = join(root, "old-file");
    writeFileSync(file, "not a directory");
    expect(() => resolveConfigDir({ EMPTOR_CONFIG_DIR: link })).toThrow(/symlink/i);
    expect(() => resolveConfigDir({ EMPTOR_CONFIG_DIR: file })).toThrow(/not a directory/i);
  });

  it("does not split equivalent physical legacy and canonical spellings", () => {
    const root = mkdtempSync(join(tmpdir(), "northcinder-equivalent-"));
    const legacy = join(root, "state");
    mkdirSync(legacy);
    expect(resolveConfigDir({ EMPTOR_CONFIG_DIR: legacy, NORTHCINDER_CONFIG_DIR: join(root, ".", "state") })).toBe(legacy);
  });

  it("discovers only the current XDG and HOME legacy candidates", () => {
    const xdg = mkdtempSync(join(tmpdir(), "northcinder-xdg-"));
    const legacy = join(xdg, "brier");
    mkdirSync(legacy);
    expect(resolveConfigDir({ XDG_CONFIG_HOME: xdg, HOME: "/unused" })).toBe(legacy);
    const home = mkdtempSync(join(tmpdir(), "northcinder-home-"));
    const homeLegacy = join(home, ".config", "emptor");
    mkdirSync(homeLegacy, { recursive: true });
    expect(resolveConfigDir({ HOME: home })).toBe(homeLegacy);
    expect(existsSync(join(home, ".config", "northcinder"))).toBe(false);
  });

  it("refuses two distinct discoverable legacy state domains", () => {
    const xdg = mkdtempSync(join(tmpdir(), "northcinder-ambiguous-"));
    mkdirSync(join(xdg, "thenagain"));
    mkdirSync(join(xdg, "emptor"));
    expect(() => resolveConfigDir({ XDG_CONFIG_HOME: xdg })).toThrow(/ambiguous legacy state/i);
  });

  it("rejects a symlink legacy candidate instead of following it", () => {
    const xdg = mkdtempSync(join(tmpdir(), "northcinder-link-"));
    const target = mkdtempSync(join(tmpdir(), "northcinder-target-"));
    symlinkSync(target, join(xdg, "thenagain"));
    expect(() => resolveConfigDir({ XDG_CONFIG_HOME: xdg })).toThrow(/symlink/i);
  });

  it("defaults to canonical XDG/HOME paths and preserves discoverable OS-home Brier state", () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: "/tmp/xdg", HOME: "/tmp/home" })).toBe(join("/tmp/xdg", "northcinder"));
    expect(resolveConfigDir({ HOME: "/tmp/home" })).toBe(join("/tmp/home", ".config", "northcinder"));
    const osLegacy = join(homedir(), ".config", "brier");
    expect(resolveConfigDir({})).toBe(existsSync(osLegacy) ? osLegacy : join(homedir(), ".config", "northcinder"));
  });
});
