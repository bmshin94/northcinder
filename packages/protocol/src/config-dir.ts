/**
 * Shared config-dir resolution. Lives in the protocol package (relocated out
 * of @northcinder/checkout's keystore) so checkout-free surfaces — notably the
 * northcinder-watch scheduler, whose law is "no checkout code path" — can resolve
 * the config dir without importing any checkout code. @northcinder/checkout
 * re-exports it for backward compatibility.
 */
import { homedir } from "node:os";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

let warnedLegacyEnvironment = false;
const LEGACY_ENV_PREFIXES = ["BRIER_", "THENAGAIN_", "EMPTOR_"] as const;

/**
 * Applies the one-window product-env compatibility contract at a process
 * boundary.  This intentionally lives in protocol so client, service, remote
 * and scheduler entrypoints cannot each grow a different alias policy.
 */
export function canonicalizeProductEnv(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = console.warn,
): Record<string, string | undefined> {
  const normalized = { ...env };
  const aliases: string[] = [];
  for (const prefix of LEGACY_ENV_PREFIXES) {
    for (const legacy of Object.keys(env).filter((key) => key.startsWith(prefix))) {
      aliases.push(legacy);
      const canonical = `NORTHCINDER_${legacy.slice(prefix.length)}`;
      if (normalized[canonical] === undefined) normalized[canonical] = env[legacy];
    }
  }
  if (aliases.length && !warnedLegacyEnvironment) {
    warnedLegacyEnvironment = true;
    warn("NorthCinder: BRIER_*, THENAGAIN_*, and EMPTOR_* environment variables are deprecated; use NORTHCINDER_* (values redacted).");
  }
  return normalized;
}

/**
 * Resolve the single local authorization domain without copying state.  A
 * discoverable legacy directory remains authoritative for the compatibility
 * window so an old process and NorthCinder share the same nonce ledger.
 */
export function resolveConfigDir(env: Record<string, string | undefined> = process.env): string {
  const rawEnv = env;
  env = canonicalizeProductEnv(env);
  const canonicalBase = rawEnv.XDG_CONFIG_HOME ?? join(rawEnv.HOME ?? homedir(), ".config");
  const canonical = rawEnv.NORTHCINDER_CONFIG_DIR || join(canonicalBase, "northcinder");
  const validateLegacy = (path: string): string => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`legacy config directory must not be a symlink: ${path}`);
    if (!stat.isDirectory()) throw new Error(`legacy config path is not a directory: ${path}`);
    return realpathSync(path);
  };
  const sameDomain = (left: string, right: string): boolean => {
    const normalizedLeft = existsSync(left) ? realpathSync(left) : resolve(left);
    const normalizedRight = existsSync(right) ? realpathSync(right) : resolve(right);
    return normalizedLeft === normalizedRight;
  };

  const explicitLegacy = [rawEnv.BRIER_CONFIG_DIR, rawEnv.THENAGAIN_CONFIG_DIR, rawEnv.EMPTOR_CONFIG_DIR]
    .filter((path): path is string => path !== undefined);
  const discoveredLegacy = explicitLegacy.length > 0
    ? explicitLegacy
    : [join(canonicalBase, "brier"), join(canonicalBase, "thenagain"), join(canonicalBase, "emptor")].filter(existsSync);
  if (discoveredLegacy.length > 0) {
    const physical = discoveredLegacy.map((path) => existsSync(path) ? validateLegacy(path) : resolve(path));
    const selected = physical[0]!;
    if (physical.some((path) => !sameDomain(selected, path))) {
      throw new Error(`refusing ambiguous legacy state across ${discoveredLegacy.join(", ")}`);
    }
    if (rawEnv.NORTHCINDER_CONFIG_DIR && !sameDomain(selected, rawEnv.NORTHCINDER_CONFIG_DIR)) {
      throw new Error(`refusing to split legacy state at ${discoveredLegacy[0]} from NORTHCINDER_CONFIG_DIR`);
    }
    return selected;
  }
  return canonical;
}
