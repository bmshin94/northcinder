import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Offer } from "@northcinder/protocol";
import { createInMemoryNonceLedger, loadOrCreateMandateKeypair, verifyMandate } from "@northcinder/checkout";
import { startMockAcpMerchant } from "@northcinder/checkout/mock-acp-merchant";
import { createAuthorizationStore, type RequestOutcome } from "../src/authorization.js";
import { BRAND_NAME } from "../src/brand.js";
import { createClientCheckout } from "../src/checkout-wiring.js";
import { orderFingerprint, renderOrderTuple } from "../src/order-tuple.js";

const OFFER: Offer = {
  id: "offer-1",
  product: {
    id: "p1",
    title: "Wool Runner",
    url: "https://www.allbirds.com/products/wool-runner",
    attributes: {},
  },
  price: { amount: 9800, currency: "USD" },
  merchant: { id: "www.allbirds.com", name: "Allbirds", domain: "www.allbirds.com", platform: "shopify" },
  availability: "in_stock",
  sourceStore: "shopify",
  sponsored: false,
};

function makeStore(overrides: { ttlMs?: number; now?: () => Date } = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "northcinder-auth-"));
  const keypair = loadOrCreateMandateKeypair({ configDir });
  const store = createAuthorizationStore({ keypair, configDir, ...overrides });
  return { store, configDir, keypair };
}

/** The one-time code is the FIRST LINE of the code file; the rest is human context. */
function codeOnDisk(configDir: string, authorizationId: string): string {
  const path = join(configDir, "pending-authorizations", `${authorizationId}.code`);
  return readFileSync(path, "utf8").split("\n")[0]!.trim();
}

