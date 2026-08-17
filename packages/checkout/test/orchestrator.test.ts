import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import type { Offer } from "@northcinder/protocol";
import {
  SHOPIFY_VARIANT_ATTRIBUTE,
  createAcpRail,
  createCartPermalinkRail,
  createCheckoutOrchestrator,
  createInMemoryNonceLedger,
  issueMandate,
  type MandateKeypair,
} from "../src/index.js";
import { startMockAcpMerchant, type MockAcpMerchant } from "../src/mock/acp-merchant.js";

function testKeypair(): MandateKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    sign: (payload) => edSign(null, Buffer.from(payload), privateKey).toString("base64"),
  };
}
const keypair = testKeypair();

const USER_CARD_PAN = "4242424242424242";
const DELEGATED_TOKEN = "spt_test_orchestrator";

const ACP_OFFER: Offer = {
  id: "acp|merchant.example|item_wool_123",
  product: { id: "item_wool_123", title: "Vintage Denim Jacket", url: "https://merchant.example/products/item_wool_123", attributes: {} },
  price: { amount: 11000, currency: "USD" },
  merchant: { id: "merchant.example", name: "Test Merchant", domain: "merchant.example" },
  availability: "in_stock",
  sourceStore: "mock-acp",
  sponsored: false,
};

const SHOPIFY_OFFER: Offer = {
  id: "sf|www.allbirds.com|gid://shopify/Product/1878275686469",
  product: {
    id: "gid://shopify/Product/1878275686469",
    title: "Women's Wool Runner",
    url: "https://www.allbirds.com/products/womens-wool-runners-natural-black",
    attributes: { [SHOPIFY_VARIANT_ATTRIBUTE]: "gid://shopify/ProductVariant/32262292013136" },
  },
  price: { amount: 11000, currency: "USD" },
  merchant: { id: "www.allbirds.com", name: "www.allbirds.com", domain: "www.allbirds.com", platform: "shopify" },
  availability: "in_stock",
  sourceStore: "shopify",
  sponsored: false,
};

let merchant: MockAcpMerchant | undefined;
afterEach(async () => {
  await merchant?.close();
  merchant = undefined;
});

function orchestratorFor(m: MockAcpMerchant) {
  const acpRail = createAcpRail({
    merchants: { "merchant.example": { baseUrl: m.baseUrl, apiKey: "mock_api_key" } },
    paymentTokenProvider: async () => ({ type: "spt", token: DELEGATED_TOKEN }),
  });
  return createCheckoutOrchestrator({
    rails: [acpRail, createCartPermalinkRail()],
    trustedPublicKeys: [keypair.publicKeyB64],
    ledger: createInMemoryNonceLedger(),
  });
}

