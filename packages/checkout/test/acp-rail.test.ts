import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import type { Offer } from "@northcinder/protocol";
import {
  ACP_API_VERSION,
  AcpPaymentCredentialSchema,
  createAcpRail,
  createInMemoryNonceLedger,
  issueMandate,
  verifyMandate,
  type MandateKeypair,
  type VerifiedMandate,
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

/**
 * The PAN the user's payment provider holds. Our client must NEVER see or
 * transmit it — only the opaque delegated token crosses the wire.
 */
const USER_CARD_PAN = "4242424242424242";
const DELEGATED_TOKEN = "spt_test_9f8e7d6c5b4a";

const ACP_OFFER: Offer = {
  id: "acp|merchant.example|item_wool_123",
  product: {
    id: "item_wool_123",
    title: "Vintage Denim Jacket",
    url: "https://merchant.example/products/item_wool_123",
    attributes: {},
  },
  price: { amount: 11000, currency: "USD" },
  merchant: { id: "merchant.example", name: "Test Merchant", domain: "merchant.example" },
  availability: "in_stock",
  sourceStore: "mock-acp",
  sponsored: false,
};

async function verified(offer: Offer, maxAmountMinor: number): Promise<VerifiedMandate> {
  const mandate = issueMandate({
    keypair,
    offer,
    intent: "buy the jacket",
    maxAmount: { amount: maxAmountMinor, currency: "USD" },
  });
  const result = await verifyMandate(mandate, offer, {
    trustedPublicKeys: [keypair.publicKeyB64],
    ledger: createInMemoryNonceLedger(),
  });
  if (!result.ok) throw new Error(`test setup: mandate rejected: ${result.rejection.code}`);
  return result.verified;
}

let merchant: MockAcpMerchant | undefined;
afterEach(async () => {
  await merchant?.close();
  merchant = undefined;
});

function railFor(m: MockAcpMerchant) {
  return createAcpRail({
    merchants: { "merchant.example": { baseUrl: m.baseUrl, apiKey: "mock_api_key" } },
    paymentTokenProvider: async () => ({ type: "spt", token: DELEGATED_TOKEN }),
    fulfillmentDetails: {
      name: "Test Buyer",
      email: "buyer@example.com",
      address: {
        name: "Test Buyer",
        line_one: "1 Test Street",
        city: "Testville",
        state: "CA",
        country: "US",
        postal_code: "94100",
      },
    },
  });
}

describe("ACP client rail", () => {
  it("completes checkout against the mock ACP merchant and returns session + order evidence", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
    });
    const rail = railFor(merchant);
    expect(rail.canHandle(ACP_OFFER)).toBe(true);
    // The mandate cap (12000) is ABOVE the approved total (11000): the
    // zero-tolerance check is against the APPROVED TOTAL, not the cap — a
    // merchant charging exactly what the human approved completes even with
    // headroom under the cap.
    const result = await rail.execute(ACP_OFFER, await verified(ACP_OFFER, 12000), { timeoutMs: 5000 });
    expect(result).toMatchObject({
      ok: true,
      status: "completed",
      evidence: {
        rail: "acp",
        checkoutSessionId: "checkout_session_1",
        orderId: "ord_checkout_session_1",
        permalinkUrl: "https://merchant.example/orders/ord_checkout_session_1",
        totalCharged: { amount: 11000, currency: "USD" },
      },
    });
    expect(merchant.sessions.get("checkout_session_1")?.status).toBe("completed");
  });

  it("rejects agent-observed or mandate-mismatched offers before fetch or payment-token access", async () => {
    let fetchCalls = 0;
    let paymentTokenCalls = 0;
    const rail = createAcpRail({
      merchants: {
        "merchant.example": { baseUrl: "https://merchant.example", apiKey: "must_not_be_used" },
      },
      async paymentTokenProvider() {
        paymentTokenCalls += 1;
        return { type: "spt", token: DELEGATED_TOKEN };
      },
      async fetchImpl() {
        fetchCalls += 1;
        throw new Error("fetch must not be reached for an ineligible offer");
      },
    });
    const mandate = await verified(ACP_OFFER, 12000);
    const observedOffer: Offer = {
      ...ACP_OFFER,
      sourceStore: "agent_browser",
    };

    const cases: Array<[Offer, string]> = [
      [observedOffer, "native_revalidation_required"],
      [{ ...ACP_OFFER, id: `${ACP_OFFER.id}|swapped` }, "offer_mismatch"],
      [
        { ...ACP_OFFER, merchant: { ...ACP_OFFER.merchant, id: "swapped-merchant.example" } },
        "merchant_mismatch",
      ],
      [{ ...ACP_OFFER, price: { amount: 11000, currency: "EUR" } }, "currency_mismatch"],
      [{ ...ACP_OFFER, shipping: { cost: { amount: 1, currency: "EUR" } } }, "currency_mismatch"],
      // The cap has headroom (12000), so 11001 is still under it. The rail
      // must bind to the exact 11000 total verified for offer A, not merely
      // re-check the looser spending ceiling against swapped offer B.
      [{ ...ACP_OFFER, price: { amount: 11001, currency: "USD" } }, "offer_total_mismatch"],
    ];

    const results = await Promise.all(
      cases.map(async ([offer, code]) => ({
        code,
        result: await rail.execute(offer, mandate, { timeoutMs: 5000 }),
      })),
    );

    expect.soft(rail.canHandle(observedOffer)).toBe(false);
    for (const { code, result } of results) {
      expect.soft(result).toMatchObject({ ok: false, error: { code } });
    }
    expect.soft(fetchCalls).toBe(0);
    expect.soft(paymentTokenCalls).toBe(0);
  });

  it("sends a well-formed ACP checkout session: required headers + exact line item + delegated token", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
    });
    const result = await railFor(merchant).execute(ACP_OFFER, await verified(ACP_OFFER, 12000), { timeoutMs: 5000 });
    expect(result.ok).toBe(true);

    const create = merchant.requests.find((r) => r.path === "/checkout_sessions");
    expect(create).toBeDefined();
    expect(create!.headers.authorization).toBe("Bearer mock_api_key");
    expect(create!.headers["api-version"]).toBe(ACP_API_VERSION);
    expect(typeof create!.headers["idempotency-key"]).toBe("string");
    expect(create!.headers["content-type"]).toBe("application/json");
    const userAgent = String(create!.headers["user-agent"]);
    expect(userAgent).toContain("NorthCinderAgent");
    expect(userAgent).toContain("automated shopping agent");
    expect(userAgent).not.toMatch(/https?:\/\/|github\.com\/northcinder/i);
    const createBody = JSON.parse(create!.rawBody);
    expect(createBody.line_items).toEqual([{ id: "item_wool_123", quantity: 1 }]);
    expect(createBody.currency).toBe("usd");
    expect(createBody.fulfillment_details.email).toBe("buyer@example.com");

    const complete = merchant.requests.find((r) => r.path.endsWith("/complete"));
    expect(complete).toBeDefined();
    const completeBody = JSON.parse(complete!.rawBody);
    expect(completeBody.payment_data.instrument.credential).toEqual({ type: "spt", token: DELEGATED_TOKEN });
    expect(completeBody.payment_data.handler_id).toBe("card_tokenized");
  });

  it("NEVER transmits a raw card PAN — the delegated token passes through opaquely", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
    });
    // The provider holds the PAN internally; our types only let a token out.
    const rail = createAcpRail({
      merchants: { "merchant.example": { baseUrl: merchant.baseUrl, apiKey: "mock_api_key" } },
      paymentTokenProvider: async () => {
        const _thePanTheProviderHolds = USER_CARD_PAN; // never leaves this closure
        void _thePanTheProviderHolds;
        return { type: "spt", token: DELEGATED_TOKEN };
      },
    });
    const result = await rail.execute(ACP_OFFER, await verified(ACP_OFFER, 12000), { timeoutMs: 5000 });
    expect(result.ok).toBe(true);
    expect(merchant.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of merchant.requests) {
      expect(request.rawBody).not.toContain(USER_CARD_PAN);
      expect(JSON.stringify(request.headers)).not.toContain(USER_CARD_PAN);
    }
    // The token DID cross the wire (that's the rail working, not an accident of the assertion above).
    expect(merchant.requests.some((r) => r.rawBody.includes(DELEGATED_TOKEN))).toBe(true);
  });

  it("rejects PAN-shaped tokens and credential objects carrying raw CVV fields before completion", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
    });
    const forCredential = (credential: unknown) => createAcpRail({
      merchants: { "merchant.example": { baseUrl: merchant!.baseUrl, apiKey: "mock_api_key" } },
      paymentTokenProvider: async () => credential as { type: "spt"; token: string },
    });

    const panResult = await forCredential({ type: "spt", token: USER_CARD_PAN }).execute(
      ACP_OFFER,
      await verified(ACP_OFFER, 12000),
      { timeoutMs: 5000 },
    );
    expect(panResult).toMatchObject({ ok: false, error: { code: "payment_token_unavailable" } });
    expect(merchant.requests.some((request) => request.path.endsWith("/complete"))).toBe(false);

    const cvvResult = await forCredential({ type: "spt", token: DELEGATED_TOKEN, cvv: "123" }).execute(
      ACP_OFFER,
      await verified(ACP_OFFER, 12000),
      { timeoutMs: 5000 },
    );
    expect(cvvResult).toMatchObject({ ok: false, error: { code: "payment_token_unavailable" } });
    expect(merchant.requests.some((request) => request.path.endsWith("/complete"))).toBe(false);
  });

  it("rejects a PAN embedded in an opaque-looking token before any merchant call", () => {
    expect(AcpPaymentCredentialSchema.safeParse({ type: "spt", token: "pan=4242-4242-4242-4242" }).success).toBe(false);
    expect(AcpPaymentCredentialSchema.safeParse({ type: "spt", token: DELEGATED_TOKEN }).success).toBe(true);
  });

  it("aborts (with cancel) when the merchant's total DRIFTS ABOVE the approved total — zero tolerance, even under the cap", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
      taxMinor: 900, // 11900 total ≠ 11000 approved — still UNDER the 12500 cap, must abort anyway
    });
    const result = await railFor(merchant).execute(ACP_OFFER, await verified(ACP_OFFER, 12500), { timeoutMs: 5000 });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "total_mismatch_at_checkout",
        details: { approvedTotal: 11000, merchantTotal: 11900, currency: "USD" },
      },
    });
    // No completion was attempted; the session was canceled instead.
    expect(merchant.requests.some((r) => r.path.endsWith("/complete"))).toBe(false);
    expect(merchant.requests.some((r) => r.path.endsWith("/cancel"))).toBe(true);
    expect(merchant.sessions.get("checkout_session_1")?.status).toBe("canceled");
  });

  it("aborts (with cancel) when the merchant's total drifts BELOW the approved total — any drift voids the sign-what-you-see approval", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 9000 } }, // 9000 ≠ 11000 approved
    });
    const result = await railFor(merchant).execute(ACP_OFFER, await verified(ACP_OFFER, 12000), { timeoutMs: 5000 });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "total_mismatch_at_checkout",
        details: { approvedTotal: 11000, merchantTotal: 9000, currency: "USD" },
      },
    });
    expect(merchant.requests.some((r) => r.path.endsWith("/complete"))).toBe(false);
    expect(merchant.requests.some((r) => r.path.endsWith("/cancel"))).toBe(true);
  });

  it("a CURRENCY mismatch at checkout gets its OWN code, distinct from an amount mismatch", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
      currency: "eur", // approved total is USD — merchant reports EUR
    });
    const result = await railFor(merchant).execute(ACP_OFFER, await verified(ACP_OFFER, 12000), { timeoutMs: 5000 });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "currency_mismatch_at_checkout",
        details: { approvedTotal: 11000, merchantTotal: 11000, currency: "USD", sessionCurrency: "EUR" },
      },
    });
    expect(merchant.requests.some((r) => r.path.endsWith("/complete"))).toBe(false);
    expect(merchant.requests.some((r) => r.path.endsWith("/cancel"))).toBe(true);
  });

  it("the approved total includes known shipping: offer price + shipping equal to the merchant total completes", async () => {
    const withShipping: Offer = { ...ACP_OFFER, shipping: { cost: { amount: 900, currency: "USD" } } };
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
      taxMinor: 900, // mock merchant folds the extra 900 into its total, matching price+shipping = 11900
    });
    const result = await railFor(merchant).execute(withShipping, await verified(withShipping, 12000), { timeoutMs: 5000 });
    expect(result).toMatchObject({
      ok: true,
      status: "completed",
      evidence: { totalCharged: { amount: 11900, currency: "USD" } },
    });
  });

  it("cancels the session and reports payment_token_unavailable when the token provider fails", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
    });
    const rail = createAcpRail({
      merchants: { "merchant.example": { baseUrl: merchant.baseUrl, apiKey: "mock_api_key" } },
      paymentTokenProvider: async () => {
        throw new Error("provider offline");
      },
    });
    const result = await rail.execute(ACP_OFFER, await verified(ACP_OFFER, 12000), { timeoutMs: 5000 });
    expect(result).toMatchObject({ ok: false, error: { code: "payment_token_unavailable" } });
    expect(merchant.requests.some((r) => r.path.endsWith("/cancel"))).toBe(true);
  });

  it("returns a structured merchant_rejected error (never throws) when the merchant rejects the session", async () => {
    merchant = await startMockAcpMerchant({ catalog: {} }); // empty catalog: unknown_item
    const result = await railFor(merchant).execute(ACP_OFFER, await verified(ACP_OFFER, 12000), { timeoutMs: 5000 });
    expect(result).toMatchObject({ ok: false, error: { code: "merchant_rejected" } });
    if (!result.ok) expect(result.error.message).toContain("unknown_item");
  });

  it("returns a structured merchant_unreachable error when the merchant endpoint is down", async () => {
    const rail = createAcpRail({
      merchants: { "merchant.example": { baseUrl: "http://127.0.0.1:1", apiKey: "mock_api_key" } },
      paymentTokenProvider: async () => ({ type: "spt", token: DELEGATED_TOKEN }),
    });
    const result = await rail.execute(ACP_OFFER, await verified(ACP_OFFER, 12000), { timeoutMs: 1500 });
    expect(result).toMatchObject({ ok: false, error: { code: "merchant_unreachable" } });
  });

  it("REJECTS a forged VerifiedMandate at runtime (cast object never verified) with zero merchant requests", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
    });
    const mandate = issueMandate({ keypair, offer: ACP_OFFER, intent: "forged", maxAmount: { amount: 12000, currency: "USD" } });
    // An attacker in-process can defeat the TYPE gate with a cast (and can
    // even recover the brand symbol via Object.getOwnPropertySymbols on a
    // real VerifiedMandate) — the runtime registry must still refuse it.
    const forged = {
      mandate,
      verifiedAt: new Date().toISOString(),
    } as unknown as VerifiedMandate;
    const result = await railFor(merchant).execute(ACP_OFFER, forged, { timeoutMs: 5000 });
    expect(result).toMatchObject({ ok: false, error: { code: "unverified_mandate" } });
    expect(merchant.requests).toHaveLength(0);
  });

  it("does not handle offers from merchants with no configured ACP endpoint", async () => {
    merchant = await startMockAcpMerchant({ catalog: {} });
    const other: Offer = { ...ACP_OFFER, merchant: { id: "unconfigured.example", name: "x", domain: "unconfigured.example" } };
    expect(railFor(merchant).canHandle(other)).toBe(false);
  });
});

