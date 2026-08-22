import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import type { Offer, PurchaseMandate } from "@northcinder/protocol";
import {
  canonicalMandatePayload,
  createInMemoryNonceLedger,
  hasUnrepresentableShippingCurrency,
  issueMandate,
  offerTotal,
  verifyMandate,
  type MandateKeypair,
} from "../src/index.js";

function testKeypair(): MandateKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    sign: (payload) => edSign(null, Buffer.from(payload), privateKey).toString("base64"),
  };
}

const OFFER: Offer = {
  id: "sf|www.allbirds.com|gid://shopify/Product/1878275686469",
  product: {
    id: "gid://shopify/Product/1878275686469",
    title: "Women's Wool Runner - Natural Black",
    url: "https://www.allbirds.com/products/womens-wool-runners-natural-black",
    attributes: { "shopify:variantGid": "gid://shopify/ProductVariant/32262292013136" },
  },
  price: { amount: 11000, currency: "USD" },
  merchant: { id: "www.allbirds.com", name: "www.allbirds.com", domain: "www.allbirds.com", platform: "shopify" },
  availability: "in_stock",
  sourceStore: "shopify",
  sponsored: false,
};

const keypair = testKeypair();

function freshMandate(overrides?: Partial<Parameters<typeof issueMandate>[0]>): PurchaseMandate {
  return issueMandate({
    keypair,
    offer: OFFER,
    intent: "Buy the Wool Runner in black, up to $120 total",
    maxAmount: { amount: 12000, currency: "USD" },
    ttlMs: 15 * 60_000,
    ...overrides,
  });
}

function verifyOpts() {
  return { trustedPublicKeys: [keypair.publicKeyB64], ledger: createInMemoryNonceLedger() };
}

describe("hasUnrepresentableShippingCurrency — flags what offerTotal silently drops", () => {
  it("is false for an offer with no shipping, or shipping in the same currency", () => {
    expect(hasUnrepresentableShippingCurrency(OFFER)).toBe(false);
    const sameCurrency: Offer = { ...OFFER, shipping: { cost: { amount: 500, currency: "USD" } } };
    expect(hasUnrepresentableShippingCurrency(sameCurrency)).toBe(false);
    expect(offerTotal(sameCurrency)).toEqual({ amount: 11500, currency: "USD" });
  });

  it("is TRUE when shipping is in a different currency than the price — the case offerTotal cannot sum", () => {
    const mismatched: Offer = { ...OFFER, shipping: { cost: { amount: 500, currency: "EUR" } } };
    expect(hasUnrepresentableShippingCurrency(mismatched)).toBe(true);
    // offerTotal necessarily drops the unrepresentable shipping cost — this is
    // exactly why callers creating a mandate/authorization MUST check the
    // flag above first and refuse, rather than trust this (understated) total.
    expect(offerTotal(mismatched)).toEqual({ amount: 11000, currency: "USD" });
  });
});