describe("purchase authorization gate — request NEVER auto-approves (spec §4 invariant 4)", () => {
  it("request() creates a PENDING authorization whose summary does NOT contain the confirmation code", () => {
    const { store, configDir } = makeStore();
    const { authorization, summary } = store.request(OFFER, { intent: "Buy the Wool Runner" });

    expect(authorization.status).toBe("pending");
    expect(authorization.mandate).toBeUndefined();
    expect(summary).toContain("Wool Runner");
    expect(summary).toContain("98.00 USD");
    expect(summary).toContain("www.allbirds.com");
    // The summary's tax statement matches the trusted channel: tax is UNKNOWN
    // at authorization — never "shown on the approval channel" (it isn't).
    expect(summary).toContain("tax UNKNOWN");
    expect(summary).not.toContain("any tax is shown on the user's approval channel");

    // The code is delivered OUT-OF-BAND (file + stderr), never in the summary
    // the host agent reads back.
    const code = codeOnDisk(configDir, authorization.id);
    expect(code.length).toBeGreaterThanOrEqual(8);
    expect(summary).not.toContain(code);
    expect(JSON.stringify(authorization)).not.toContain(code);
  });

  it("the agent-visible summary does NOT reveal the code file's location (a file-capable host must not get a path to Read)", () => {
    const { store, configDir } = makeStore();
    const { authorization, summary, codeDelivery } = store.request(OFFER, { intent: "Buy the Wool Runner" });
    expect(summary).not.toContain(configDir);
    expect(summary).not.toContain(codeDelivery.file);
    expect(summary).not.toContain("pending-authorizations");
    expect(summary).not.toContain(`${authorization.id}.code`);
  });

  it("the buyer-local code file and optional stderr banner show the hard cap the mandate will sign", () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-auth-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const store = createAuthorizationStore({ keypair, configDir });

    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let authorization;
    try {
      // The host agent asks for a cap FAR above the offer price — the human
      // must see that number on the channel the agent cannot forge.
      ({ authorization } = store.request(
        { ...OFFER, shipping: { cost: { amount: 500, currency: "USD" } } },
        { intent: "Buy the Wool Runner", maxAmount: { amount: 500_000, currency: "USD" } },
      ));
    } finally {
      process.stderr.write = originalWrite;
    }

    const banner = stderrChunks.join("");
    expect(banner).toContain("HARD SPENDING CAP: 5000.00 USD");
    expect(banner).toContain("shipping 5.00 USD");

    const codeFileContent = readFileSync(
      join(configDir, "pending-authorizations", `${authorization.id}.code`),
      "utf8",
    );
    expect(codeFileContent).toContain("HARD SPENDING CAP: 5000.00 USD");
    // ...and the first line is still exactly the code.
    expect(codeFileContent.split("\n")[0]!).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("approve() with the out-of-band code signs a mandate that passes verifyMandate against the SAME offer", async () => {
    const { store, configDir, keypair } = makeStore();
    const { authorization } = store.request(OFFER, { intent: "Buy the Wool Runner" });
    const code = codeOnDisk(configDir, authorization.id);

    const result = store.approve(authorization.id, code);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.authorization.status).toBe("approved");
    const mandate = result.authorization.mandate!;
    expect(mandate.constraints.offerId).toBe("offer-1");
    expect(mandate.constraints.merchantId).toBe("www.allbirds.com");
    expect(mandate.constraints.maxAmount).toEqual({ amount: 9800, currency: "USD" });

    const verification = await verifyMandate(mandate, OFFER, {
      trustedPublicKeys: [keypair.publicKeyB64],
      ledger: createInMemoryNonceLedger(),
    });
    expect(verification.ok).toBe(true);

    // The one-time code file is removed once used.
    expect(existsSync(join(configDir, "pending-authorizations", `${authorization.id}.code`))).toBe(false);
  });

  it("approve() with a WRONG code is denied, and attempts are bounded", () => {
    const { store, configDir } = makeStore();
    const { authorization } = store.request(OFFER, { intent: "x" });
    const realCode = codeOnDisk(configDir, authorization.id);

    for (let i = 0; i < 3; i += 1) {
      const attempt = store.approve(authorization.id, "WRONG-CODE");
      expect(attempt.ok).toBe(false);
      if (attempt.ok) throw new Error("unreachable");
      expect(["code_mismatch", "attempts_exhausted"]).toContain(attempt.error.code);
    }
    // After exhausting attempts, even the REAL code no longer works.
    const final = store.approve(authorization.id, realCode);
    expect(final.ok).toBe(false);
    if (final.ok) throw new Error("unreachable");
    expect(final.error.code).toBe("attempts_exhausted");
  });

  it("an expired pending authorization cannot be approved", () => {
    let t = new Date("2026-07-04T12:00:00.000Z");
    const { store, configDir } = (() => {
      const configDir = mkdtempSync(join(tmpdir(), "northcinder-auth-"));
      const keypair = loadOrCreateMandateKeypair({ configDir });
      return { store: createAuthorizationStore({ keypair, configDir, ttlMs: 60_000, now: () => t }), configDir };
    })();
    const { authorization } = store.request(OFFER, { intent: "x" });
    const code = codeOnDisk(configDir, authorization.id);

    t = new Date("2026-07-04T12:02:00.000Z"); // 2 minutes later, past the 60s TTL
    const result = store.approve(authorization.id, code);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("expired");
  });

  it("approving twice fails — approval is single-shot", () => {
    const { store, configDir } = makeStore();
    const { authorization } = store.request(OFFER, { intent: "x" });
    const code = codeOnDisk(configDir, authorization.id);
    expect(store.approve(authorization.id, code).ok).toBe(true);
    const again = store.approve(authorization.id, code);
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.error.code).toBe("already_approved");
  });

  it("unknown authorization ids are structured not_found errors", () => {
    const { store } = makeStore();
    const result = store.approve("auth_nope", "ANYCODE1");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Approval invariant coverage: four-tuple + payload-bound approval
// ---------------------------------------------------------------------------

/** Offer with variant attributes + known shipping, for the full tuple. */
const TUPLE_OFFER: Offer = {
  ...OFFER,
  product: {
    ...OFFER.product,
    attributes: {
      color: "natural black",
      size: "10",
      "shopify:variantGid": "gid://shopify/ProductVariant/32262292013136",
    },
  },
  shipping: { cost: { amount: 500, currency: "USD" } },
};

/** Runs fn with stderr captured; returns everything written to it. */
function withCapturedStderr<T>(fn: () => T): { value: T; banner: string } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: fn(), banner: chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

function codeFileContent(configDir: string, authorizationId: string): string {
  return readFileSync(join(configDir, "pending-authorizations", `${authorizationId}.code`), "utf8");
}

describe("approval four-tuple — everything the human approves, verbatim on BOTH trusted channels", () => {
  it("cart-permalink context: merchant-of-record, exact item + variant, all-in total with honest UNKNOWN tax, payment context", () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-auth-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const store = createAuthorizationStore({ keypair, configDir });

    const { value: outcome, banner } = withCapturedStderr(() =>
      store.request(TUPLE_OFFER, { intent: "Buy the Wool Runner", paymentContext: "cart-permalink" }),
    );
    const codeFile = codeFileContent(configDir, outcome.authorization.id);

    const expectedTuple = [
      "Merchant:  Allbirds (www.allbirds.com) — merchant of record: Allbirds is the party that charges you",
      "Item:      Wool Runner — variant: color: natural black, size: 10, shopify variant 32262292013136",
      "Total:     103.00 USD all-in (price 98.00 USD + shipping 5.00 USD; tax UNKNOWN — you will see the final total, including any tax, at merchant checkout before paying)",
      "Payment:   your payment method at merchant checkout — your own browser session and stored payment method complete the purchase",
    ];
    for (const line of expectedTuple) {
      expect(banner).toContain(line);
      expect(codeFile).toContain(line);
    }
    // The tuple renderer is the single source for both channels.
    expect(renderOrderTuple(TUPLE_OFFER, "cart-permalink")).toEqual(expectedTuple);
  });

  it("ACP context: delegated-token payment line and the zero-tolerance total statement", () => {
    const acpOffer: Offer = { ...OFFER, product: { ...OFFER.product, attributes: {} } };
    const tuple = renderOrderTuple(acpOffer, "acp");
    expect(tuple).toEqual([
      "Merchant:  Allbirds (www.allbirds.com) — merchant of record: Allbirds is the party that charges you",
      "Item:      Wool Runner — no variant specified",
      "Total:     98.00 USD all-in (price 98.00 USD; shipping UNKNOWN; tax UNKNOWN at authorization — checkout is REFUSED unless the merchant's pre-payment total equals this amount exactly)",
      "Payment:   delegated token via ACP — NorthCinder sends only an opaque delegated payment token; no card data exists in this flow",
    ]);
  });
});

describe("approval order fingerprint — the code commits to the tuple", () => {
  it("is displayed WITH the code on both trusted channels and binds the mandate actually signed at approval", () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-auth-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const store = createAuthorizationStore({ keypair, configDir });

    const { value: outcome, banner } = withCapturedStderr(() =>
      store.request(TUPLE_OFFER, { intent: "Buy the Wool Runner", paymentContext: "cart-permalink" }),
    );
    const bannerFp = banner.match(/order-fingerprint ([0-9A-F]{4})/)?.[1];
    expect(bannerFp).toBeDefined();
    // Displayed on the SAME line as the code (brief: `code … · order-fingerprint …`).
    expect(banner).toMatch(/CONFIRMATION CODE: [A-Z2-9]{4}-[A-Z2-9]{4} · order-fingerprint [0-9A-F]{4}/);
    const codeFile = codeFileContent(configDir, outcome.authorization.id);
    expect(codeFile).toContain(`order-fingerprint ${bannerFp}`);

    // Approving signs a mandate whose fields RECOMPUTE to the displayed fingerprint.
    const code = codeFile.split("\n")[0]!.trim();
    const approved = store.approve(outcome.authorization.id, code);
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error("unreachable");
    const mandate = approved.authorization.mandate!;
    expect(
      orderFingerprint({
        merchantId: mandate.constraints.merchantId,
        offerId: mandate.constraints.offerId,
        productId: TUPLE_OFFER.product.id,
        variantKey: TUPLE_OFFER.product.attributes["shopify:variantGid"]!,
        totalMinor: 10300,
        currency: "USD",
        nonce: mandate.nonce,
      }),
    ).toBe(bannerFp);
  });

  it("is display-binding, NOT a secret: absent from the agent-visible summary and authorization JSON, and USELESS as a code", () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-auth-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const store = createAuthorizationStore({ keypair, configDir, quiet: true });
    const outcome: RequestOutcome = store.request(TUPLE_OFFER, { intent: "x", paymentContext: "cart-permalink" });

    const codeFile = codeFileContent(configDir, outcome.authorization.id);
    const fp = codeFile.match(/order-fingerprint ([0-9A-F]{4})/)?.[1];
    expect(fp).toBeDefined();
    expect(outcome.summary).not.toContain(`order-fingerprint ${fp}`);
    // The Authorization record the tools serialize carries NO fingerprint field
    // (it lives only in the store's internal record + the trusted channels).
    expect(JSON.stringify(outcome.authorization)).not.toMatch(/fingerprint/i);

    // Presenting the fingerprint as if it were the code is just a wrong code.
    const attempt = store.approve(outcome.authorization.id, fp!);
    expect(attempt.ok).toBe(false);
    if (attempt.ok) throw new Error("unreachable");
    expect(attempt.error.code).toBe("code_mismatch");
  });

  it("REJECTS tuple mutation after issuance: correct code + mutated price → structured tuple_mismatch, authorization VOID", () => {
    const { store, configDir } = makeStore();
    const { authorization } = store.request(TUPLE_OFFER, { intent: "x", paymentContext: "cart-permalink" });
    const code = codeOnDisk(configDir, authorization.id);

    // The host process mutates the pending authorization's offer (e.g. a
    // compromised in-process caller re-points the tuple after the human saw it).
    authorization.offer.price.amount = 1;

    const result = store.approve(authorization.id, code);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("tuple_mismatch");
    // Voided: even the real code no longer works, and no mandate was signed.
    expect(authorization.status).toBe("denied");
    expect(authorization.mandate).toBeUndefined();
    const retry = store.approve(authorization.id, code);
    expect(retry.ok).toBe(false);
    if (retry.ok) throw new Error("unreachable");
    expect(retry.error.code).toBe("denied");
    expect(existsSync(join(configDir, "pending-authorizations", `${authorization.id}.code`))).toBe(false);
  });

  it("REJECTS product-id mutation after issuance — the ACP rail purchases by product.id, so it MUST be bound", () => {
    const { store, configDir } = makeStore();
    const { authorization } = store.request(TUPLE_OFFER, { intent: "x", paymentContext: "acp" });
    const code = codeOnDisk(configDir, authorization.id);
    // Same offer.id, same price, DIFFERENT underlying product: what the rail
    // would buy is no longer what the human read.
    authorization.offer.product.id = "a-different-product";
    const result = store.approve(authorization.id, code);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("tuple_mismatch");
    expect(authorization.status).toBe("denied");
    expect(authorization.mandate).toBeUndefined();
  });

  it("REJECTS variant mutation after issuance — cart-permalink purchases by the variant gid, so it MUST be bound", () => {
    const { store, configDir } = makeStore();
    const { authorization } = store.request(TUPLE_OFFER, { intent: "x", paymentContext: "cart-permalink" });
    const code = codeOnDisk(configDir, authorization.id);
    authorization.offer.product.attributes["shopify:variantGid"] = "gid://shopify/ProductVariant/999999999";
    const result = store.approve(authorization.id, code);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("tuple_mismatch");
    expect(authorization.mandate).toBeUndefined();
  });

  it("REJECTS ANY offer-field mutation after issuance (whole-offer snapshot): even the title the human read is binding", () => {
    const { store, configDir } = makeStore();
    const { authorization } = store.request(TUPLE_OFFER, { intent: "x", paymentContext: "cart-permalink" });
    const code = codeOnDisk(configDir, authorization.id);
    authorization.offer.product.title = "Completely Different Item";
    const result = store.approve(authorization.id, code);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("tuple_mismatch");
  });

  it("REJECTS cap mutation after issuance too — the banner's HARD SPENDING CAP is what gets signed", () => {
    const { store, configDir } = makeStore();
    const { authorization } = store.request(TUPLE_OFFER, {
      intent: "x",
      maxAmount: { amount: 20000, currency: "USD" },
      paymentContext: "cart-permalink",
    });
    const code = codeOnDisk(configDir, authorization.id);
    authorization.maxAmount.amount = 500_000; // agent raises the cap after the human saw 200.00
    const result = store.approve(authorization.id, code);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("tuple_mismatch");
    expect(authorization.mandate).toBeUndefined();
  });

  it("orderFingerprint is deterministic and every field is load-bearing — incl. product identity and variant", () => {
    const base = {
      merchantId: "m",
      offerId: "o",
      productId: "p",
      variantKey: "gid://shopify/ProductVariant/1",
      totalMinor: 100,
      currency: "USD",
      nonce: "n".repeat(16),
    };
    const fp = orderFingerprint(base);
    expect(fp).toMatch(/^[0-9A-F]{4}$/);
    expect(orderFingerprint({ ...base })).toBe(fp);
    expect(orderFingerprint({ ...base, merchantId: "m2" })).not.toBe(fp);
    expect(orderFingerprint({ ...base, offerId: "o2" })).not.toBe(fp);
    expect(orderFingerprint({ ...base, productId: "p2" })).not.toBe(fp);
    expect(orderFingerprint({ ...base, variantKey: "gid://shopify/ProductVariant/2" })).not.toBe(fp);
    expect(orderFingerprint({ ...base, totalMinor: 101 })).not.toBe(fp);
    expect(orderFingerprint({ ...base, currency: "EUR" })).not.toBe(fp);
    expect(orderFingerprint({ ...base, nonce: "x".repeat(16) })).not.toBe(fp);
  });
});

