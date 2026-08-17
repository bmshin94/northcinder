/**
 * Local preference-profile store: one 0600 JSON file in the user's config
 * dir. The profile is USER data (not a secret): the host agent may read it
 * via get_profile, but every write is attributed — the store assigns the
 * `origin`/`source`/`createdAt` trio itself, so a caller can never mint an
 * entry that pretends to be user-stated without saying which interaction
 * relayed it. The local UI dashboard is the user-verifiable editor; this interface
 * is deliberately narrow (list / add / remove) so both surfaces share it.
 *
 * Reads go to disk on EVERY operation: the MCP client and the dashboard are
 * separate processes editing the same file, and stale in-memory copies would
 * silently resurrect deleted entries.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  ProfileEntrySchema,
  type ProfileEntry,
  type ProfileEntryInput,
  type ProfileOrigin,
} from "@northcinder/protocol";

export const PROFILE_FILENAME = "profile.json";

const ProfileFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(ProfileEntrySchema),
});

/** Attribution metadata of a removed entry — deliberately NOT the value. */
export interface RemovedEntryMeta {
  id: string;
  kind: ProfileEntry["kind"];
  origin: ProfileOrigin;
}

export type RemoveOutcome = { removed: true; entry: RemovedEntryMeta } | { removed: false };

export interface ProfileStore {
  readonly path: string;
  /** All entries, freshly read from disk. Throws on a corrupt file (fail closed). */
  list(): ProfileEntry[];
  /**
   * Persists a new entry. The store assigns id/createdAt and stamps the
   * caller-declared origin + source — attribution is mandatory, never defaulted.
   */
  add(input: ProfileEntryInput, attribution: { origin: ProfileOrigin; source: string }): ProfileEntry;
  /**
   * One-call deletion of ANY entry (stated or inferred — inferred entries
   * MUST be this cheap to remove, per the trust hazard in arXiv:2602.01450).
   * Returns attribution metadata only, never the deleted value, so callers
   * can audit the deletion without retaining what was deleted.
   */
  remove(id: string): RemoveOutcome;
}

export interface ProfileStoreOptions {
  configDir: string;
  now?: () => Date;
}

export function createProfileStore(options: ProfileStoreOptions): ProfileStore {
  const now = options.now ?? (() => new Date());
  const path = join(options.configDir, PROFILE_FILENAME);

  function load(): ProfileEntry[] {
    if (!existsSync(path)) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`northcinder profile: ${path} is not valid JSON — refusing to touch it (fix or remove the file)`);
    }
    const parsed = ProfileFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `northcinder profile: ${path} does not match the profile schema (${parsed.error.issues[0]?.message ?? "invalid"}) — refusing to touch it`,
      );
    }
    return parsed.data.entries;
  }

  function persist(entries: ProfileEntry[]): void {
    mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash mid-write can never leave a truncated profile.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600); // writeFileSync's mode is umask-filtered; enforce 0600
    renameSync(tmp, path);
  }

  return {
    path,
    list: load,
    add(input, attribution) {
      const entry = ProfileEntrySchema.parse({
        ...input,
        id: `pref_${randomUUID()}`,
        origin: attribution.origin,
        source: attribution.source,
        createdAt: now().toISOString(),
      });
      const entries = load();
      entries.push(entry);
      persist(entries);
      return entry;
    },
    remove(id) {
      const entries = load();
      const index = entries.findIndex((e) => e.id === id);
      if (index === -1) return { removed: false };
      const [removed] = entries.splice(index, 1);
      persist(entries);
      return { removed: true, entry: { id: removed!.id, kind: removed!.kind, origin: removed!.origin } };
    },
  };
}