describe("mandate issuance", () => {
  it("issues a version-2 mandate carrying a signed exact-offer digest and fixed quantity", () => {
    const m = freshMandate();
    expect(m.version).toBe(2);
    expect(m.constraints.offerId).toBe(OFFER.id);
    expect(m.constraints.merchantId).toBe("www.allbirds.com");
    expect(m.constraints.offerDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(m.constraints.quantity).toBe(1);
    expect(m.constraints.maxAmount).toEqual({ amount: 12000, currency: "USD" });
    expect(m.signature.algorithm).toBe("ed25519");
    expect(m.signature.publicKey).toBe(keypair.publicKeyB64);
    expect(m.nonce.length).toBeGreaterThanOrEqual(16);
    expect(new Date(m.expiresAt).getTime()).toBeGreaterThan(new Date(m.issuedAt).getTime());
  });

  it("defaults the spending cap to offer price + shipping when none is given", () => {
    const withShipping: Offer = { ...OFFER, shipping: { cost: { amount: 500, currency: "USD" } } };
    const m = issueMandate({ keypair, offer: withShipping, intent: "buy it" });
    expect(m.constraints.maxAmount).toEqual({ amount: 11500, currency: "USD" });
  });

  it("issues single-use nonces: two mandates never share a nonce", () => {
    expect(freshMandate().nonce).not.toBe(freshMandate().nonce);
  });

  it("accepts a caller-supplied nonce (payload-bound approval: the fingerprint shown at request time binds the eventual mandate)", async () => {
    const nonce = "b2_fingerprint_bound_nonce_001";
    const m = freshMandate({ nonce });
    expect(m.nonce).toBe(nonce);
    const result = await verifyMandate(m, OFFER, verifyOpts());
    expect(result.ok).toBe(true);
  });
});

describe("invariant #4 battery — every bad mandate is rejected with a specific structured error", () => {
  it("cannot produce a VerifiedMandate for an agent-observed offer and does not consume its nonce", async () => {
    let consumeCalls = 0;
    const observedOffer: Offer = {
      ...OFFER,
      sourceStore: "agent_browser",
    };
    const mandate = freshMandate({ offer: observedOffer });

    const result = await verifyMandate(mandate, observedOffer, {
      trustedPublicKeys: [keypair.publicKeyB64],
      ledger: {
        async consume(): Promise<boolean> {
          consumeCalls += 1;
          return true;
        },
        async has(): Promise<boolean> {
          return false;
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      rejection: {
        code: "native_revalidation_required",
        mandateId: mandate.id,
      },
    });
    expect(consumeCalls).toBe(0);
  });

  for (const domain of [
    "brier.purchase-mandate.v1",
    "thenagain.purchase-mandate.v1",
    "emptor.purchase-mandate.v1",
  ] as const) it(`rejects a signature under retired domain ${domain}`, async () => {
    const m = freshMandate();
    const legacySignature = keypair.sign(canonicalMandatePayload({
      version: m.version,
      id: m.id, intent: m.intent, offerId: m.constraints.offerId, merchantId: m.constraints.merchantId,
      offerDigest: m.constraints.offerDigest, quantity: m.constraints.quantity,
      maxAmountMinor: m.constraints.maxAmount.amount, currency: m.constraints.maxAmount.currency,
      issuedAt: m.issuedAt, expiresAt: m.expiresAt, nonce: m.nonce,
    }, domain));
    const legacy = { ...m, signature: { ...m.signature, value: legacySignature } };
    await expect(verifyMandate(legacy, OFFER, verifyOpts())).resolves.toMatchObject({
      ok: false,
      rejection: { code: "signature_invalid" },
    });
  });

  it("rejects exact-offer substitutions before consuming the nonce", async () => {
    const substitutions: Array<[string, Offer]> = [
      ["source store", { ...OFFER, sourceStore: "shopify-other" }],
      [
        "merchant domain",
        { ...OFFER, merchant: { ...OFFER.merchant, domain: "different.example" } },
      ],
      ["product id", { ...OFFER, product: { ...OFFER.product, id: "product-B" } }],
      [
        "variant attributes",
        {
          ...OFFER,
          product: {
            ...OFFER.product,
            attributes: { "shopify:variantGid": "gid://shopify/ProductVariant/999" },
          },
        },
      ],
    ];

    for (const [label, substitutedOffer] of substitutions) {
      let consumeCalls = 0;
      const mandate = freshMandate();
      const result = await verifyMandate(mandate, substitutedOffer, {
        trustedPublicKeys: [keypair.publicKeyB64],
        ledger: {
          async consume(): Promise<boolean> {
            consumeCalls += 1;
            return true;
          },
          async has(): Promise<boolean> {
            return false;
          },
        },
      });

      expect.soft(result, label).toMatchObject({
        ok: false,
        rejection: { code: "offer_digest_mismatch" },
      });
      expect.soft(consumeCalls, label).toBe(0);
    }
  });

  it("rejects quantity and digest substitutions without consuming the nonce", async () => {
    const original = freshMandate();
    const substitutions = [
      {
        ...original,
        constraints: { ...original.constraints, quantity: 2 },
      },
      {
        ...original,
        constraints: { ...original.constraints, offerDigest: "b".repeat(64) },
      },
    ] as PurchaseMandate[];

    for (const substituted of substitutions) {
      let consumeCalls = 0;
      const result = await verifyMandate(substituted, OFFER, {
        trustedPublicKeys: [keypair.publicKeyB64],
        ledger: {
          async consume(): Promise<boolean> {
            consumeCalls += 1;
            return true;
          },
          async has(): Promise<boolean> {
            return false;
          },
        },
      });
      expect.soft(result.ok).toBe(false);
      expect.soft(consumeCalls).toBe(0);
    }
  });
  it("accepts a genuine, in-budget, unexpired, unused mandate for the exact offer", async () => {
    const m = freshMandate();
    const result = await verifyMandate(m, OFFER, verifyOpts());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verified.mandate.id).toBe(m.id);
      expect(result.verified.mandate.nonce).toBe(m.nonce);
    }
  });

  it("rejects a TAMPERED SIGNATURE (flipped signature bytes) with code signature_invalid", async () => {
    const m = freshMandate();
    const sig = Buffer.from(m.signature.value, "base64");
    sig[0] = (sig[0]! + 1) % 256;
    const tampered = { ...m, signature: { ...m.signature, value: sig.toString("base64") } };
    const result = await verifyMandate(tampered, OFFER, verifyOpts());
    expect(result).toMatchObject({ ok: false, rejection: { code: "signature_invalid" } });
  });

  it("rejects a TAMPERED FIELD (spending cap raised after signing) with code signature_invalid", async () => {
    const m = freshMandate();
    const tampered = {
      ...m,
      constraints: { ...m.constraints, maxAmount: { amount: 999999, currency: "USD" } },
    };
    const result = await verifyMandate(tampered, OFFER, verifyOpts());
    expect(result).toMatchObject({ ok: false, rejection: { code: "signature_invalid" } });
  });

  it("rejects a mandate RE-SIGNED BY AN UNTRUSTED KEY with code untrusted_key", async () => {
    const attacker = testKeypair();
    const m = issueMandate({
      keypair: attacker,
      offer: OFFER,
      intent: "attacker-forged mandate",
      maxAmount: { amount: 999999, currency: "USD" },
    });
    const result = await verifyMandate(m, OFFER, verifyOpts());
    expect(result).toMatchObject({ ok: false, rejection: { code: "untrusted_key" } });
  });

  it("rejects an EXPIRED mandate with code expired", async () => {
    const m = freshMandate({ ttlMs: 1000 });
    const later = new Date(new Date(m.expiresAt).getTime() + 1);
    const result = await verifyMandate(m, OFFER, { ...verifyOpts(), now: () => later });
    expect(result).toMatchObject({ ok: false, rejection: { code: "expired" } });
  });

  it("rejects a WRONG-MERCHANT purchase with code merchant_mismatch", async () => {
    const m = freshMandate();
    const otherMerchant: Offer = {
      ...OFFER,
      merchant: { id: "evil.example.com", name: "Evil", domain: "evil.example.com" },
    };
    const result = await verifyMandate(m, otherMerchant, verifyOpts());
    expect(result).toMatchObject({ ok: false, rejection: { code: "merchant_mismatch" } });
  });

  it("rejects a WRONG-OFFER purchase with code offer_mismatch", async () => {
    const m = freshMandate();
    const otherOffer: Offer = { ...OFFER, id: "sf|www.allbirds.com|gid://shopify/Product/999" };
    const result = await verifyMandate(m, otherOffer, verifyOpts());
    expect(result).toMatchObject({ ok: false, rejection: { code: "offer_mismatch" } });
  });

  it("rejects an AMOUNT-EXCEEDED purchase (price + shipping above the signed cap) with code amount_exceeded", async () => {
    const m = freshMandate(); // cap 12000
    const pricier: Offer = { ...OFFER, shipping: { cost: { amount: 1500, currency: "USD" } } }; // 11000+1500 > 12000
    const result = await verifyMandate(m, pricier, verifyOpts());
    expect(result).toMatchObject({ ok: false, rejection: { code: "amount_exceeded" } });
  });

  it("rejects a CURRENCY-MISMATCHED purchase with code currency_mismatch", async () => {
    const m = freshMandate();
    const eurOffer: Offer = { ...OFFER, price: { amount: 9000, currency: "EUR" } };
    const result = await verifyMandate(m, eurOffer, verifyOpts());
    expect(result).toMatchObject({ ok: false, rejection: { code: "currency_mismatch" } });
  });

  it("rejects a REPLAYED mandate (nonce reuse) with code replayed", async () => {
    const m = freshMandate();
    const opts = verifyOpts();
    const first = await verifyMandate(m, OFFER, opts);
    expect(first.ok).toBe(true);
    const second = await verifyMandate(m, OFFER, opts);
    expect(second).toMatchObject({ ok: false, rejection: { code: "replayed" } });
  });

  it("rejects a MALFORMED mandate (nonce below 16 chars) with code malformed", async () => {
    const m = { ...freshMandate(), nonce: "short" } as PurchaseMandate;
    const result = await verifyMandate(m, OFFER, verifyOpts());
    expect(result).toMatchObject({ ok: false, rejection: { code: "malformed" } });
  });

  it("fails CLOSED with code ledger_unavailable (never throws) when the nonce ledger's persist fails", async () => {
    const m = freshMandate();
    const brokenLedger = {
      async consume(): Promise<boolean> {
        throw new Error("disk full");
      },
      async has(): Promise<boolean> {
        return false;
      },
    };
    const result = await verifyMandate(m, OFFER, {
      trustedPublicKeys: [keypair.publicKeyB64],
      ledger: brokenLedger,
    });
    expect(result).toMatchObject({ ok: false, rejection: { code: "ledger_unavailable" } });
    if (!result.ok) expect(result.rejection.message).toContain("disk full");
  });

  it("does NOT consume the nonce when verification fails before the ledger (a failed attempt cannot burn the mandate)", async () => {
    const m = freshMandate();
    const opts = verifyOpts();
    const wrongMerchant: Offer = { ...OFFER, merchant: { id: "x.example", name: "x", domain: "x.example" } };
    await verifyMandate(m, wrongMerchant, opts);
    expect(await opts.ledger.has(m.nonce)).toBe(false);
    // Still spendable on the real offer afterwards.
    const result = await verifyMandate(m, OFFER, opts);
    expect(result.ok).toBe(true);
  });
});

describe("canonical signing payload", () => {
  it("is deterministic and covers {offer id, merchant, max amount+currency, expiry, nonce}", () => {
    const fields = {
      version: 2 as const,
      id: "mandate_1",
      intent: "buy",
      offerId: OFFER.id,
      merchantId: "www.allbirds.com",
      offerDigest: "a".repeat(64),
      quantity: 1 as const,
      maxAmountMinor: 12000,
      currency: "USD",
      issuedAt: "2026-07-04T00:00:00.000Z",
      expiresAt: "2026-07-04T00:15:00.000Z",
      nonce: "abcdefghijklmnop",
    };
    const a = Buffer.from(canonicalMandatePayload(fields)).toString("utf8");
    const b = Buffer.from(canonicalMandatePayload({ ...fields })).toString("utf8");
    expect(a).toBe(b);
    for (const v of [OFFER.id, "www.allbirds.com", "a".repeat(64), "12000", "USD", "2026-07-04T00:15:00.000Z", "abcdefghijklmnop"]) {
      expect(a).toContain(v);
    }
    const c = Buffer.from(canonicalMandatePayload({ ...fields, maxAmountMinor: 12001 })).toString("utf8");
    expect(c).not.toBe(a);
  });
});
