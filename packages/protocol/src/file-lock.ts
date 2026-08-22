import { randomUUID } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

interface LockOwner {
  pid: number;
  acquiredAt: string;
  processStart?: string;
}

interface LockRecoveryClaim extends LockOwner {
  owner: LockOwner;
}

export interface ExclusiveFileLockDescription {
  /** Human-readable, path-free error prefix (for example, "northcinder orders"). */
  errorPrefix: string;
  /** Human-readable protected resource (for example, "order graph"). */
  resource: string;
}

function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockOwner>;
    return typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 && typeof parsed.acquiredAt === "string" &&
        (parsed.processStart === undefined || typeof parsed.processStart === "string")
      ? { pid: parsed.pid, acquiredAt: parsed.acquiredAt, ...(typeof parsed.processStart === "string" ? { processStart: parsed.processStart } : {}) }
      : undefined;
  } catch {
    return undefined;
  }
}

function processStartIdentity(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fieldsAfterCommand = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const start = fieldsAfterCommand[19];
    return start !== undefined && /^\d+$/.test(start) ? start : undefined;
  } catch {
    return undefined;
  }
}

function ownerLiveness(owner: LockOwner): "alive" | "dead" | "unverified" {
  try {
    process.kill(owner.pid, 0);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "dead" : "unverified";
  }
  const currentStart = processStartIdentity(owner.pid);
  if (owner.processStart !== undefined && currentStart !== undefined) return owner.processStart === currentStart ? "alive" : "dead";
  return "unverified";
}

function sameLockOwner(left: LockOwner, right: LockOwner | undefined): boolean {
  return right !== undefined && left.pid === right.pid && left.acquiredAt === right.acquiredAt && left.processStart === right.processStart;
}