describe("approval symmetric decline — first-class, audited-by-caller, no guilt", () => {
  it("decline() voids a PENDING authorization: code file deleted, the real code no longer approves", () => {
    const { store, configDir } = makeStore();
    const { authorization } = store.request(OFFER, { intent: "x" });
    const code = codeOnDisk(configDir, authorization.id);

    const declined = store.decline(authorization.id);
    expect(declined.ok).toBe(true);
    if (!declined.ok) throw new Error("unreachable");
    expect(declined.authorization.status).toBe("denied");
    expect(existsSync(join(configDir, "pending-authorizations", `${authorization.id}.code`))).toBe(false);

    const approveAfter = store.approve(authorization.id, code);
    expect(approveAfter.ok).toBe(false);
    if (approveAfter.ok) throw new Error("unreachable");
    expect(approveAfter.error.code).toBe("denied");
  });

  it("decline() is idempotent — declining twice is still a clean, penalty-free outcome", () => {
    const { store } = makeStore();
    const { authorization } = store.request(OFFER, { intent: "x" });
    expect(store.decline(authorization.id).ok).toBe(true);
    expect(store.decline(authorization.id).ok).toBe(true);
  });

  it("an APPROVED (not yet consumed) authorization can still be declined — the user may change their mind before checkout", () => {
    const { store, configDir } = makeStore();
    const { authorization } = store.request(OFFER, { intent: "x" });
    const code = codeOnDisk(configDir, authorization.id);
    expect(store.approve(authorization.id, code).ok).toBe(true);
    const declined = store.decline(authorization.id);
    expect(declined.ok).toBe(true);
    if (!declined.ok) throw new Error("unreachable");
    expect(declined.authorization.status).toBe("denied");
  });

  it("a CONSUMED authorization cannot be declined (the checkout attempt already happened)", () => {
    const { store, configDir } = makeStore();
    const { authorization } = store.request(OFFER, { intent: "x" });
    const code = codeOnDisk(configDir, authorization.id);
    expect(store.approve(authorization.id, code).ok).toBe(true);
    store.markConsumed(authorization.id);
    const declined = store.decline(authorization.id);
    expect(declined.ok).toBe(false);
    if (declined.ok) throw new Error("unreachable");
    expect(declined.error.code).toBe("already_consumed");
  });

  it("declining an unknown id is a structured not_found", () => {
    const { store } = makeStore();
    const result = store.decline("auth_nope");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("not_found");
  });
});

