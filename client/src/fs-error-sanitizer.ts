/**
 * Shared filesystem-error sanitization: Node's raw filesystem
 * errors (EACCES/ENOENT/disk-full/…) embed the absolute path that was being
 * read/written — e.g. `.../<home>/.northcinder/pending-authorizations/x.code`.
 * Any call site reachable from an MCP tool handler must never let that raw
 * message reach the tool-facing error text, or it leaks the user's
 * home/config directory layout to the calling agent.
 *
 * `runFsOp` wraps a filesystem operation, and on failure throws a generic
 * Error naming NO path — while still failing CLOSED (the caller sees an
 * error and the un-audited/unwritten operation aborts). The original error
 * is deliberately not copied to stderr: the buyer's MCP application may
 * capture child-process stderr, so path-bearing diagnostics are not an
 * out-of-band secret channel. The buyer can reproduce the failure against
 * their own local state.
 */
export function runFsOp<T>(op: () => T, failureMessage: string): T {
  try {
    return op();
  } catch {
    process.stderr.write("[northcinder] filesystem operation failed; buyer-local state was not changed\n");
    throw new Error(failureMessage);
  }
}
