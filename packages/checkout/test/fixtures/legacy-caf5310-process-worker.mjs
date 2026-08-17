/**
 * Frozen compatibility fixture derived from caf5310df3f277e54f54574c6f12f38bdbcbc9f4:
 *   packages/checkout/src/mandate/{canonical,issue,keystore,nonce-ledger,verify}.ts
 *   packages/checkout/src/orchestrator.ts
 * It deliberately imports no checkout/protocol artifact from this working tree.
 * This is the pre-rename process in the two-process regression, not a mode of
 * the renamed built worker.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASELINE = "caf5310df3f277e54f54574c6f12f38bdbcbc9f4";
const DOMAIN = "emptor.purchase-mandate.v1";
const [mode, mandatePath, railPath] = process.argv.slice(2);
const offer = { id: "built|merchant.example|offer-1", product: { id: "offer-1", title: "Built process offer", url: "https://merchant.example/offer-1", attributes: {} }, price: { amount: 1000, currency: "USD" }, merchant: { id: "merchant.example", name: "Merchant", domain: "merchant.example" }, availability: "in_stock", sourceStore: "test", sponsored: false };

function configDir(env) {
  if (env.EMPTOR_CONFIG_DIR) return env.EMPTOR_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config"), "emptor");
}
function payload(fields) {
  return Buffer.from(JSON.stringify([DOMAIN, fields.id, fields.intent, fields.offerId, fields.merchantId, fields.maxAmountMinor, fields.currency, fields.issuedAt, fields.expiresAt, fields.nonce]));
}
function keypair(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = join(dir, "mandate-key.json");
  let record;
  if (existsSync(keyPath)) record = JSON.parse(readFileSync(keyPath, "utf8"));
  else {
    const pair = generateKeyPairSync("ed25519");
    record = { algorithm: "ed25519", privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeySpkiB64: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"), createdAt: new Date().toISOString() };
    writeFileSync(keyPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 }); chmodSync(keyPath, 0o600);
  }
  return { publicKey: record.publicKeySpkiB64, privateKey: createPrivateKey(record.privateKeyPem) };
}
function consume(dir, nonce, mandateId) {
  const markers = join(dir, "nonce-ledger.json.markers"); mkdirSync(markers, { recursive: true, mode: 0o700 });
  const marker = join(markers, createHash("sha256").update(nonce, "utf8").digest("hex"));
  try { const fd = openSync(marker, "wx", 0o600); try { writeFileSync(fd, `${JSON.stringify({ nonce, mandateId })}\n`); } finally { closeSync(fd); } return true; }
  catch (error) { if (error && error.code === "EEXIST") return false; throw error; }
}
function issue(dir) {
  const key = keypair(dir); const issuedAt = new Date().toISOString(); const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const fields = { id: "mandate_legacy_caf5310", intent: "built race", offerId: offer.id, merchantId: offer.merchant.id, maxAmountMinor: 1200, currency: "USD", issuedAt, expiresAt, nonce: "built_process_nonce_0001" };
  const signature = sign(null, payload(fields), key.privateKey).toString("base64");
  const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" });
  const currentPayload = Buffer.from(JSON.stringify(["brier.purchase-mandate.v1", fields.id, fields.intent, fields.offerId, fields.merchantId, fields.maxAmountMinor, fields.currency, fields.issuedAt, fields.expiresAt, fields.nonce]));
  writeFileSync(mandatePath, JSON.stringify({ id: fields.id, intent: fields.intent, constraints: { offerId: fields.offerId, merchantId: fields.merchantId, maxAmount: { amount: 1200, currency: "USD" } }, issuedAt, expiresAt, nonce: fields.nonce, signature: { algorithm: "ed25519", publicKey: key.publicKey, value: signature } }));
  process.send?.({ type: "issued", state: dir, provenance: BASELINE, normalNewValid: verify(null, currentPayload, publicKey, Buffer.from(signature, "base64")), normalOldValid: verify(null, payload(fields), publicKey, Buffer.from(signature, "base64")) }, () => process.disconnect?.());
}
function race(dir) {
  process.send?.({ type: "ready", state: dir });
  process.once("message", (message) => {
    if (message?.type !== "go") return;
    const mandate = JSON.parse(readFileSync(mandatePath, "utf8")); const key = keypair(dir);
    const fields = { id: mandate.id, intent: mandate.intent, offerId: mandate.constraints.offerId, merchantId: mandate.constraints.merchantId, maxAmountMinor: mandate.constraints.maxAmount.amount, currency: mandate.constraints.maxAmount.currency, issuedAt: mandate.issuedAt, expiresAt: mandate.expiresAt, nonce: mandate.nonce };
    const trusted = mandate.signature.publicKey === key.publicKey;
    const publicKey = trusted && createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" });
    if (!trusted || !verify(null, payload(fields), publicKey, Buffer.from(mandate.signature.value, "base64"))) return process.send?.({ type: "result", state: dir, result: { ok: false, stage: "mandate", error: { code: trusted ? "signature_invalid" : "untrusted_key" } } }, () => process.disconnect?.());
    if (!consume(dir, mandate.nonce, mandate.id)) return process.send?.({ type: "result", state: dir, result: { ok: false, stage: "mandate", error: { code: "replayed" } } }, () => process.disconnect?.());
    writeFileSync(railPath, String(Number(readFileSync(railPath, "utf8")) + 1));
    process.send?.({ type: "result", state: dir, result: { ok: true } }, () => process.disconnect?.());
  });
}
const state = configDir(process.env);
if (mode === "issue") issue(state); else race(state);
