/**
 * Append-only local audit log (spec §2 "user-auditable", §4.5): every search,
 * ranking (with its machine-readable reasons), mandate issuance/approval, and
 * checkout attempt lands here as one JSONL line in the user's config dir.
 * This file is what makes "neutral" PROVABLE to the user — so writes fail
 * CLOSED: if the trail cannot be written, the operation that needed auditing
 * reports an error instead of proceeding un-audited.
 *
 * The log is never truncated or rewritten by this module; `append` is the
 * only operation.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { forEachLineFromEnd } from "./bounded-tail-reader.js";
import { runFsOp } from "./fs-error-sanitizer.js";

export const AUDIT_LOG_FILENAME = "audit.jsonl";

export interface AuditEvent extends Record<string, unknown> {
  /** e.g. "search" | "trust" | "authorization_requested" | "authorization_approved"
   *  | "authorization_denied" | "checkout_attempt" | "checkout_result" */
  type: string;
}

export interface AuditLog {
  readonly path: string;
  /** Appends one JSONL line ({at: ISO timestamp, ...event}). Throws on I/O failure. */
  append(event: AuditEvent): void;
}

/** One page of the audit trail (local UI dashboard browser — read side only). */
export interface AuditPage {
  /** Entries NEWEST FIRST. An unparsable line surfaces as { raw } — never hidden. */
  entries: Array<Record<string, unknown>>;
  page: number;
  pageSize: number;
  totalEntries: number;
  totalPages: number;
}

export const AUDIT_PAGE_SIZE_DEFAULT = 50;

/**
 * Paged, read-only view over the append-only JSONL trail, newest first
 * (page 1 = the most recent events). Purely a READER: it never writes,
 * truncates, or rewrites — the log's only mutation stays `append`.
 *
 * BOUNDED reader (local UI follow-up fix): this never does
 * `readFileSync(path).split("\n")` — that loads the ENTIRE log into one
 * string and one array before paginating, and the log only grows (one line
 * per search/auth event, forever). Instead it walks the file BACKWARD in
 * fixed-size chunks via `forEachLineFromEnd`, so memory stays bounded to
 * ~one chunk regardless of log size — a first pass counts total non-blank
 * lines (needed for totalPages), a second stops early once it has collected
 * this page's window.
 */
export function readAuditPage(
  path: string,
  opts: { page?: number; pageSize?: number; chunkSize?: number } = {},
): AuditPage {
  const pageSize = Math.max(1, opts.pageSize ?? AUDIT_PAGE_SIZE_DEFAULT);

  let totalEntries = 0;
  forEachLineFromEnd(
    path,
    (line) => {
      if (line.trim().length > 0) totalEntries += 1;
    },
    opts.chunkSize,
  );

  const totalPages = Math.max(1, Math.ceil(totalEntries / pageSize));
  const page = Math.min(Math.max(1, opts.page ?? 1), totalPages);
  // Newest first: page 1 starts at the END of the file. `offset`/`windowEnd`
  // are ranks counted from EOF (rank 0 = newest non-blank line).
  const offset = (page - 1) * pageSize;
  const windowEnd = page * pageSize;

  const rawLines: string[] = [];
  let rank = 0;
  forEachLineFromEnd(
    path,
    (line) => {
      if (line.trim().length === 0) return; // blank lines: skipped, never counted/rendered
      if (rank >= windowEnd) return false; // past this page's window — stop reading further back
      if (rank >= offset) rawLines.push(line);
      rank += 1;
    },
    opts.chunkSize,
  );

  const entries = rawLines.map((line) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { raw: line };
    } catch {
      return { raw: line };
    }
  });
  return { entries, page, pageSize, totalEntries, totalPages };
}

export function createAuditLog(configDir: string, now: () => Date = () => new Date()): AuditLog {
  const path = join(configDir, AUDIT_LOG_FILENAME);
  return {
    path,
    append(event) {
      // Fail CLOSED (the caller must still see an error and abort the
      // un-audited operation) but never let the underlying fs error — which
      // typically embeds the absolute configDir/log path — reach a
      // tool-facing error string; shared across all fs call sites
      // reachable from tool handlers, see fs-error-sanitizer.ts).
      runFsOp(() => {
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
        const line = JSON.stringify({ at: now().toISOString(), ...event });
        const existed = existsSync(path);
        appendFileSync(path, `${line}\n`, { mode: 0o600 });
        // appendFileSync's mode is umask-filtered on creation; enforce 0600.
        if (!existed) chmodSync(path, 0o600);
      }, "audit log append failed: the audit trail could not be written");
    },
  };
}
