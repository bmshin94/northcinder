import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAuditLog, readAuditPage } from "../src/audit-log.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "northcinder-audit-"));
}

describe("audit log — append-only JSONL neutrality trail (spec §2, §4.5)", () => {
  it("appends one parseable JSONL line per event, with type and an ISO timestamp", () => {
    const dir = tempDir();
    const audit = createAuditLog(dir);
    audit.append({ type: "search", queryText: "wool shoes", resultCount: 7 });
    audit.append({ type: "authorization_requested", authorizationId: "auth_1", offerId: "o1" });

    const lines = readFileSync(audit.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(first.type).toBe("search");
    expect(first.queryText).toBe("wool shoes");
    expect(first.resultCount).toBe(7);
    expect(typeof first.at).toBe("string");
    expect(new Date(first.at as string).toISOString()).toBe(first.at);
    expect(second.type).toBe("authorization_requested");
    expect(second.authorizationId).toBe("auth_1");
  });

  it("NEVER truncates: appends after pre-existing content, preserving it byte-for-byte", () => {
    const dir = tempDir();
    const path = join(dir, "audit.jsonl");
    const preexisting = `{"type":"search","at":"2026-07-01T00:00:00.000Z","queryText":"old entry"}\n`;
    writeFileSync(path, preexisting);

    const audit = createAuditLog(dir);
    audit.append({ type: "trust", merchantId: "m1" });

    const content = readFileSync(path, "utf8");
    expect(content.startsWith(preexisting)).toBe(true);
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1]!) as { merchantId: string }).merchantId).toBe("m1");
  });

  it("creates the file with owner-only permissions (0600)", () => {
    const dir = tempDir();
    const audit = createAuditLog(dir);
    audit.append({ type: "search", queryText: "x" });
    const mode = statSync(audit.path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("throws (fails closed) when the log cannot be written", () => {
    const audit = createAuditLog("/nonexistent-root-dir-northcinder/nope\0bad");
    expect(() => audit.append({ type: "search" })).toThrow();
  });

  it("sanitizes a write failure: the thrown error names no filesystem path", () => {
    const configDir = "/nonexistent-root-dir-northcinder/nope\0bad";
    const audit = createAuditLog(configDir);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      audit.append({ type: "search" });
      expect.unreachable("expected append to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(configDir);
      expect(message).not.toContain("nonexistent-root-dir-northcinder");
      expect(message.toLowerCase()).not.toMatch(/[a-z]:\\|\/[a-z0-9_.-]+\/[a-z0-9_.-]+/i);
      expect(stderr.mock.calls.flat().join(" ")).not.toContain(configDir);
      expect(stderr.mock.calls.flat().join(" ")).not.toContain("nonexistent-root-dir-northcinder");
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("readAuditPage — the local UI dashboard's read-only paged view", () => {
  it("pages newest-first: page 1 holds the LAST events written, in reverse write order", () => {
    const dir = tempDir();
    const audit = createAuditLog(dir);
    for (let i = 1; i <= 5; i += 1) audit.append({ type: "search", seq: i });

    const page1 = readAuditPage(audit.path, { page: 1, pageSize: 2 });
    expect(page1.entries.map((e) => e.seq)).toEqual([5, 4]);
    expect(page1.totalEntries).toBe(5);
    expect(page1.totalPages).toBe(3);

    const page3 = readAuditPage(audit.path, { page: 3, pageSize: 2 });
    expect(page3.entries.map((e) => e.seq)).toEqual([1]);
  });

  it("an out-of-range page clamps to the last page; a missing file is an empty page, not an error", () => {
    const dir = tempDir();
    const audit = createAuditLog(dir);
    audit.append({ type: "search", seq: 1 });
    const clamped = readAuditPage(audit.path, { page: 99, pageSize: 10 });
    expect(clamped.page).toBe(1);
    expect(clamped.entries.map((e) => e.seq)).toEqual([1]);

    const missing = readAuditPage(join(dir, "no-such.jsonl"));
    expect(missing.entries).toEqual([]);
    expect(missing.totalEntries).toBe(0);
    expect(missing.totalPages).toBe(1);
  });

  it("surfaces an unparsable line as { raw } — never hides it — and NEVER rewrites the file", () => {
    const dir = tempDir();
    const path = join(dir, "audit.jsonl");
    writeFileSync(path, `{"type":"search","at":"2026-07-01T00:00:00.000Z"}\nnot-json-garbage\n`);
    const before = readFileSync(path, "utf8");
    const page = readAuditPage(path, { page: 1, pageSize: 10 });
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]).toEqual({ raw: "not-json-garbage" });
    expect(page.entries[1]!.type).toBe("search");
    // Read-only: the file is byte-for-byte untouched.
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("is a BOUNDED (chunked) tail reader: newest N are returned correctly across a backward chunk boundary — never a whole-file readFileSync+split", () => {
    const dir = tempDir();
    const path = join(dir, "audit.jsonl");
    // Many small lines, forced through a tiny chunkSize so pagination requires
    // multiple backward chunk reads (a single readFileSync+split would not
    // exercise this boundary-crossing path at all).
    const total = 500;
    const content = Array.from({ length: total }, (_, i) => JSON.stringify({ type: "search", seq: i + 1 })).join("\n") + "\n";
    writeFileSync(path, content);

    const page1 = readAuditPage(path, { page: 1, pageSize: 10, chunkSize: 37 });
    expect(page1.totalEntries).toBe(total);
    expect(page1.entries.map((e) => e.seq)).toEqual([500, 499, 498, 497, 496, 495, 494, 493, 492, 491]);

    // A page whose window straddles a chunk boundary somewhere in the middle
    // of the file must still come back exactly right.
    const page20 = readAuditPage(path, { page: 20, pageSize: 10, chunkSize: 37 });
    expect(page20.entries.map((e) => e.seq)).toEqual([310, 309, 308, 307, 306, 305, 304, 303, 302, 301]);
  });

  it("decodes multibyte UTF-8 intact when a codepoint straddles a backward chunk boundary — no U+FFFD garble", () => {
    const dir = tempDir();
    const path = join(dir, "audit.jsonl");
    // Accented merchant/product names, CJK, and an emoji — completely normal
    // data. Written as many lines so a tiny chunkSize forces a multibyte
    // character to land across a backward chunk boundary.
    const total = 300;
    const content =
      Array.from({ length: total }, (_, i) =>
        JSON.stringify({ type: "search", seq: i + 1, merchant: "Café Münchën 日本 🛒", note: "naïve résumé" }),
      ).join("\n") + "\n";
    writeFileSync(path, content);

    for (const chunkSize of [17, 31, 64]) {
      const page = readAuditPage(path, { page: 1, pageSize: total, chunkSize });
      expect(page.totalEntries).toBe(total);
      // Every rendered entry must round-trip byte-exact — no replacement chars,
      // and no line silently mis-parsed into { raw }.
      for (const e of page.entries) {
        expect(e.merchant, `chunkSize ${chunkSize}`).toBe("Café Münchën 日本 🛒");
        expect(e.note).toBe("naïve résumé");
      }
      expect(JSON.stringify(page.entries).includes("�"), `chunkSize ${chunkSize} produced U+FFFD`).toBe(false);
    }
  });

  it("surfaces a corrupt line even when it sits deep in the newest-first tail window, across chunk boundaries", () => {
    const dir = tempDir();
    const path = join(dir, "audit.jsonl");
    const before500 = Array.from({ length: 500 }, (_, i) => JSON.stringify({ type: "search", seq: i + 1 }));
    const lines = [...before500, "not-json-garbage", JSON.stringify({ type: "search", seq: 502 })];
    writeFileSync(path, lines.join("\n") + "\n");

    const page = readAuditPage(path, { page: 1, pageSize: 3, chunkSize: 41 });
    expect(page.totalEntries).toBe(502);
    expect(page.entries[0]!.seq).toBe(502);
    expect(page.entries[1]).toEqual({ raw: "not-json-garbage" });
    expect(page.entries[2]!.seq).toBe(500);
  });
});