describe("approval regression — the approve→checkout window is sealed", () => {
  it("post-approve price mutation via a held reference cannot re-aim the zero-tolerance check: checkout aborts, no charge", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-auth-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const store = createAuthorizationStore({ keypair, configDir, quiet: true });
    // The merchant quotes 10500 (9800 + 700 tax) — NOT the 9800 the human approved.
    const merchant = await startMockAcpMerchant({
      catalog: { p1: { name: "Wool Runner", unitAmount: 9800 } },
      taxMinor: 700,
      apiKey: "mock_api_key",
    });
    try {
      const acpOffer: Offer = {
        id: "offer-acp-1",
        product: { id: "p1", title: "Wool Runner", url: "https://mock.example/p1", attributes: {} },
        price: { amount: 9800, currency: "USD" },
        merchant: { id: "mock.example", name: "Mock", domain: "mock.example" },
        availability: "in_stock",
        sourceStore: "mock-acp",
        sponsored: false,
      };
      const checkout = createClientCheckout({
        configDir,
        trustedPublicKeys: [keypair.publicKeyB64],
        acpMerchants: { "mock.example": { baseUrl: merchant.baseUrl, apiKey: "mock_api_key" } },
        acpPaymentToken: "spt_test_token",
      });

      const { authorization } = store.request(acpOffer, {
        intent: "x",
        maxAmount: { amount: 12000, currency: "USD" },
        paymentContext: "acp",
      });
      const code = codeOnDisk(configDir, authorization.id);
      expect(store.approve(authorization.id, code).ok).toBe(true);

      // AFTER approval, the attacker mutates the HELD live reference so the
      // "approved total" would exactly match the merchant's higher quote
      // (still under the cap) — defeating zero tolerance on old code.
      authorization.offer.price.amount = 10500;

      // The server path reads via get(): it must see the APPROVE-TIME truth,
      // never the externally-reachable live object.
      const auth = store.get(authorization.id)!;
      expect(auth.offer.price.amount).toBe(9800);

      const outcome = await checkout.orchestrator.completeCheckout(auth.offer, auth.mandate!, { timeoutMs: 5000 });
      expect(outcome).toMatchObject({
        ok: false,
        stage: "rail",
        error: { code: "total_mismatch_at_checkout", details: { approvedTotal: 9800, merchantTotal: 10500 } },
      });
      // The session was canceled; the merchant never completed a charge.
      expect(merchant.requests.some((r) => r.path.endsWith("/complete"))).toBe(false);
      expect(merchant.requests.some((r) => r.path.endsWith("/cancel"))).toBe(true);
    } finally {
      await merchant.close();
    }
  });

  it("get() returns a defensive deep clone: mutating it never reaches the store's internal record", () => {
    const { store, configDir } = makeStore();
    const { authorization } = store.request(TUPLE_OFFER, { intent: "x", paymentContext: "cart-permalink" });
    const code = codeOnDisk(configDir, authorization.id);

    const view = store.get(authorization.id)!;
    view.offer.price.amount = 1;
    view.maxAmount.amount = 999_999;

    // Internal state untouched: a fresh read shows the request-time truth
    // and approval still succeeds against the intact tuple.
    const fresh = store.get(authorization.id)!;
    expect(fresh.offer.price.amount).toBe(9800);
    expect(store.approve(authorization.id, code).ok).toBe(true);
  });
});

