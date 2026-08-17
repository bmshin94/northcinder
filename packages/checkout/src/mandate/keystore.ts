/**
 * Local mandate keystore: an ed25519 keypair generated on first run into the
 * user's config dir (file mode 0600 — it authorizes SPENDING). The private
 * key never leaves this module; callers get a `sign()` closure.
 */
import { createPrivateKey, generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigDir } from "@northcinder/protocol";

// Config-dir resolution moved to @northcinder/protocol so checkout-free surfaces
// (notably the northcinder-watch scheduler, whose law is "no checkout code path")
// can use it without importing checkout. Re-exported for backward compat.
export { resolveConfigDir };

/** Signs canonical mandate payloads; the private key stays encapsulated. */
export interface MandateKeypair {
  /** Base64 SPKI/DER ed25519 public key — what goes into mandate.signature.publicKey. */
  publicKeyB64: string;
  /** Returns the base64 ed25519 signature over the payload. */
  sign(payload: Uint8Array): string;
}

export const MANDATE_KEY_FILENAME = "mandate-key.json";

interface StoredKeyRecord {
  algorithm: "ed25519";
  privateKeyPem: string;
  publicKeySpkiB64: string;
  createdAt: string;
}

export interface LoadedMandateKeypair extends MandateKeypair {
  keyPath: string;
  /** True when this call generated the keypair (first run). */
  created: boolean;
}

export function loadOrCreateMandateKeypair(
  opts: { configDir?: string; env?: Record<string, string | undefined> } = {},
): LoadedMandateKeypair {
  const dir = opts.configDir ?? resolveConfigDir(opts.env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = join(dir, MANDATE_KEY_FILENAME);

  let record: StoredKeyRecord;
  let created = false;
  if (existsSync(keyPath)) {
    const parsed = JSON.parse(readFileSync(keyPath, "utf8")) as Partial<StoredKeyRecord>;
    if (
      parsed.algorithm !== "ed25519" ||
      typeof parsed.privateKeyPem !== "string" ||
      typeof parsed.publicKeySpkiB64 !== "string"
    ) {
      throw new Error(`northcinder keystore: ${keyPath} is not a valid ed25519 mandate key record`);
    }
    record = parsed as StoredKeyRecord;
  } else {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    record = {
      algorithm: "ed25519",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeySpkiB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      createdAt: new Date().toISOString(),
    };
    writeFileSync(keyPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    // writeFileSync's mode is filtered by the umask; enforce 0600 regardless.
    chmodSync(keyPath, 0o600);
    created = true;
  }

  const privateKey: KeyObject = createPrivateKey(record.privateKeyPem);
  return {
    publicKeyB64: record.publicKeySpkiB64,
    keyPath,
    created,
    sign: (payload) => edSign(null, Buffer.from(payload), privateKey).toString("base64"),
  };
}