describe("checkout orchestrator — the mandate hard gate end-to-end", () => {
  it("E2E vs the mock ACP merchant: mandate → verify → rail → order record citing the mandate; no PAN on the wire", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
      // No tax: the approval zero-tolerance gate requires merchant total == approved
      // total (offer price + known shipping); drift cases live in acp-rail.test.ts.
    });
    const orchestrator = orchestratorFor(merchant);
    const mandate = issueMandate({
      keypair,
      offer: ACP_OFFER,
      intent: "Buy the Vintage Denim Jacket for at most $120",
      maxAmount: { amount: 12000, currency: "USD" },
    });
    const outcome = await orchestrator.completeCheckout(ACP_OFFER, mandate, { timeoutMs: 5000 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // The order record CITES the mandate.
      expect(outcome.order.mandateId).toBe(mandate.id);
      expect(outcome.order.mandate).toEqual(mandate);
      expect(outcome.order.offerId).toBe(ACP_OFFER.id);
      expect(outcome.order.merchantId).toBe("merchant.example");
      expect(outcome.order.railId).toBe("acp");
      expect(outcome.order.status).toBe("completed");
      expect(outcome.order.evidence).toMatchObject({
        rail: "acp",
        checkoutSessionId: "checkout_session_1",
        orderId: "ord_checkout_session_1",
        totalCharged: { amount: 11000, currency: "USD" },
      });
    }
    // The mock merchant received a well-formed ACP session and no raw PAN anywhere.
    const create = merchant.requests.find((r) => r.path === "/checkout_sessions");
    expect(JSON.parse(create!.rawBody).line_items).toEqual([{ id: "item_wool_123", quantity: 1 }]);
    for (const request of merchant.requests) {
      expect(request.rawBody).not.toContain(USER_CARD_PAN);
    }
  });

  it("verifies the mandate FIRST: a tampered mandate never reaches any rail (zero merchant requests)", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
    });
    const orchestrator = orchestratorFor(merchant);
    const mandate = issueMandate({ keypair, offer: ACP_OFFER, intent: "buy", maxAmount: { amount: 12000, currency: "USD" } });
    const tampered = { ...mandate, constraints: { ...mandate.constraints, maxAmount: { amount: 999999, currency: "USD" } } };
    const outcome = await orchestrator.completeCheckout(ACP_OFFER, tampered, { timeoutMs: 5000 });
    expect(outcome).toMatchObject({ ok: false, stage: "mandate", error: { code: "signature_invalid" } });
    expect(merchant.requests).toHaveLength(0);
  });

  it("a mandate is single-use through the orchestrator: the second checkout attempt is rejected as replayed", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
    });
    const orchestrator = orchestratorFor(merchant);
    const mandate = issueMandate({ keypair, offer: ACP_OFFER, intent: "buy once", maxAmount: { amount: 12000, currency: "USD" } });
    const first = await orchestrator.completeCheckout(ACP_OFFER, mandate, { timeoutMs: 5000 });
    expect(first.ok).toBe(true);
    const second = await orchestrator.completeCheckout(ACP_OFFER, mandate, { timeoutMs: 5000 });
    expect(second).toMatchObject({ ok: false, stage: "mandate", error: { code: "replayed" } });
  });

  it("picks the rail by offer capability: a Shopify offer routes to the own-session cart permalink", async () => {
    merchant = await startMockAcpMerchant({ catalog: {} });
    const orchestrator = orchestratorFor(merchant);
    const mandate = issueMandate({ keypair, offer: SHOPIFY_OFFER, intent: "buy the runners" });
    const outcome = await orchestrator.completeCheckout(SHOPIFY_OFFER, mandate, { timeoutMs: 5000 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.order.railId).toBe("cart-permalink");
      expect(outcome.order.status).toBe("handed_off");
      expect(outcome.order.mandateId).toBe(mandate.id);
      expect(outcome.order.evidence).toMatchObject({
        rail: "cart-permalink",
        cartUrl: "https://www.allbirds.com/cart/32262292013136:1",
      });
    }
    expect(merchant.requests).toHaveLength(0); // never touched the ACP merchant
  });

  it("fails closed (structured, no throw, no purchase) when the nonce ledger is unavailable", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
    });
    const acpRail = createAcpRail({
      merchants: { "merchant.example": { baseUrl: merchant.baseUrl, apiKey: "mock_api_key" } },
      paymentTokenProvider: async () => ({ type: "spt", token: DELEGATED_TOKEN }),
    });
    const orchestrator = createCheckoutOrchestrator({
      rails: [acpRail],
      trustedPublicKeys: [keypair.publicKeyB64],
      ledger: {
        async consume(): Promise<boolean> {
          throw new Error("EACCES: permission denied, open nonces.jsonl.markers");
        },
        async has(): Promise<boolean> {
          return false;
        },
      },
    });
    const mandate = issueMandate({ keypair, offer: ACP_OFFER, intent: "buy", maxAmount: { amount: 12000, currency: "USD" } });
    const outcome = await orchestrator.completeCheckout(ACP_OFFER, mandate, { timeoutMs: 5000 });
    expect(outcome).toMatchObject({ ok: false, stage: "mandate", error: { code: "ledger_unavailable" } });
    // Fails closed: the purchase never started — zero merchant requests.
    expect(merchant.requests).toHaveLength(0);
  });

  it("a rail whose canHandle THROWS never escapes completeCheckout as an uncaught exception (mandate NOT burned)", async () => {
    const ledger = createInMemoryNonceLedger();
    const throwingRail = {
      id: "throws-on-canhandle",
      canHandle(): boolean {
        throw new Error("canHandle blew up");
      },
      async execute(): Promise<never> {
        throw new Error("should never be reached");
      },
    };
    const orchestrator = createCheckoutOrchestrator({
      rails: [throwingRail, createCartPermalinkRail()],
      trustedPublicKeys: [keypair.publicKeyB64],
      ledger,
    });
    const mandate = issueMandate({ keypair, offer: SHOPIFY_OFFER, intent: "buy the runners" });
    const outcome = await orchestrator.completeCheckout(SHOPIFY_OFFER, mandate, { timeoutMs: 5000 });
    expect(outcome).toMatchObject({ ok: false, stage: "rail", error: { code: "internal" } });
    // Rail selection is decided before the nonce is consumed, so a selection-time
    // failure must not burn the mandate either.
    expect(await ledger.has(mandate.nonce)).toBe(false);
  });

  it("returns a structured no_rail error when no rail can handle the offer (mandate is NOT burned)", async () => {
    merchant = await startMockAcpMerchant({ catalog: {} });
    const ledger = createInMemoryNonceLedger();
    const orchestrator = createCheckoutOrchestrator({
      rails: [createCartPermalinkRail()],
      trustedPublicKeys: [keypair.publicKeyB64],
      ledger,
    });
    const offer: Offer = { ...ACP_OFFER, sourceStore: "ebay" };
    const mandate = issueMandate({ keypair, offer, intent: "buy", maxAmount: { amount: 12000, currency: "USD" } });
    const outcome = await orchestrator.completeCheckout(offer, mandate, { timeoutMs: 5000 });
    expect(outcome).toMatchObject({ ok: false, stage: "rail", error: { code: "no_rail" } });
    // no_rail is decided before the nonce is consumed, so the mandate survives.
    expect(await ledger.has(mandate.nonce)).toBe(false);
  });

  it("rejects an agent-observed offer before rail selection or execution (mandate is NOT burned)", async () => {
    const ledger = createInMemoryNonceLedger();
    let canHandleCalls = 0;
    let executeCalls = 0;
    const rail = {
      id: "must-not-see-agent-observations",
      canHandle(): boolean {
        canHandleCalls += 1;
        return true;
      },
      async execute() {
        executeCalls += 1;
        throw new Error("agent-observed offer reached checkout rail");
      },
    };
    const observedOffer: Offer = {
      ...ACP_OFFER,
      sourceStore: "agent_browser",
    };
    const mandate = issueMandate({
      keypair,
      offer: observedOffer,
      intent: "attempted authorization must remain unusable",
      maxAmount: { amount: 12000, currency: "USD" },
    });
    const orchestrator = createCheckoutOrchestrator({
      rails: [rail],
      trustedPublicKeys: [keypair.publicKeyB64],
      ledger,
    });

    const outcome = await orchestrator.completeCheckout(observedOffer, mandate, { timeoutMs: 5000 });

    expect(outcome).toMatchObject({
      ok: false,
      stage: "rail",
      error: {
        code: "native_revalidation_required",
        details: { productUrl: observedOffer.product.url },
      },
    });
    expect(canHandleCalls).toBe(0);
    expect(executeCalls).toBe(0);
    expect(await ledger.has(mandate.nonce)).toBe(false);
  });
});
