/**
 * Local price-watch store: one 0600 JSON file in the user's config dir
 * (same discipline as the profile store — write-then-rename atomicity,
 * fail-closed reads, disk read on EVERY operation because the MCP client,
 * the northcinder-watch scheduler, and the local UI dashboard are separate processes
 * over the same file).
 *
 * 0600 matters here beyond privacy: an ntfy channel topic is a BEARER
 * SECRET (anyone who knows it can read the user's price notifications).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  WatchSchema,
  WATCH_DEFAULT_TTL_DAYS,
  requiresNativeRevalidation,
  type Money,
  type Watch,
  type WatchChannel,
  type WatchLastStatus,
  type WatchState,
  type WatchTarget,
} from "@northcinder/protocol";
import { BRAND_NAME } from "./brand.js";

export const WATCHES_FILENAME = "watches.json";

const WatchesFileSchema = z.object({
  version: z.literal(1),
  watches: z.array(WatchSchema),
});

export interface CreateWatchInput {
  name: string;
  target: WatchTarget;
  targetPrice: Money;
  mustHaveAttributes?: string[];
  /** Defaults to stderr — always available, no configuration needed. */
  channel?: WatchChannel;
  /** Defaults to createdAt + 183 days (~6 months). */
  expiresAt?: string;
}

export type CancelOutcome =
  | { ok: true; watch: Watch }
  | { ok: false; reason: "not_found" | "not_active" };

/** Scheduler-owned mutable state — the only fields update() may touch. */
export interface WatchUpdatePatch {
  state?: WatchState;
  lastCheckedAt?: string;
  lastPrice?: Money;
  lastStatus?: WatchLastStatus;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  /** null clears elapsed backoff after a healthy check. */
  nextEligibleCheckAt?: string | null;
  notifiedBuckets?: string[];
}

export interface WatchStore {
  readonly path: string;
  /** All watches, freshly read from disk. Throws on a corrupt file (fail closed). */
  list(): Watch[];
  get(id: string): Watch | undefined;
  create(input: CreateWatchInput): Watch;
  /** Voids an ACTIVE watch. Never deletes — the record stays auditable. */
  cancel(id: string): CancelOutcome;
  /** Persists scheduler state (crash-safe resume). Returns the updated watch. */
  update(id: string, patch: WatchUpdatePatch): Watch | undefined;
}

export interface WatchStoreOptions {
  configDir: string;
  now?: () => Date;
}

export function createWatchStore(options: WatchStoreOptions): WatchStore {
  const now = options.now ?? (() => new Date());
  const path = join(options.configDir, WATCHES_FILENAME);

  function load(): Watch[] {
    if (!existsSync(path)) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`${BRAND_NAME} watches: ${path} is not valid JSON — refusing to touch it (fix or remove the file)`);
    }
    const parsed = WatchesFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `${BRAND_NAME} watches: ${path} does not match the watch schema (${parsed.error.issues[0]?.message ?? "invalid"}) — refusing to touch it`,
      );
    }
    return parsed.data.watches;
  }

  function persist(watches: Watch[]): void {
    mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash mid-write can never truncate the watches.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, watches }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600); // writeFileSync's mode is umask-filtered; enforce 0600
    renameSync(tmp, path);
  }

  return {
    path,
    list: load,
    get(id) {
      return load().find((w) => w.id === id);
    },
    create(input) {
      if (input.target.kind === "offer" && requiresNativeRevalidation(input.target.offer)) {
        throw new Error(
          `native_revalidation_required: agent-observed offers cannot be watched until a native store connection revalidates them; open ${input.target.offer.product.url}`,
        );
      }
      const createdAt = now();
      const expiresAt = input.expiresAt ?? new Date(createdAt.getTime() + WATCH_DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
      if (Date.parse(expiresAt) <= createdAt.getTime()) {
        throw new Error(`${BRAND_NAME} watches: expiresAt ${expiresAt} is not after creation time — a watch must have a future expiry`);
      }
      const watch = WatchSchema.parse({
        id: `watch_${randomUUID()}`,
        name: input.name,
        target: input.target,
        targetPrice: input.targetPrice,
        mustHaveAttributes: input.mustHaveAttributes ?? [],
        channel: input.channel ?? { type: "stderr" },
        createdAt: createdAt.toISOString(),
        expiresAt,
        state: "active",
        notifiedBuckets: [],
      });
      const watches = load();
      watches.push(watch);
      persist(watches);
      return watch;
    },
    cancel(id) {
      const watches = load();
      const watch = watches.find((w) => w.id === id);
      if (!watch) return { ok: false, reason: "not_found" };
      if (watch.state !== "active") return { ok: false, reason: "not_active" };
      watch.state = "cancelled";
      persist(watches);
      return { ok: true, watch };
    },
    update(id, patch) {
      const watches = load();
      const watch = watches.find((w) => w.id === id);
      if (!watch) return undefined;
      if (patch.state !== undefined) watch.state = patch.state;
      if (patch.lastCheckedAt !== undefined) watch.lastCheckedAt = patch.lastCheckedAt;
      if (patch.lastPrice !== undefined) watch.lastPrice = patch.lastPrice;
      if (patch.lastStatus !== undefined) watch.lastStatus = patch.lastStatus;
      if (patch.lastSuccessAt !== undefined) watch.lastSuccessAt = patch.lastSuccessAt;
      if (patch.lastFailureAt !== undefined) watch.lastFailureAt = patch.lastFailureAt;
      if (patch.nextEligibleCheckAt === null) delete watch.nextEligibleCheckAt;
      else if (patch.nextEligibleCheckAt !== undefined) watch.nextEligibleCheckAt = patch.nextEligibleCheckAt;
      if (patch.notifiedBuckets !== undefined) watch.notifiedBuckets = patch.notifiedBuckets;
      persist(watches);
      return watch;
    },
  };
}