describe("brand constants (one constants module per surface)", () => {
  it("user-visible brand mentions on the approval surface source from BRAND_NAME", () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-auth-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const store = createAuthorizationStore({ keypair, configDir });
    const { value: outcome, banner } = withCapturedStderr(() =>
      store.request(TUPLE_OFFER, { intent: "x", paymentContext: "acp" }),
    );
    expect(BRAND_NAME.length).toBeGreaterThan(0);
    expect(banner).toContain(`┌─ ${BRAND_NAME} purchase approval`);
    expect(outcome.summary).toContain(`buyer-local ${BRAND_NAME} approval`);
    expect(outcome.summary).toContain("program the buyer runs under the same OS account");
    expect(outcome.summary).not.toMatch(/host running|owner-local|NorthCinder-operated/i);
    const paymentLine = renderOrderTuple(TUPLE_OFFER, "acp")[3]!;
    expect(paymentLine).toContain(`${BRAND_NAME} sends only an opaque delegated payment token`);
  });
});

describe("approval regression — intent binding + door symmetry for local UI", () => {
  it("REJECTS intent mutation after issuance — the intent line the human read is part of what gets signed", () => {
    const { store, configDir } = makeStore();
    const { authorization } = store.request(TUPLE_OFFER, { intent: "Buy ONE wool runner", paymentContext: "cart-permalink" });
    const code = codeOnDisk(configDir, authorization.id);
    authorization.intent = "Buy ten of everything";
    const result = store.approve(authorization.id, code);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("tuple_mismatch");
    expect(authorization.mandate).toBeUndefined();
  });

  it("approve() returns a snapshot view (with the signed mandate): mutating it never touches internal state", () => {
    const { store, configDir } = makeStore();
    const { authorization } = store.request(TUPLE_OFFER, { intent: "x", paymentContext: "cart-permalink" });
    const code = codeOnDisk(configDir, authorization.id);

    const approved = store.approve(authorization.id, code);
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error("unreachable");
    expect(approved.authorization.mandate).toBeDefined();

    // The local UI approval-page door gets the same defensive view as get():
    // mutating the returned object must not reach the store.
    approved.authorization.offer.price.amount = 1;
    approved.authorization.intent = "mutated";
    delete approved.authorization.mandate;

    const fresh = store.get(authorization.id)!;
    expect(fresh.status).toBe("approved");
    expect(fresh.offer.price.amount).toBe(9800);
    expect(fresh.intent).toBe("x");
    expect(fresh.mandate).toBeDefined();
  });
});

