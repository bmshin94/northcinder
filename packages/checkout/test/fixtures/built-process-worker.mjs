import { createPublicKey, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MANDATE_SIGNING_DOMAIN, canonicalMandatePayload,
  createCheckoutOrchestrator, createFileNonceLedger, issueMandate, loadOrCreateMandateKeypair,
} from "../../dist/index.js";

const [mode, mandatePath, railPath] = process.argv.slice(2);
const offer = { id: "built|merchant.example|offer-1", product: { id: "offer-1", title: "Built process offer", url: "https://merchant.example/offer-1", attributes: {} }, price: { amount: 1000, currency: "USD" }, merchant: { id: "merchant.example", name: "Merchant", domain: "merchant.example" }, availability: "in_stock", sourceStore: "test", sponsored: false };
const key = loadOrCreateMandateKeypair({ env: process.env });
const state = key.keyPath.replace(/\/mandate-key.json$/, "");
if (mode === "issue") {
  const issued = issueMandate({ keypair: key, offer, intent: "built race", maxAmount: { amount: 1200, currency: "USD" }, nonce: "built_process_nonce_0001" });
  const fields = { version: issued.version, id: issued.id, intent: issued.intent, offerId: issued.constraints.offerId, merchantId: issued.constraints.merchantId, offerDigest: issued.constraints.offerDigest, quantity: issued.constraints.quantity, maxAmountMinor: issued.constraints.maxAmount.amount, currency: issued.constraints.maxAmount.currency, issuedAt: issued.issuedAt, expiresAt: issued.expiresAt, nonce: issued.nonce };
  const publicKey = createPublicKey({ key: Buffer.from(key.publicKeyB64, "base64"), format: "der", type: "spki" });
  const normalNewValid = verify(null, canonicalMandatePayload(fields, MANDATE_SIGNING_DOMAIN), publicKey, Buffer.from(issued.signature.value, "base64"));
  const normalOldValid = false;
  writeFileSync(mandatePath, JSON.stringify(issued));
  process.send?.({ type: "issued", state, normalNewValid, normalOldValid });
  process.disconnect?.();
} else {
  const mandate = JSON.parse(readFileSync(mandatePath, "utf8"));
  const rail = { id: "fake", canHandle: () => true, async execute() { writeFileSync(railPath, String(Number(readFileSync(railPath, "utf8")) + 1)); return { ok: true, status: "handed_off", evidence: { kind: "fake" } }; } };
  process.send?.({ type: "ready", state });
  process.once("message", async (message) => {
    if (message?.type !== "go") return;
    const result = await createCheckoutOrchestrator({ rails: [rail], trustedPublicKeys: [key.publicKeyB64], ledger: createFileNonceLedger(join(state, "nonce-ledger.json")) }).completeCheckout(offer, mandate, {});
    process.send?.({ type: "result", state, result });
    process.disconnect?.();
  });
}
