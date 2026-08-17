/**
 * Local ingest: every `*.eml` file in a watched drop directory. Dedupe is
 * handled inside `OrderGraphStore.ingestEml` (by Message-ID), so re-scanning
 * the same directory on every poll is safe and idempotent — a file left in
 * place after processing is simply seen again and skipped as a duplicate.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { IngestOutcome, OrderGraphStore } from "../store.js";

export interface DropDirIngestSummary {
  scanned: number;
  outcomes: IngestOutcome[];
}

/** Scans `dir` for `.eml` files and ingests each through the store. A missing directory is treated as empty. */
export function ingestDropDir(dir: string, store: OrderGraphStore): DropDirIngestSummary {
  if (!existsSync(dir)) return { scanned: 0, outcomes: [] };
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".eml"));
  const outcomes: IngestOutcome[] = [];
  for (const file of files) {
    const raw = readFileSync(join(dir, file), "utf8");
    outcomes.push(store.ingestEml(raw, "drop_dir"));
  }
  return { scanned: files.length, outcomes };
}