describe("approval-page channel — the URL rides the OUT-OF-BAND channels only", () => {
  const TOKEN = "tok_test_session_fixture_ABC123";

  function makeUiStore() {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-auth-ui-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const events: import("../src/authorization.js").ApprovalRequestEvent[] = [];
    const store = createAuthorizationStore({
      keypair,
      configDir,
      quiet: true,
      approvalUrl: (id) => `http://127.0.0.1:7777/approve/${id}?t=${TOKEN}`,
      onRequested: (event) => events.push(event),
    });
    return { store, configDir, events };
  }

  it("the code file carries the approval URL (with the session token); the agent-visible summary and authorization carry NEITHER", () => {
    const { store, configDir } = makeUiStore();
    const outcome = store.request(OFFER, { intent: "Buy the Wool Runner via the page" });
    const codeFileBody = readFileSync(
      join(configDir, "pending-authorizations", `${outcome.authorization.id}.code`),
      "utf8",
    );
    expect(codeFileBody).toContain(
      `Or review & approve/decline in your browser: http://127.0.0.1:7777/approve/${outcome.authorization.id}?t=${TOKEN}`,
    );
    // Leak discipline (extends the approval leak tests): the session token and the
    // approval URL are out-of-band — the agent-visible surfaces have neither.
    expect(outcome.summary).not.toContain(TOKEN);
    expect(outcome.summary).not.toContain("/approve/");
    expect(JSON.stringify(outcome.authorization)).not.toContain(TOKEN);
    expect(JSON.stringify(outcome.authorization)).not.toContain("/approve/");
  });

  it("the stderr banner carries the approval URL alongside the code", () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-auth-ui-banner-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const store = createAuthorizationStore({
      keypair,
      configDir,
      approvalUrl: (id) => `http://127.0.0.1:7777/approve/${id}?t=${TOKEN}`,
    });
    const chunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let outcome: RequestOutcome;
    try {
      outcome = store.request(OFFER, { intent: "banner check" });
    } finally {
      process.stderr.write = originalWrite;
    }
    const banner = chunks.join("");
    expect(banner).toContain(`Or review & approve/decline in your browser: http://127.0.0.1:7777/approve/${outcome.authorization.id}?t=${TOKEN}`);
    expect(banner).toContain("CONFIRMATION CODE:");
  });

  it("onRequested fires with authorizationId + fingerprint + approval URL — and NEVER the code", () => {
    const { store, configDir, events } = makeUiStore();
    const outcome = store.request(OFFER, { intent: "push check" });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.authorizationId).toBe(outcome.authorization.id);
    expect(event.fingerprint).toMatch(/^[0-9A-F]{4}$/);
    expect(event.fingerprint).toBe(outcome.fingerprint);
    expect(event.approvalUrl).toBe(`http://127.0.0.1:7777/approve/${outcome.authorization.id}?t=${TOKEN}`);
    expect(event.intent).toBe("push check");
    const code = codeOnDisk(configDir, outcome.authorization.id);
    expect(JSON.stringify(event)).not.toContain(code);
  });

  it("a throwing onRequested hook is contained — the request still succeeds with its code file written", () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-auth-ui-throw-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const store = createAuthorizationStore({
      keypair,
      configDir,
      quiet: true,
      onRequested: () => {
        throw new Error("push exploded");
      },
    });
    const chunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let outcome: RequestOutcome;
    try {
      outcome = store.request(OFFER, { intent: "contained" });
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(outcome.authorization.status).toBe("pending");
    expect(codeOnDisk(configDir, outcome.authorization.id).length).toBeGreaterThanOrEqual(8);
    expect(chunks.join("")).toContain("approval push hook failed");
  });

  it("without an approvalUrl option, no browser line appears anywhere (channels unchanged)", () => {
    const { store, configDir } = makeStore();
    const outcome = store.request(OFFER, { intent: "no ui" });
    const codeFileBody = readFileSync(
      join(configDir, "pending-authorizations", `${outcome.authorization.id}.code`),
      "utf8",
    );
    expect(codeFileBody).not.toContain("in your browser");
    expect(outcome.fingerprint).toMatch(/^[0-9A-F]{4}$/);
  });

  it("sanitizes a write failure in request(): the thrown error names no filesystem path", () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-auth-fserr-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    // Force mkdirSync(pendingDir) to throw ENOTDIR/EEXIST: a FILE already
    // occupies the path request() needs to mkdir as a directory.
    const pendingDir = join(configDir, "pending-authorizations");
    writeFileSync(pendingDir, "not a directory");
    const store = createAuthorizationStore({ keypair, configDir, quiet: true });
    try {
      store.request(OFFER, { intent: "should fail closed" });
      expect.unreachable("expected request() to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(configDir);
      expect(message).not.toContain("pending-authorizations");
      expect(message.toLowerCase()).not.toMatch(/[a-z]:\\|\/[a-z0-9_.-]+\/[a-z0-9_.-]+/i);
    }
  });

  it("restart removes every stale pending code artifact so it cannot be approved or reused", () => {
    const { store, configDir } = makeStore();
    const issued = store.request(OFFER, { intent: "restart cleanup" });
    const codePath = join(configDir, "pending-authorizations", `${issued.authorization.id}.code`);
    expect(existsSync(codePath)).toBe(true);
    const restarted = createAuthorizationStore({ keypair: loadOrCreateMandateKeypair({ configDir }), configDir, quiet: true });
    expect(existsSync(codePath)).toBe(false);
    expect(restarted.approve(issued.authorization.id, "AAAA-BBBB")).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