function readRecoveryClaim(recoveryPath: string): LockRecoveryClaim | undefined {
  try {
    const parsed = JSON.parse(readFileSync(recoveryPath, "utf8")) as Partial<LockRecoveryClaim>;
    return typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 && typeof parsed.acquiredAt === "string" &&
        (parsed.processStart === undefined || typeof parsed.processStart === "string") &&
        typeof parsed.owner?.pid === "number" && Number.isSafeInteger(parsed.owner.pid) && parsed.owner.pid > 0 &&
        typeof parsed.owner.acquiredAt === "string" && (parsed.owner.processStart === undefined || typeof parsed.owner.processStart === "string")
      ? {
          pid: parsed.pid,
          acquiredAt: parsed.acquiredAt,
          ...(typeof parsed.processStart === "string" ? { processStart: parsed.processStart } : {}),
          owner: {
            pid: parsed.owner.pid,
            acquiredAt: parsed.owner.acquiredAt,
            ...(typeof parsed.owner.processStart === "string" ? { processStart: parsed.owner.processStart } : {}),
          },
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Publishes a complete owner record atomically; candidates left before the link are never visible as locks. */
function publishExclusiveRecord(path: string, record: LockOwner | LockRecoveryClaim, description: ExclusiveFileLockDescription): boolean {
  const candidatePath = `${path}.candidate.${randomUUID()}`;
  let candidateFd: number | undefined;
  try {
    candidateFd = openSync(candidatePath, "wx", 0o600);
    writeSync(candidateFd, `${JSON.stringify(record)}\n`);
    closeSync(candidateFd);
    candidateFd = undefined;
    try {
      linkSync(candidatePath, path);
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw cause;
    }
  } catch {
    throw new Error(`${description.errorPrefix}: ${description.resource} write lock is unavailable`);
  } finally {
    if (candidateFd !== undefined) {
      try {
        closeSync(candidateFd);
      } catch {
        // The generic error above keeps local paths out of tool output.
      }
    }
    try {
      unlinkSync(candidatePath);
    } catch {
      // Unpublished candidate leftovers are harmless; a later acquisition ignores them.
    }
  }
}

/** Claims recovery before unlinking a dead owner's lock, so two reclaimers cannot delete a newly acquired live lock. */
function reclaimDeadLock(lockPath: string, owner: LockOwner, description: ExclusiveFileLockDescription): boolean {
  const recoveryPath = `${lockPath}.recovery`;
  const recoveryProcessStart = processStartIdentity(process.pid);
  const recoveryOwner: LockOwner = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    ...(recoveryProcessStart !== undefined ? { processStart: recoveryProcessStart } : {}),
  };
  if (!publishExclusiveRecord(recoveryPath, { ...recoveryOwner, owner }, description)) {
    const claim = readRecoveryClaim(recoveryPath);
    if (!claim || !sameLockOwner(owner, claim.owner)) {
      throw new Error(`${description.errorPrefix}: ${description.resource} lock recovery ownership cannot be verified; confirm no NorthCinder process owns it before removing the stale lock`);
    }
    const reclaimerLiveness = ownerLiveness(claim);
    if (reclaimerLiveness === "alive") {
      throw new Error(`${description.errorPrefix}: ${description.resource} lock recovery is in progress; wait or retry after it finishes`);
    }
    if (reclaimerLiveness === "unverified") {
      throw new Error(`${description.errorPrefix}: ${description.resource} lock recovery ownership cannot be verified; confirm no NorthCinder process owns it before removing the stale lock`);
    }
    try {
      unlinkSync(recoveryPath);
    } catch {
      throw new Error(`${description.errorPrefix}: stale ${description.resource} lock could not be reclaimed; retry after confirming no NorthCinder process owns it`);
    }
    return false;
  }

  try {
    const currentOwner = readLockOwner(lockPath);
    if (!sameLockOwner(owner, currentOwner) || ownerLiveness(owner) !== "dead") return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    throw new Error(`${description.errorPrefix}: stale ${description.resource} lock could not be reclaimed; retry after confirming no NorthCinder process owns it`);
  } finally {
    try {
      unlinkSync(recoveryPath);
    } catch {
      // The canonical lock remains unless this recovery won.
    }
  }
}

function acquireLock(lockPath: string, description: ExclusiveFileLockDescription): number {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const currentProcessStart = processStartIdentity(process.pid);
    const owner: LockOwner = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      ...(currentProcessStart !== undefined ? { processStart: currentProcessStart } : {}),
    };
    if (publishExclusiveRecord(lockPath, owner, description)) {
      try {
        return openSync(lockPath, "r");
      } catch {
        throw new Error(`${description.errorPrefix}: ${description.resource} write lock is unavailable`);
      }
    }

    const existingOwner = readLockOwner(lockPath);
    if (!existingOwner) {
      throw new Error(`${description.errorPrefix}: ${description.resource} lock ownership cannot be verified; stop any active NorthCinder process, then remove the stale lock before retrying`);
    }
    const liveness = ownerLiveness(existingOwner);
    if (liveness === "alive") {
      throw new Error(`${description.errorPrefix}: another process holds the ${description.resource} lock; wait or retry after it finishes`);
    }
    if (liveness === "unverified") {
      throw new Error(`${description.errorPrefix}: ${description.resource} lock ownership cannot be verified; confirm no NorthCinder process owns it before removing the stale lock`);
    }
    reclaimDeadLock(lockPath, existingOwner, description);
  }
  throw new Error(`${description.errorPrefix}: stale ${description.resource} lock could not be reclaimed; retry after confirming no NorthCinder process owns it`);
}

/**
 * Runs one read-modify-write transaction under a non-blocking, cross-process
 * lock. Atomic rename protects bytes; this lock protects the whole transaction.
 */
export function withExclusiveFileLock<T>(
  lockPath: string,
  description: ExclusiveFileLockDescription,
  operation: () => T,
): T {
  const lockFd = acquireLock(lockPath, description);
  try {
    return operation();
  } finally {
    let releaseFailed = false;
    try {
      closeSync(lockFd);
    } catch {
      releaseFailed = true;
    }
    try {
      unlinkSync(lockPath);
    } catch {
      releaseFailed = true;
    }
    if (releaseFailed) {
      throw new Error(`${description.errorPrefix}: ${description.resource} write lock could not be released`);
    }
  }
}
