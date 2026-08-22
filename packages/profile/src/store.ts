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
  BrandPreferenceProposalInputSchema,
  BrandPreferenceProposalSchema,
  ProfileEntrySchema,
  withExclusiveFileLock,
  type BrandPreferenceProposal,
  type BrandPreferenceProposalInput,
  type ProfileEntry,
  type ProfileEntryInput,
  type ProfileOrigin,
} from "@northcinder/protocol";

export const PROFILE_FILENAME = "profile.json";

const ProfileFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(ProfileEntrySchema),
  proposals: z.array(BrandPreferenceProposalSchema).default([]),
});

type ProfileFile = z.infer<typeof ProfileFileSchema>;

/** Attribution metadata of a removed entry — deliberately NOT the value. */
export interface RemovedEntryMeta {
  id: string;
  kind: ProfileEntry["kind"];
  origin: ProfileOrigin;
}

export type RemoveOutcome = { removed: true; entry: RemovedEntryMeta } | { removed: false };

export type BrandProposalRecordOutcome =
  | { kind: "pending"; proposal: BrandPreferenceProposal }
  | { kind: "promoted"; entry: ProfileEntry }
  | { kind: "resolved"; entry: ProfileEntry };

export type ConfirmProposalOutcome =
  | { kind: "confirmed"; entry: ProfileEntry }
  | { kind: "resolved"; entry: ProfileEntry }
  | { kind: "missing" };

export type DismissProposalOutcome = { dismissed: true } | { dismissed: false };

export interface ProfileStore {
  readonly path: string;
  /** All entries, freshly read from disk. Throws on a corrupt file (fail closed). */
  list(): ProfileEntry[];
  /**
   * Persists a new entry. The store assigns id/createdAt and stamps the
   * caller-declared origin + source — attribution is mandatory, never defaulted.
   */
  add(input: ProfileEntryInput, attribution: { origin: ProfileOrigin; source: string }): ProfileEntry;
  /** Pending, confirmation-gated brand preference proposals. */
  listProposals(): BrandPreferenceProposal[];
  recordBrandProposal(input: BrandPreferenceProposalInput): BrandProposalRecordOutcome;
  confirmProposal(id: string): ConfirmProposalOutcome;
  dismissProposal(id: string): DismissProposalOutcome;
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

  function loadProfile(): ProfileFile {
    if (!existsSync(path)) return { version: 1, entries: [], proposals: [] };
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
    return parsed.data;
  }

  function load(): ProfileEntry[] {
    return loadProfile().entries;
  }

  function persist(profile: ProfileFile): void {
    mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash mid-write can never leave a truncated profile.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600); // writeFileSync's mode is umask-filtered; enforce 0600
    renameSync(tmp, path);
  }

  function mutateProfile<T>(mutation: (profile: ProfileFile) => T): T {
    mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
    return withExclusiveFileLock(`${path}.lock`, { errorPrefix: "northcinder", resource: "profile" }, () => {
      const profile = loadProfile();
      const result = mutation(profile);
      persist(profile);
      return result;
    });
  }

  function createEntry(input: ProfileEntryInput, attribution: { origin: ProfileOrigin; source: string }): ProfileEntry {
    return ProfileEntrySchema.parse({
      ...input,
      id: `pref_${randomUUID()}`,
      origin: attribution.origin,
      source: attribution.source,
      createdAt: now().toISOString(),
    });
  }

  function sameScope(a: ProfileEntry["scope"], b: BrandPreferenceProposal["scope"]): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function normalizedBrand(brand: string): string {
    return brand.trim().toLocaleLowerCase();
  }

  function matchingBrandEntry(profile: ProfileFile, proposal: Pick<BrandPreferenceProposal, "brand" | "stance" | "scope">): ProfileEntry | undefined {
    return profile.entries.find(
      (entry) =>
        entry.kind === "brand" &&
        normalizedBrand(entry.brand) === normalizedBrand(proposal.brand) &&
        entry.stance === proposal.stance &&
        sameScope(entry.scope, proposal.scope),
    );
  }

  return {
    path,
    list: load,
    add(input, attribution) {
      return mutateProfile((profile) => {
        const entry = createEntry(input, attribution);
        profile.entries.push(entry);
        return entry;
      });
    },
    remove(id) {
      return mutateProfile((profile): RemoveOutcome => {
        const index = profile.entries.findIndex((e) => e.id === id);
        if (index === -1) return { removed: false };
        const [removed] = profile.entries.splice(index, 1);
        return { removed: true, entry: { id: removed!.id, kind: removed!.kind, origin: removed!.origin } };
      });
    },
    listProposals() {
      return loadProfile().proposals;
    },
    recordBrandProposal(rawInput) {
      const input = BrandPreferenceProposalInputSchema.parse(rawInput);
      return mutateProfile((profile): BrandProposalRecordOutcome => {
        const index = profile.proposals.findIndex(
          (proposal) =>
            normalizedBrand(proposal.brand) === normalizedBrand(input.brand) &&
            proposal.stance === input.stance &&
            proposal.reason === input.reason &&
            sameScope(proposal.scope, input.scope),
        );
        if (index === -1) {
          const timestamp = now().toISOString();
          const proposal = BrandPreferenceProposalSchema.parse({
            id: `proposal_${randomUUID()}`,
            kind: "brand",
            brand: input.brand,
            stance: input.stance,
            reason: input.reason,
            ...(input.scope === undefined ? {} : { scope: input.scope }),
            evidenceKeys: [input.evidenceKey],
            source: input.source,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          profile.proposals.push(proposal);
          return { kind: "pending", proposal };
        }

        const proposal = profile.proposals[index]!;
        if (proposal.evidenceKeys.includes(input.evidenceKey)) return { kind: "pending", proposal };
        const existing = matchingBrandEntry(profile, proposal);
        profile.proposals.splice(index, 1);
        if (existing !== undefined) return { kind: "resolved", entry: existing };
        const entry = createEntry(
          { kind: "brand", brand: proposal.brand, stance: proposal.stance, ...(proposal.scope === undefined ? {} : { scope: proposal.scope }) },
          { origin: "inferred", source: proposal.source },
        );
        profile.entries.push(entry);
        return { kind: "promoted", entry };
      });
    },
    confirmProposal(id) {
      return mutateProfile((profile): ConfirmProposalOutcome => {
        const index = profile.proposals.findIndex((proposal) => proposal.id === id);
        if (index === -1) return { kind: "missing" };
        const [proposal] = profile.proposals.splice(index, 1);
        const existing = matchingBrandEntry(profile, proposal!);
        if (existing !== undefined) return { kind: "resolved", entry: existing };
        const entry = createEntry(
          { kind: "brand", brand: proposal!.brand, stance: proposal!.stance, ...(proposal!.scope === undefined ? {} : { scope: proposal!.scope }) },
          { origin: "stated", source: proposal!.source },
        );
        profile.entries.push(entry);
        return { kind: "confirmed", entry };
      });
    },
    dismissProposal(id) {
      return mutateProfile((profile): DismissProposalOutcome => {
        const index = profile.proposals.findIndex((proposal) => proposal.id === id);
        if (index === -1) return { dismissed: false };
        profile.proposals.splice(index, 1);
        return { dismissed: true };
      });
    },
  };
}
