import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify as edVerify, createPublicKey } from "node:crypto";
import { canonicalMandatePayload, loadOrCreateMandateKeypair, resolveConfigDir, createFileNonceLedger, createInMemoryNonceLedger } from "../src/index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "northcinder-checkout-test-"));
}

describe("mandate keystore", () => {
  it("generates an ed25519 keypair on first run into the config dir with file mode 0600", () => {
    const dir = tmp();
    const kp = loadOrCreateMandateKeypair({ configDir: dir });
    expect(kp.created).toBe(true);
    expect(kp.keyPath).toBe(join(dir, "mandate-key.json"));
    const mode = statSync(kp.keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
    const record = JSON.parse(readFileSync(kp.keyPath, "utf8"));
    expect(record.algorithm).toBe("ed25519");
    expect(record.privateKeyPem).toContain("PRIVATE KEY");
    expect(record.publicKeySpkiB64).toBe(kp.publicKeyB64);
  });

  it("loads the SAME keypair on subsequent runs (no regeneration)", () => {
    const dir = tmp();
    const first = loadOrCreateMandateKeypair({ configDir: dir });
    const second = loadOrCreateMandateKeypair({ configDir: dir });
    expect(second.created).toBe(false);
    expect(second.publicKeyB64).toBe(first.publicKeyB64);
  });

  it("produces signatures that verify against the stored public key", () => {
    const kp = loadOrCreateMandateKeypair({ configDir: tmp() });
    const payload = canonicalMandatePayload({
      version: 2,
      id: "m1",
      intent: "buy",
      offerId: "o1",
      merchantId: "shop.example",
      offerDigest: "a".repeat(64),
      quantity: 1,
      maxAmountMinor: 100,
      currency: "USD",
      issuedAt: "2026-07-04T00:00:00.000Z",
      expiresAt: "2026-07-04T00:15:00.000Z",
      nonce: "abcdefghijklmnop",
    });
    const sig = Buffer.from(kp.sign(payload), "base64");
    const pub = createPublicKey({ key: Buffer.from(kp.publicKeyB64, "base64"), format: "der", type: "spki" });
    expect(edVerify(null, Buffer.from(payload), pub, sig)).toBe(true);
  });

  it("resolveConfigDir honors NORTHCINDER_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config/northcinder", () => {
    expect(resolveConfigDir({ NORTHCINDER_CONFIG_DIR: "/x/northcinder", HOME: "/home/u" })).toBe("/x/northcinder");
    expect(resolveConfigDir({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" })).toBe(join("/xdg", "northcinder"));
    expect(resolveConfigDir({ HOME: "/home/u" })).toBe(join("/home/u", ".config", "northcinder"));
  });
});

describe("nonce ledger", () => {
  it("in-memory ledger consumes a nonce exactly once", async () => {
    const ledger = createInMemoryNonceLedger();
    expect(await ledger.consume("nonce-aaaaaaaaaaaa", { mandateId: "m1" })).toBe(true);
    expect(await ledger.consume("nonce-aaaaaaaaaaaa", { mandateId: "m1" })).toBe(false);
    expect(await ledger.has("nonce-aaaaaaaaaaaa")).toBe(true);
    expect(await ledger.has("other")).toBe(false);
  });

  it("file ledger persists used nonces across instances (mode 0600)", async () => {
    const path = join(tmp(), "nonces.jsonl");
    const a = createFileNonceLedger(path);
    expect(await a.consume("persistent-nonce-1234", { mandateId: "m9" })).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    const b = createFileNonceLedger(path);
    expect(await b.has("persistent-nonce-1234")).toBe(true);
    expect(await b.consume("persistent-nonce-1234")).toBe(false);
    const line = JSON.parse(readFileSync(path, "utf8").trim().split("\n")[0]!);
    expect(line.nonce).toBe("persistent-nonce-1234");
    expect(line.mandateId).toBe("m9");
    expect(typeof line.usedAt).toBe("string");
  });

  it("file ledger serializes concurrent consumes of the same nonce (only one wins)", async () => {
    const path = join(tmp(), "nonces.jsonl");
    const ledger = createFileNonceLedger(path);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ledger.consume("race-nonce-abcdefgh")),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("CROSS-INSTANCE exclusion: two ledger instances on the same file cannot both consume one nonce", async () => {
    // Two MCP client processes (or two createFileNonceLedger calls) share the
    // config dir: each instance's in-memory view must not grant a replay.
    const path = join(tmp(), "nonces.jsonl");
    const a = createFileNonceLedger(path);
    const b = createFileNonceLedger(path); // constructed BEFORE a consumes — stale in-memory view
    const results = await Promise.all([
      a.consume("shared-nonce-0123456789"),
      b.consume("shared-nonce-0123456789"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    // Burn is visible everywhere afterwards, including brand-new instances.
    expect(await a.consume("shared-nonce-0123456789")).toBe(false);
    expect(await b.consume("shared-nonce-0123456789")).toBe(false);
    expect(await b.has("shared-nonce-0123456789")).toBe(true);
    expect(await createFileNonceLedger(path).consume("shared-nonce-0123456789")).toBe(false);
  });

  it("cross-instance exclusion holds across many interleaved instances and nonces", async () => {
    const path = join(tmp(), "nonces.jsonl");
    const instances = Array.from({ length: 4 }, () => createFileNonceLedger(path));
    for (const nonce of ["multi-nonce-aaaaaaaaaa", "multi-nonce-bbbbbbbbbb", "multi-nonce-cccccccccc"]) {
      const results = await Promise.all(instances.map((ledger) => ledger.consume(nonce)));
      expect(results.filter(Boolean)).toHaveLength(1);
    }
  });

  it("prunes marker files older than the max mandate TTL on ledger open, keeping fresh ones", async () => {
    const path = join(tmp(), "nonces.jsonl");
    const markersDir = `${path}.markers`;
    mkdirSync(markersDir, { recursive: true, mode: 0o700 });
    const oldMarker = join(markersDir, "old-marker-hash");
    const freshMarker = join(markersDir, "fresh-marker-hash");
    writeFileSync(oldMarker, "{}", { mode: 0o600 });
    writeFileSync(freshMarker, "{}", { mode: 0o600 });

    const dayMs = 24 * 60 * 60_000;
    const nowMs = Date.now();
    // Old marker: written 2 days ago (well past any reasonable mandate TTL).
    utimesSync(oldMarker, new Date(nowMs - 2 * dayMs), new Date(nowMs - 2 * dayMs));
    // Fresh marker: written 1 minute ago.
    utimesSync(freshMarker, new Date(nowMs - 60_000), new Date(nowMs - 60_000));

    createFileNonceLedger(path, { maxMarkerAgeMs: dayMs, now: () => new Date(nowMs) });

    const remaining = readdirSync(markersDir);
    expect(remaining).toContain("fresh-marker-hash");
    expect(remaining).not.toContain("old-marker-hash");
  });

  it("pruning is a no-op (never throws) when the markers directory does not exist yet", () => {
    const path = join(tmp(), "nonces.jsonl");
    expect(() => createFileNonceLedger(path)).not.toThrow();
    expect(existsSync(`${path}.markers`)).toBe(false);
  });

  it("still honors legacy JSONL entries: a nonce recorded in the file blocks new instances", async () => {
    const path = join(tmp(), "nonces.jsonl");
    const a = createFileNonceLedger(path);
    expect(await a.consume("legacy-nonce-xyzxyzxyz")).toBe(true);
    const b = createFileNonceLedger(path);
    expect(await b.has("legacy-nonce-xyzxyzxyz")).toBe(true);
    expect(await b.consume("legacy-nonce-xyzxyzxyz")).toBe(false);
  });
});
