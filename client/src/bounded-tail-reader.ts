/**
 * Bounded (memory-wise) reverse line reader shared by the audit log and order
 * store dashboard readers (local UI follow-up fix).
 *
 * The bug this replaces: `readFileSync(path, "utf8").split("\n")` loads the
 * ENTIRE file into one string and one array before any pagination/limit is
 * applied — for an append-only log that grows one line per search/auth/order
 * event forever, that array's size is unbounded and only grows. This module
 * instead opens the file with a raw fd and walks it BACKWARD (from EOF toward
 * BOF) in fixed-size chunks, so at most one chunk buffer plus one small
 * "carry" buffer (a line fragment straddling a chunk boundary) are held at
 * any time — never the whole file as one buffer/array.
 *
 * The carry is held as RAW BYTES (a Buffer), never a decoded string: a
 * multibyte UTF-8 codepoint (accented merchant names, CJK, emoji) can straddle
 * a chunk boundary, and decoding each chunk independently would split that
 * codepoint into two U+FFFD replacement chars. We split on the newline BYTE
 * (0x0A — which can never appear inside a UTF-8 multibyte sequence, whose
 * bytes are all >= 0x80) and only ever call toString on a COMPLETE line's
 * bytes, so no decode ever straddles a codepoint.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

export const DEFAULT_TAIL_CHUNK_SIZE = 64 * 1024;

/**
 * Reads `path` BACKWARD in fixed-size chunks, invoking `onLine` once per
 * line — newest (closest to EOF) first — until `onLine` returns `false` or
 * the beginning of the file is reached (whichever comes first). A trailing
 * blank line (from the file's final "\n") IS delivered like any other line;
 * callers filter blank lines themselves, matching the historical
 * `.split("\n").filter(l => l.trim().length > 0)` behavior.
 *
 * A missing file is treated as empty (no lines), never an error.
 */
export function forEachLineFromEnd(
  path: string,
  onLine: (line: string) => boolean | void,
  chunkSize: number = DEFAULT_TAIL_CHUNK_SIZE,
): void {
  if (!existsSync(path)) return;
  const NEWLINE = 0x0a;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return;
    let position = size;
    let carry = Buffer.alloc(0); // raw bytes of a line fragment starting this chunk, completed by the NEXT (further-back) chunk
    const buf = Buffer.alloc(Math.max(1, chunkSize));
    while (position > 0) {
      const readSize = Math.min(buf.length, position);
      position -= readSize;
      const bytesRead = readSync(fd, buf, 0, readSize, position);
      // combined = [this chunk's bytes][carry bytes] — order-preserving, so
      // the last newline in the file's byte order stays last here too.
      const combined = Buffer.concat([buf.subarray(0, bytesRead), carry]);
      // Split on the newline BYTE (never part of a multibyte sequence).
      const segments: Buffer[] = [];
      let segStart = 0;
      for (let i = 0; i < combined.length; i += 1) {
        if (combined[i] === NEWLINE) {
          segments.push(combined.subarray(segStart, i));
          segStart = i + 1;
        }
      }
      segments.push(combined.subarray(segStart)); // trailing segment (may be empty)
      // At BOF (position === 0), segments[0] is a real, complete first line —
      // nothing precedes it. Otherwise it's a fragment continued by the chunk
      // we're about to read (further back), so carry its RAW BYTES onward and
      // never decode them in isolation.
      const startIndex = position > 0 ? 1 : 0;
      if (position > 0) carry = Buffer.from(segments[0]!); // copy: subarray aliases `buf`, reused next read
      for (let i = segments.length - 1; i >= startIndex; i -= 1) {
        const cont = onLine(segments[i]!.toString("utf8"));
        if (cont === false) return;
      }
    }
  } finally {
    closeSync(fd);
  }
}
