/**
 * Curated trust seed loader (spec §5.2 "Curation"). The local-deployer-editable
 * allow/deny/platform lists move OUT of code into a versioned data file
 * (`service/trust-seed.json`, env-pathable via `NORTHCINDER_TRUST_SEED_PATH`) so
 * curation is a data edit, not a code change. Loaded + validated at boot; a
 * missing path falls back to the built-in `DEFAULT_TRUST_SEED`, and an
 * INVALID file fails closed (throws) — a malformed curation list must never
 * silently boot an unseeded service.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { DEFAULT_TRUST_SEED, type TrustSeed } from "./seed-trust.js";

const TrustSeedEntrySchema = z.object({
  domain: z.string().min(1),
  detail: z.string().min(1),
});

export const TrustSeedSchema = z.object({
  allow: z.array(TrustSeedEntrySchema),
  deny: z.array(TrustSeedEntrySchema),
  knownPlatformDomains: z.array(TrustSeedEntrySchema),
});

/**
 * Resolve the seed. Precedence:
 *  1. explicit `path` (or `NORTHCINDER_TRUST_SEED_PATH`) when the file exists → parsed+validated.
 *  2. otherwise `DEFAULT_TRUST_SEED` (built-in).
 * A file that exists but fails validation THROWS (fail closed).
 */
export function loadTrustSeed(path?: string): TrustSeed {
  const resolved = path ?? process.env["NORTHCINDER_TRUST_SEED_PATH"];
  if (!resolved) return DEFAULT_TRUST_SEED;
  if (!existsSync(resolved)) {
    console.warn("[northcinder-trust] configured trust seed does not exist — using DEFAULT_TRUST_SEED");
    return DEFAULT_TRUST_SEED;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8"));
  } catch {
    throw new Error("northcinder trust seed is not valid JSON — refusing to boot with a malformed curation list");
  }
  const parsed = TrustSeedSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `northcinder trust seed does not match the seed schema (${parsed.error.issues[0]?.message ?? "invalid"}) — refusing to boot`,
    );
  }
  return parsed.data;
}
