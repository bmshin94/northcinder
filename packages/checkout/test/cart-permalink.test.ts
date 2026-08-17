import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import type { Offer } from "@northcinder/protocol";
import {
  SHOPIFY_VARIANT_ATTRIBUTE,
  buildCartPermalink,
  createCartPermalinkRail,
  createInMemoryNonceLedger,
  issueMandate,
  verifyMandate,
  type MandateKeypair,
  type VerifiedMandate,
} from "../src/index.js";

function testKeypair(): MandateKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    sign: (payload) => edSign(null, Buffer.from(payload), privateKey).toString("base64"),
  };
}
const keypair = testKeypair();

const SHOPIFY_OFFER: Offer = {
  id: "sf|www.allbirds.com|gid://shopify/Product/1878275686469",
  product: {
    id: "gid://shopify/Product/1878275686469",
    title: "Women's Wool Runner - Natural Black",
    url: "https://www.allbirds.com/products/womens-wool-runners-natural-black",
    attributes: { [SHOPIFY_VARIANT_ATTRIBUTE]: "gid://shopify/ProductVariant/32262292013136" },
  },
  price: { amount: 11000, currency: "USD" },
  merchant: { id: "www.allbirds.com", name: "www.allbirds.com", domain: "www.allbirds.com", platform: "shopify" },
  availability: "in_stock",
  sourceStore: "shopify",
  sponsored: false,
};

async function verified(offer: Offer): Promise<VerifiedMandate> {
  const mandate = issueMandate({ keypair, offer, intent: "buy the wool runners" });
  const result = await verifyMandate(mandate, offer, {
    trustedPublicKeys: [keypair.publicKeyB64],
    ledger: createInMemoryNonceLedger(),
  });
  if (!result.ok) throw new Error(`test setup: ${result.rejection.code}`);
  return result.verified;
}

describe("Shopify cart permalink (own-session rail)", () => {
  it("builds the cart permalink from the merchant domain + numeric variant id", () => {
    expect(buildCartPermalink(SHOPIFY_OFFER)).toBe("https://www.allbirds.com/cart/32262292013136:1");
    expect(buildCartPermalink(SHOPIFY_OFFER, 2)).toBe("https://www.allbirds.com/cart/32262292013136:2");
  });

  it("returns null when the offer carries no variant gid", () => {
    const noVariant: Offer = {
      ...SHOPIFY_OFFER,
      product: { ...SHOPIFY_OFFER.product, attributes: {} },
    };
    expect(buildCartPermalink(noVariant)).toBeNull();
  });

  it("handles only Shopify offers that carry a variant gid", async () => {
    const rail = createCartPermalinkRail();
    expect(rail.canHandle(SHOPIFY_OFFER)).toBe(true);
    expect(rail.canHandle({ ...SHOPIFY_OFFER, sourceStore: "ebay" })).toBe(false);
    expect(
      rail.canHandle({ ...SHOPIFY_OFFER, product: { ...SHOPIFY_OFFER.product, attributes: {} } }),
    ).toBe(false);
  });

  it("rejects agent-observed or mandate-mismatched offers before producing any cart handoff", async () => {
    const rail = createCartPermalinkRail();
    const mandate = await verified(SHOPIFY_OFFER);
    const observedOffer: Offer = {
      ...SHOPIFY_OFFER,
      sourceStore: "agent_browser",
    };

    const cases: Array<[Offer, string]> = [
      [observedOffer, "native_revalidation_required"],
      [{ ...SHOPIFY_OFFER, id: `${SHOPIFY_OFFER.id}|swapped` }, "offer_mismatch"],
      [
        {
          ...SHOPIFY_OFFER,
          merchant: { ...SHOPIFY_OFFER.merchant, id: "swapped-shop.example" },
        },
        "merchant_mismatch",
      ],
      [{ ...SHOPIFY_OFFER, price: { amount: 11000, currency: "EUR" } }, "currency_mismatch"],
      [
        { ...SHOPIFY_OFFER, shipping: { cost: { amount: 1, currency: "EUR" } } },
        "currency_mismatch",
      ],
      [{ ...SHOPIFY_OFFER, price: { amount: 11001, currency: "USD" } }, "offer_total_mismatch"],
    ];

    const results = await Promise.all(
      cases.map(async ([offer, code]) => ({
        code,
        result: await rail.execute(offer, mandate, { timeoutMs: 1000 }),
      })),
    );

    expect.soft(rail.canHandle(observedOffer)).toBe(false);
    for (const { code, result } of results) {
      expect.soft(result).toMatchObject({ ok: false, error: { code } });
      expect.soft(result).not.toHaveProperty("status", "handed_off");
      expect.soft(result).not.toHaveProperty("evidence");
    }
  });

  it("hands off to the user's own session: status handed_off + the cart URL as evidence, no purchase made", async () => {
    const rail = createCartPermalinkRail();
    const result = await rail.execute(SHOPIFY_OFFER, await verified(SHOPIFY_OFFER), { timeoutMs: 1000 });
    expect(result).toMatchObject({
      ok: true,
      status: "handed_off",
      evidence: {
        rail: "cart-permalink",
        cartUrl: "https://www.allbirds.com/cart/32262292013136:1",
        variantId: "32262292013136",
        quantity: 1,
      },
    });
  });

  it("REJECTS a forged VerifiedMandate at runtime (cast object never verified)", async () => {
    const rail = createCartPermalinkRail();
    const mandate = issueMandate({ keypair, offer: SHOPIFY_OFFER, intent: "forged" });
    const forged = { mandate, verifiedAt: new Date().toISOString() } as unknown as VerifiedMandate;
    const result = await rail.execute(SHOPIFY_OFFER, forged, { timeoutMs: 1000 });
    expect(result).toMatchObject({ ok: false, error: { code: "unverified_mandate" } });
  });

  it("rejects a malformed variant gid with a structured error instead of a broken URL", async () => {
    const bad: Offer = {
      ...SHOPIFY_OFFER,
      product: {
        ...SHOPIFY_OFFER.product,
        attributes: { [SHOPIFY_VARIANT_ATTRIBUTE]: "gid://shopify/ProductVariant/not-numeric" },
      },
    };
    const rail = createCartPermalinkRail();
    expect(rail.canHandle(bad)).toBe(false);
    const result = await rail.execute(bad, await verified(bad), { timeoutMs: 1000 });
    expect(result).toMatchObject({ ok: false, error: { code: "not_configured" } });
  });
});