describe("mock ACP merchant — Idempotency-Key dedup", () => {
  const HEADERS = {
    authorization: "Bearer mock_api_key",
    "content-type": "application/json",
    "api-version": "2026-04-17",
  };

  it("a retried /complete with the SAME Idempotency-Key returns the identical result, not a fresh (and now-invalid) state transition", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
    });

    const baseUrl = merchant.baseUrl;
    const createRes = await fetch(`${baseUrl}/checkout_sessions`, {
      method: "POST",
      headers: { ...HEADERS, "idempotency-key": "create-key-1" },
      body: JSON.stringify({ line_items: [{ id: "item_wool_123", quantity: 1 }] }),
    });
    const session = (await createRes.json()) as { id: string };

    const completeBody = JSON.stringify({
      payment_data: { instrument: { credential: { type: "spt", token: "spt_dedup_test" } } },
    });
    const completeOnce = () =>
      fetch(`${baseUrl}/checkout_sessions/${session.id}/complete`, {
        method: "POST",
        headers: { ...HEADERS, "idempotency-key": "complete-key-1" },
        body: completeBody,
      });

    const first = await completeOnce();
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect((firstBody as { status: string }).status).toBe("completed");

    // WITHOUT dedup, this retry would hit "session is completed" (invalid_state,
    // 400) since the first call already advanced the session past
    // ready_for_payment. WITH dedup, the retry must return the exact same
    // success response as the first call.
    const second = await completeOnce();
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody).toEqual(firstBody);
  });

  it("a DIFFERENT Idempotency-Key is NOT deduplicated — the second call still fails on the already-completed session", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
    });
    const createRes = await fetch(`${merchant.baseUrl}/checkout_sessions`, {
      method: "POST",
      headers: { ...HEADERS, "idempotency-key": "create-key-2" },
      body: JSON.stringify({ line_items: [{ id: "item_wool_123", quantity: 1 }] }),
    });
    const session = (await createRes.json()) as { id: string };
    const completeBody = JSON.stringify({
      payment_data: { instrument: { credential: { type: "spt", token: "spt_dedup_test" } } },
    });

    const first = await fetch(`${merchant.baseUrl}/checkout_sessions/${session.id}/complete`, {
      method: "POST",
      headers: { ...HEADERS, "idempotency-key": "complete-key-A" },
      body: completeBody,
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${merchant.baseUrl}/checkout_sessions/${session.id}/complete`, {
      method: "POST",
      headers: { ...HEADERS, "idempotency-key": "complete-key-B" },
      body: completeBody,
    });
    expect(second.status).toBe(400);
    const secondBody = (await second.json()) as { code: string };
    expect(secondBody.code).toBe("invalid_state");
  });

  it("rejects a raw CVV field even when a syntactically valid delegated token is also present", async () => {
    merchant = await startMockAcpMerchant({
      catalog: { item_wool_123: { name: "Vintage Denim Jacket", unitAmount: 11000 } },
    });
    const create = await fetch(`${merchant.baseUrl}/checkout_sessions`, {
      method: "POST",
      headers: { ...HEADERS, "idempotency-key": "create-cvv-rejection" },
      body: JSON.stringify({ line_items: [{ id: "item_wool_123", quantity: 1 }] }),
    });
    const session = (await create.json()) as { id: string };
    const response = await fetch(`${merchant.baseUrl}/checkout_sessions/${session.id}/complete`, {
      method: "POST",
      headers: { ...HEADERS, "idempotency-key": "complete-cvv-rejection" },
      body: JSON.stringify({
        payment_data: { instrument: { credential: { type: "spt", token: DELEGATED_TOKEN, cvv: "123" } } },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "raw_payment_field_rejected" });
  });
});
