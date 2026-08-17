import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BrowserObservationSchema, rankOffers, trustKey, type Offer, type SearchRankResponse } from "@northcinder/protocol";
import { loadOrCreateMandateKeypair, type CheckoutOrchestrator, type OrderRecord } from "@northcinder/checkout";
import { startMockAcpMerchant, type MockAcpMerchant } from "@northcinder/checkout/mock-acp-merchant";
import { createAuditLog, readAuditPage } from "../src/audit-log.js";
import { createAuthorizationStore, type AuthorizationStore } from "../src/authorization.js";
import { createClientCheckout } from "../src/checkout-wiring.js";
import { createNorthCinderMcpServer } from "../src/server.js";
import { createOrderStore } from "../src/order-store.js";
import type { NorthCinderServiceClient } from "../src/service-client.js";
import { BRAND_NAME } from "../src/brand.js";

const ORGANIC_OFFER: Offer = {
  id: "item-1",
  product: { id: "item-1", title: "Wool Blend Sneaker", url: "https://mock-merchant.example/item-1", attributes: {} },
  price: { amount: 9800, currency: "USD" },
  merchant: { id: "mock-merchant.example", name: "Mock Merchant", domain: "mock-merchant.example" },
  availability: "in_stock",
  sourceStore: "ebay",
  sponsored: false,
};

const SPONSORED_WORSE_OFFER: Offer = {
  id: "demo-sponsored-offer-1",
  product: {
    id: "demo-sponsored-offer-1",
    title: "[DEMO sponsored placement] sneaker — synthetic paid listing",
    url: "https://demo-sponsored.invalid/offer/demo-sponsored-offer-1",
    attributes: {},
  },
  price: { amount: 1999, currency: "USD" }, // the CHEAPEST offer — must still rank last
  merchant: { id: "demo-sponsored.invalid", name: "Demo Sponsored Merchant", domain: "demo-sponsored.invalid" },
  availability: "in_stock",
  sourceStore: "demo-sponsored",
  sponsored: true,
};

function fakeService(): NorthCinderServiceClient {
  return {
    async search(query, options) {
      const parsedBrowserObservations = (options?.browserObservations ?? []).map((observation, index) => ({
        index,
        parsed: BrowserObservationSchema.safeParse(observation),
      }));
      const browserOffers: Offer[] = parsedBrowserObservations.flatMap(({ index, parsed }) => parsed.success ? [{
        id: `browser-observed-${index + 1}`,
        product: {
          id: `browser-product-${index + 1}`,
          title: parsed.data.title,
          url: parsed.data.productUrl,
          attributes: parsed.data.attributes ?? {},
        },
        price: parsed.data.price,
        merchant: {
          id: new URL(parsed.data.productUrl).hostname,
          name: parsed.data.merchantName,
          domain: new URL(parsed.data.productUrl).hostname,
        },
        availability: parsed.data.availability,
        sourceStore: "agent_browser",
        sponsored: parsed.data.placement !== "organic",
        fetchedAt: parsed.data.observedAt,
        acquisition: {
          kind: "agent_observed" as const,
          observedAt: parsed.data.observedAt,
          receivedAt: "2026-08-16T10:01:00.000Z",
          placement: parsed.data.placement,
        },
      }] : []);
      const trustSignals = {
        "mock-merchant.example": {
          merchantId: "mock-merchant.example",
          level: "unknown" as const,
          evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
        },
        "demo-sponsored.invalid": {
          merchantId: "demo-sponsored.invalid",
          level: "unknown" as const,
          evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
        },
        ...(browserOffers.length > 0
          ? {
              "shop.example": {
                merchantId: "shop.example",
                level: "unknown" as const,
                evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
              },
            }
          : {}),
      };
      const data: SearchRankResponse = {
        trustSignals,
        results: rankOffers([ORGANIC_OFFER, SPONSORED_WORSE_OFFER, ...browserOffers], query, { trust: trustSignals }),
        storeStatuses: [
          { store: "ebay", ok: true, offerCount: 1, durationMs: 12 },
          { store: "demo-sponsored", ok: true, offerCount: 1, durationMs: 1 },
          {
            store: "amazon",
            ok: false,
            error: { store: "amazon", code: "not_configured", message: "no user session profile", retryable: false },
            durationMs: 1,
          },
          ...(browserOffers.length > 0
            ? [{ store: "agent_browser", ok: true as const, offerCount: browserOffers.length, durationMs: 1 }]
            : []),
        ],
        ...(options?.browserObservations !== undefined && query.text !== "engine omits browser report"
          ? {
              browserObservationReport: {
                submitted: query.text === "engine miscounts browser report" ? 1 : parsedBrowserObservations.length,
                accepted: query.text === "engine miscounts browser report" ? 1 : browserOffers.length,
                rejected: parsedBrowserObservations.flatMap(({ index, parsed }) =>
                  parsed.success
                    ? []
                    : [{
                        index,
                        code: "invalid_observation" as const,
                        message: "observation does not match the browser handoff schema",
                      }],
                ),
              },
            }
          : {}),
      };
      return { ok: true, data };
    },
    async trust(merchant) {
      return {
        ok: true,
        data: {
          merchantId: merchant.id,
          level: "unknown",
          evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
        },
      };
    },
  };
}

describe("northcinder MCP server — full tool flow over a real MCP transport", () => {
  const configDir = mkdtempSync(join(tmpdir(), "northcinder-client-"));
  let merchant: MockAcpMerchant;
  let client: Client;
  let auditPath: string;

  beforeAll(async () => {
    merchant = await startMockAcpMerchant({
      catalog: { "item-1": { name: "Wool Blend Sneaker", unitAmount: 9800 } },
      apiKey: "mock_api_key",
    });
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const audit = createAuditLog(configDir);
    auditPath = audit.path;
    const checkout = createClientCheckout({
      configDir,
      trustedPublicKeys: [keypair.publicKeyB64],
      acpMerchants: { "mock-merchant.example": { baseUrl: merchant.baseUrl, apiKey: "mock_api_key" } },
      acpPaymentToken: "spt_test_delegated_token",
    });
    const server = createNorthCinderMcpServer({
      service: fakeService(),
      authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }),
      checkout: checkout.orchestrator,
      railFor: checkout.railFor,
      audit,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-host-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await merchant.close();
  });

  function auditLines(): Array<Record<string, unknown>> {
    return readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("tools/list exposes the buyer-agent browser handoff without claiming NorthCinder controls a browser", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "approve_purchase",
      "complete_checkout",
      "decline_purchase",
      "get_buyers_brief",
      "get_trust_signal",
      "request_purchase_authorization",
      "search_products",
      "submit_browser_observations",
    ]);
    const browserHandoff = tools.find((t) => t.name === "submit_browser_observations")!;
    expect(browserHandoff.description).toContain("browser tools you control");
    expect(browserHandoff.description).toContain("NorthCinder does not operate a browser");
    expect(browserHandoff.description).toContain("not eligible for automated checkout");
    const observationsSchema = (browserHandoff.inputSchema as {
      properties?: { observations?: { maxItems?: number } };
    }).properties?.observations;
    expect(observationsSchema?.maxItems).toBe(50);
    const reqAuth = tools.find((t) => t.name === "request_purchase_authorization")!;
    expect(reqAuth.description).toMatch(/NEVER/);
    expect(reqAuth.description!.toLowerCase()).toContain("human");
    const approve = tools.find((t) => t.name === "approve_purchase")!;
    expect(approve.description!.toLowerCase()).toContain("confirmation code");
    // Decline is FIRST-CLASS and symmetric: as available as approve, no guilt.
    const decline = tools.find((t) => t.name === "decline_purchase")!;
    expect(decline.description!.toLowerCase()).toContain("void");
    expect(decline.description).toContain("always available");
    expect(decline.description!.toLowerCase()).not.toContain("are you sure");
    for (const tool of tools) expect(tool.inputSchema).toBeDefined();
    for (const name of ["request_purchase_authorization", "approve_purchase", "decline_purchase", "complete_checkout"]) {
      const purchaseTool = tools.find((tool) => tool.name === name)!;
      expect((purchaseTool.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    }

    // complete_checkout must declare an outputSchema matching the order
    // record it actually returns (orderId, railId, status, mandateId, ...) —
    // not go without one like a fire-and-forget tool.
    const completeCheckout = tools.find((t) => t.name === "complete_checkout")!;
    expect(completeCheckout.outputSchema).toBeDefined();
    const orderSchemaProps = (completeCheckout.outputSchema as { properties?: Record<string, unknown> })
      .properties?.order as { properties?: Record<string, unknown> } | undefined;
    expect(orderSchemaProps?.properties).toBeDefined();
    const orderFields = Object.keys(orderSchemaProps!.properties!);
    for (const field of ["orderId", "railId", "status", "mandateId", "evidence"]) {
      expect(orderFields).toContain(field);
    }
  });

  it("tool descriptions route their brand mentions through BRAND_NAME, not a hardcoded literal", async () => {
    const { tools } = await client.listTools();
    const approve = tools.find((t) => t.name === "approve_purchase")!;
    expect(approve.description).toContain(`buyer-local ${BRAND_NAME} code file`);
    const requestAuth = tools.find((t) => t.name === "request_purchase_authorization")!;
    expect(requestAuth.description).toContain(`buyer-local ${BRAND_NAME} code file`);
    expect(requestAuth.description).toContain("standard-runtime stderr");
    const listOrders = tools.find((t) => t.name === "list_orders");
    if (listOrders) expect(listOrders.description).toContain(`${BRAND_NAME} checkouts`);

    // Static guard: the SOURCE must actually reference the constant (not just
    // happen to produce the same string value, since BRAND_NAME === "northcinder"
    // today) — the raw pre-migration literals must be gone from server.ts.
    const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(source).not.toContain("(northcinder server console");
    expect(source).not.toContain("their northcinder console");
    expect(source).not.toContain("northcinder server console / local");
    expect(source).not.toContain("your own northcinder checkouts");
    expect(source).not.toContain("outside northcinder with no email");
    expect(source).not.toContain(`${BRAND_NAME} server console`);
    expect(source).not.toMatch(/NORTHCINDER_MCP_SERVER_NAME = "northcinder"/);
  });

  it("search_products returns ranked results with reasons; the sponsored-worse (cheapest!) offer ranks LAST and labeled", async () => {
    const result = await client.callTool({
      name: "search_products",
      arguments: { text: "sneaker", maxResults: 5 },
    });
    expect(result.isError ?? false).toBe(false);
    const structured = result.structuredContent as SearchRankResponse;
    expect(structured.results).toHaveLength(2);
    expect(structured.results[0]!.offer.id).toBe("item-1");
    expect(structured.results[1]!.offer.id).toBe("demo-sponsored-offer-1");
    expect(structured.results[1]!.offer.sponsored).toBe(true);
    expect(structured.results[1]!.reasons.map((r) => r.criterion)).toContain("sponsored_deprioritization");
    expect((result.structuredContent as { browserHandoff?: unknown }).browserHandoff).toEqual({
      available: true,
      searchId: expect.stringMatching(/^search_/),
      submitTool: "submit_browser_observations",
    });
    // per-store status including the graceful Amazon degrade
    const amazon = structured.storeStatuses.find((s) => s.store === "amazon")!;
    expect(amazon.ok).toBe(false);

    const search = auditLines().find((l) => l.type === "search");
    expect(search).toBeDefined();
    expect(JSON.stringify(search)).toContain("sponsored_deprioritization");

    // ranking verification: the client recomputed the open ranking over the returned offers +
    // trust signals and it matched — recorded in output AND audit trail.
    expect((result.structuredContent as { rankingVerified: unknown }).rankingVerified).toBe(true);
    expect(search!.rankingVerified).toBe(true);
  });

  it("continues a known search with browser observations through one verified ranking, brief, and audit entry", async () => {
    const initial = await client.callTool({ name: "search_products", arguments: { text: "repairable sneaker" } });
    const initialContent = initial.structuredContent as {
      searchId: string;
      interpretedQuery: unknown;
    };

    const continued = await client.callTool({
      name: "submit_browser_observations",
      arguments: {
        searchId: initialContent.searchId,
        observations: [
          {
            productUrl: "https://shop.example/products/repairable-sneaker",
            title: "Repairable Sneaker",
            price: { amount: 7500, currency: "USD" },
            availability: "in_stock",
            merchantName: "Example Shop",
            placement: "organic",
            observedAt: "2026-08-16T10:00:00.000Z",
          },
        ],
      },
    });

    expect(continued.isError ?? false).toBe(false);
    const structured = continued.structuredContent as {
      searchId: string;
      continuedFrom: string;
      interpretedQuery: unknown;
      results: SearchRankResponse["results"];
      rankingVerified: boolean;
      browserObservationReport: { submitted: number; accepted: number; rejected: unknown[] };
      brief: { searchId: string; coverage: Array<{ store: string; status: string; offerCount: number }> };
    };
    expect(structured.searchId).toMatch(/^search_/);
    expect(structured.searchId).not.toBe(initialContent.searchId);
    expect(structured.continuedFrom).toBe(initialContent.searchId);
    expect(structured.interpretedQuery).toEqual(initialContent.interpretedQuery);
    expect(structured.results.some((result) => result.offer.sourceStore === "agent_browser")).toBe(true);
    expect(structured.rankingVerified).toBe(true);
    expect(structured.browserObservationReport).toEqual({ submitted: 1, accepted: 1, rejected: [] });
    expect(structured.brief.searchId).toBe(structured.searchId);
    expect(structured.brief.coverage).toContainEqual({ store: "agent_browser", status: "searched", offerCount: 1 });

    const audit = auditLines().find((entry) => entry.type === "search" && entry.searchId === structured.searchId);
    expect(audit?.continuedFrom).toBe(initialContent.searchId);
    expect(audit?.rankingVerified).toBe(true);
  });

  it("lets the buyer-run service report one malformed browser observation without hiding a valid item", async () => {
    const initial = await client.callTool({ name: "search_products", arguments: { text: "repairable phone" } });
    const searchId = (initial.structuredContent as { searchId: string }).searchId;
    const validObservation = {
      productUrl: "https://shop.example/products/fairphone-5",
      title: "Fairphone 5",
      price: { amount: 59900, currency: "EUR" },
      availability: "in_stock",
      merchantName: "Example Shop",
      placement: "organic",
      observedAt: "2026-08-16T10:00:00.000Z",
    };

    const continued = await client.callTool({
      name: "submit_browser_observations",
      arguments: {
        searchId,
        observations: [{ ...validObservation, score: 999, trust: "trusted" }, validObservation],
      },
    });

    expect(continued.isError ?? false).toBe(false);
    const structured = continued.structuredContent as {
      results: SearchRankResponse["results"];
      browserObservationReport: {
        submitted: number;
        accepted: number;
        rejected: Array<{ index: number; code: string; message: string }>;
      };
    };
    expect(structured.results.filter((result) => result.offer.sourceStore === "agent_browser")).toHaveLength(1);
    expect(structured.browserObservationReport).toEqual({
      submitted: 2,
      accepted: 1,
      rejected: [{ index: 0, code: "invalid_observation", message: "observation does not match the browser handoff schema" }],
    });
  });

  it("fails a browser handoff closed when a legacy engine omits the per-item report", async () => {
    const initial = await client.callTool({ name: "search_products", arguments: { text: "engine omits browser report" } });
    const searchId = (initial.structuredContent as { searchId: string }).searchId;
    const searchAuditCountBefore = auditLines().filter((entry) => entry.type === "search").length;

    const continued = await client.callTool({
      name: "submit_browser_observations",
      arguments: {
        searchId,
        observations: [
          {
            productUrl: "https://shop.example/products/fairphone-5",
            title: "Fairphone 5",
            price: { amount: 59900, currency: "EUR" },
            availability: "in_stock",
            merchantName: "Example Shop",
            placement: "organic",
            observedAt: "2026-08-16T10:00:00.000Z",
          },
        ],
      },
    });

    expect(continued.isError).toBe(true);
    expect(JSON.parse((continued.content as Array<{ text: string }>)[0]!.text)).toEqual({
      error: {
        code: "browser_handoff_unavailable",
        message: "configured engine returned an invalid browser observation report",
      },
    });
    expect(auditLines().filter((entry) => entry.type === "search")).toHaveLength(searchAuditCountBefore);
    expect(auditLines().some((entry) => entry.continuedFrom === searchId)).toBe(false);
  });

  it("fails a browser handoff closed when the engine report does not cover the forwarded batch", async () => {
    const initial = await client.callTool({ name: "search_products", arguments: { text: "engine miscounts browser report" } });
    const searchId = (initial.structuredContent as { searchId: string }).searchId;
    const searchAuditCountBefore = auditLines().filter((entry) => entry.type === "search").length;
    const observation = {
      productUrl: "https://shop.example/products/fairphone-5",
      title: "Fairphone 5",
      price: { amount: 59900, currency: "EUR" },
      availability: "in_stock",
      merchantName: "Example Shop",
      placement: "organic",
      observedAt: "2026-08-16T10:00:00.000Z",
    };

    const continued = await client.callTool({
      name: "submit_browser_observations",
      arguments: {
        searchId,
        observations: [observation, { ...observation, productUrl: "https://shop.example/products/fairphone-5-case" }],
      },
    });

    expect(continued.isError).toBe(true);
    expect(JSON.parse((continued.content as Array<{ text: string }>)[0]!.text)).toEqual({
      error: {
        code: "browser_handoff_unavailable",
        message: "configured engine returned an invalid browser observation report",
      },
    });
    expect(auditLines().filter((entry) => entry.type === "search")).toHaveLength(searchAuditCountBefore);
    expect(auditLines().some((entry) => entry.continuedFrom === searchId)).toBe(false);
  });

  it("labels unknown browser placement honestly in the human-readable continued-search result", async () => {
    const initial = await client.callTool({ name: "search_products", arguments: { text: "repairable sneaker" } });
    const searchId = (initial.structuredContent as { searchId: string }).searchId;
    const continued = await client.callTool({
      name: "submit_browser_observations",
      arguments: {
        searchId,
        observations: [
          {
            productUrl: "https://shop.example/products/unknown-placement-sneaker",
            title: "Unknown Placement Sneaker",
            price: { amount: 7500, currency: "USD" },
            availability: "in_stock",
            merchantName: "Example Shop",
            placement: "unknown",
            observedAt: "2026-08-16T10:00:00.000Z",
          },
        ],
      },
    });

    const text = (continued.content as Array<{ type: string; text: string }>)[0]!.text;
    const observedStart = text.indexOf("3. Unknown Placement Sneaker");
    const observedEnd = text.indexOf("\n\nStore statuses:", observedStart);
    const observedResult = text.slice(observedStart, observedEnd);
    expect(observedResult).toContain("PLACEMENT NOT CONFIRMED (de-prioritized)");
    expect(observedResult).toContain("placement not confirmed: treated like sponsored and ranked below confirmed organic offers");
    expect(observedResult).not.toContain("SPONSORED (de-prioritized)");
    expect(observedResult).not.toContain("sponsored listing: labeled");
  });

  it("refuses purchase authorization for an agent-observed offer before creating authorization state", async () => {
    const initial = await client.callTool({ name: "search_products", arguments: { text: "repairable sneaker" } });
    const initialSearchId = (initial.structuredContent as { searchId: string }).searchId;
    const continued = await client.callTool({
      name: "submit_browser_observations",
      arguments: {
        searchId: initialSearchId,
        observations: [
          {
            productUrl: "https://shop.example/products/repairable-sneaker",
            title: "Repairable Sneaker",
            price: { amount: 7500, currency: "USD" },
            availability: "in_stock",
            merchantName: "Example Shop",
            placement: "organic",
            observedAt: "2026-08-16T10:00:00.000Z",
          },
        ],
      },
    });
    const browserOffer = (continued.structuredContent as SearchRankResponse).results.find(
      (result) => result.offer.sourceStore === "agent_browser",
    )!.offer;

    const authorization = await client.callTool({
      name: "request_purchase_authorization",
      arguments: { offerId: browserOffer.id, sourceStore: browserOffer.sourceStore },
    });

    expect(authorization.isError).toBe(true);
    const error = JSON.parse((authorization.content as Array<{ text: string }>)[0]!.text).error as {
      code: string;
      productUrl: string;
    };
    expect(error).toMatchObject({
      code: "native_revalidation_required",
      productUrl: "https://shop.example/products/repairable-sneaker",
    });
    expect(
      auditLines().some(
        (entry) => entry.type === "authorization_requested" && entry.offerId === browserOffer.id,
      ),
    ).toBe(false);
  });

  it("persists recommendation reasons so a freshly reopened audit reader sees the exact ranking evidence", async () => {
    await client.callTool({ name: "search_products", arguments: { text: "durable audit reasons" } });
    // This is deliberately a new reader, not the server's in-memory result:
    // it models the audit browser after a client process restart.
    const reopened = readAuditPage(auditPath, { pageSize: 100 });
    const search = reopened.entries.find((entry) => entry.type === "search") as { ranking?: Array<{ reasons?: Array<{ criterion: string }> }> } | undefined;
    expect(search?.ranking?.[0]?.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ criterion: "price" })]));
    expect(search?.ranking?.[1]?.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ criterion: "sponsored_deprioritization" })]));
  });

  it("get_trust_signal returns the trust signal with evidence", async () => {
    const result = await client.callTool({
      name: "get_trust_signal",
      arguments: { merchant: { id: "mock-merchant.example", name: "Mock Merchant", domain: "mock-merchant.example" } },
    });
    const structured = result.structuredContent as { level: string; evidence: Array<{ detail: string }> };
    expect(structured.level).toBe("unknown");
    expect(structured.evidence[0]!.detail).toContain("seed trust list");
  });

  it("request_purchase_authorization creates a PENDING authorization and never leaks the code", async () => {
    const result = await client.callTool({
      name: "request_purchase_authorization",
      arguments: { offerId: "item-1", intent: "Buy the Wool Blend Sneaker for testing" },
    });
    expect(result.isError ?? false).toBe(false);
    const structured = result.structuredContent as { authorizationId: string; status: string };
    expect(structured.status).toBe("pending");

    const codeFilePath = join(configDir, "pending-authorizations", `${structured.authorizationId}.code`);
    const codeFileBody = readFileSync(codeFilePath, "utf8");
    const code = codeFileBody.split("\n")[0]!.trim();
    // Neither the code NOR the code file's location may reach the host agent:
    // A file-capable host must not be handed a path to read.
    expect(JSON.stringify(result)).not.toContain(code);
    expect(JSON.stringify(result)).not.toContain(codeFilePath);
    expect(JSON.stringify(result)).not.toContain(configDir);

    // approval: the trusted channel carries the four-tuple with the RIGHT payment
    // context (this merchant is ACP-mapped) and the order fingerprint WITH
    // the code — while the tool result carries NEITHER the fingerprint string
    // nor any fingerprint field (display-binding only, never agent-usable).
    expect(codeFileBody).toContain("Payment:   delegated token via ACP");
    expect(codeFileBody).toContain("checkout is REFUSED unless the merchant's pre-payment total equals this amount exactly");
    const fingerprint = codeFileBody.match(/order-fingerprint ([0-9A-F]{4})/)?.[1];
    expect(fingerprint).toBeDefined();
    expect(JSON.stringify(result)).not.toMatch(/fingerprint/i);

    // The fingerprint is USELESS as a code: presenting it is just a wrong code.
    const fpAsCode = await client.callTool({
      name: "approve_purchase",
      arguments: { authorizationId: structured.authorizationId, confirmationCode: fingerprint },
    });
    expect(fpAsCode.isError).toBe(true);
    expect(JSON.stringify(fpAsCode.content)).toContain("code_mismatch");

    // wrong code → structured denial
    const wrong = await client.callTool({
      name: "approve_purchase",
      arguments: { authorizationId: structured.authorizationId, confirmationCode: "XXXX-XXXX" },
    });
    expect(wrong.isError).toBe(true);
    expect(JSON.stringify(wrong.content)).toContain("code_mismatch");

    // complete_checkout before approval is refused
    const early = await client.callTool({
      name: "complete_checkout",
      arguments: { authorizationId: structured.authorizationId },
    });
    expect(early.isError).toBe(true);
    expect(JSON.stringify(early.content)).toContain("not_approved");

    // the user's out-of-band code approves; a signed mandate appears
    const approved = await client.callTool({
      name: "approve_purchase",
      arguments: { authorizationId: structured.authorizationId, confirmationCode: code },
    });
    expect(approved.isError ?? false).toBe(false);
    const approvedStructured = approved.structuredContent as { status: string; mandateId: string };
    expect(approvedStructured.status).toBe("approved");
    expect(approvedStructured.mandateId).toMatch(/^mandate_/);

    // checkout completes through the mandate gate against the mock ACP merchant
    const checkout = await client.callTool({
      name: "complete_checkout",
      arguments: { authorizationId: structured.authorizationId },
    });
    expect(checkout.isError ?? false).toBe(false);
    const order = checkout.structuredContent as {
      order: { railId: string; status: string; evidence: { rail: string; orderId?: string; totalCharged?: { amount: number } } };
    };
    expect(order.order.railId).toBe("acp");
    expect(order.order.status).toBe("completed");
    expect(order.order.evidence.orderId).toMatch(/^ord_/);
    expect(order.order.evidence.totalCharged).toEqual({ amount: 9800, currency: "USD" });

    // the merchant saw a delegated token, never a card number
    const completeReq = merchant.requests.find((r) => r.path.endsWith("/complete"))!;
    expect(completeReq.rawBody).toContain("spt_test_delegated_token");
    expect(/\d{13,19}/.test(completeReq.rawBody)).toBe(false);

    // a second complete_checkout on the same authorization is refused
    const again = await client.callTool({
      name: "complete_checkout",
      arguments: { authorizationId: structured.authorizationId },
    });
    expect(again.isError).toBe(true);
    expect(JSON.stringify(again.content)).toContain("consumed");

    // audit trail has the full lifecycle
    const types = auditLines().map((l) => l.type);
    expect(types).toContain("authorization_requested");
    expect(types).toContain("authorization_denied");
    expect(types).toContain("authorization_approved");
    expect(types).toContain("checkout_attempt");
    expect(types).toContain("checkout_result");
    const approvedLine = auditLines().find((l) => l.type === "authorization_approved")!;
    expect(approvedLine.mandateId).toMatch(/^mandate_/);
  });

  it("rejects raw-card fields at complete_checkout before any effect and preserves the approved authorization", async () => {
    await client.callTool({ name: "search_products", arguments: { text: "strict checkout input" } });
    const requested = await client.callTool({
      name: "request_purchase_authorization",
      arguments: { offerId: "item-1", sourceStore: "ebay", intent: "strict MCP input regression" },
    });
    const { authorizationId } = requested.structuredContent as { authorizationId: string };
    const code = readFileSync(join(configDir, "pending-authorizations", `${authorizationId}.code`), "utf8")
      .split("\n")[0]!
      .trim();
    const approved = await client.callTool({
      name: "approve_purchase",
      arguments: { authorizationId, confirmationCode: code },
    });
    expect(approved.isError ?? false).toBe(false);

    const completionCount = () => merchant.requests.filter((request) => request.path.endsWith("/complete")).length;
    const completionsBefore = completionCount();
    const auditBefore = readFileSync(auditPath, "utf8");
    const rawPan = "4111".repeat(4);
    const rawCvv = ["1", "2", "3"].join("");
    const rejected = await client.callTool({
      name: "complete_checkout",
      arguments: { authorizationId, cardNumber: rawPan, cvv: rawCvv },
    });

    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.content)).toContain("Input validation error");
    expect(JSON.stringify(rejected)).not.toContain(rawPan);
    expect(JSON.stringify(rejected)).not.toContain(rawCvv);
    expect(completionCount()).toBe(completionsBefore);
    expect(readFileSync(auditPath, "utf8")).toBe(auditBefore);

    const legitimate = await client.callTool({ name: "complete_checkout", arguments: { authorizationId } });
    expect(legitimate.isError ?? false).toBe(false);
    expect(completionCount()).toBe(completionsBefore + 1);
    const completeRequest = merchant.requests.filter((request) => request.path.endsWith("/complete")).at(-1)!;
    expect(completeRequest.rawBody).toContain("spt_test_delegated_token");
    expect(completeRequest.rawBody).not.toContain(rawPan);
    expect(completeRequest.rawBody).not.toContain(rawCvv);
  });

  it("rejects unexpected nested payment fields before creating purchase authorization state", async () => {
    await client.callTool({ name: "search_products", arguments: { text: "strict nested authorization input" } });
    const pendingDir = join(configDir, "pending-authorizations");
    const pendingNames = () => (existsSync(pendingDir) ? readdirSync(pendingDir).sort() : []);
    const auditBefore = readFileSync(auditPath, "utf8");
    const pendingBefore = pendingNames();
    const rawPan = "4111".repeat(4);
    const rawCvv = ["7", "3", "1"].join("");

    const rejected = await client.callTool({
      name: "request_purchase_authorization",
      arguments: {
        offerId: "item-1",
        sourceStore: "ebay",
        intent: "strict nested MCP input regression",
        maxAmount: { amount: 9800, currency: "USD", cardNumber: rawPan, cvv: rawCvv },
      },
    });
    const auditAfterRejected = readFileSync(auditPath, "utf8");
    const pendingAfterRejected = pendingNames();
    const legitimate = await client.callTool({
      name: "request_purchase_authorization",
      arguments: {
        offerId: "item-1",
        sourceStore: "ebay",
        intent: "legitimate request after nested rejection",
        maxAmount: { amount: 9800, currency: "USD" },
      },
    });
    const pendingAfterLegitimate = pendingNames();
    const requestTool = (await client.listTools()).tools.find((tool) => tool.name === "request_purchase_authorization")!;
    const maxAmountSchema = (requestTool.inputSchema as { properties?: Record<string, unknown> }).properties?.maxAmount as
      | { additionalProperties?: unknown }
      | undefined;
    const rejectedWire = JSON.stringify(rejected);

    expect({
      nestedAdditionalProperties: maxAmountSchema?.additionalProperties,
      rejectedAsInputError: rejected.isError === true && rejectedWire.includes("Input validation error"),
      rejectedWithoutEcho: !rejectedWire.includes(rawPan) && !rejectedWire.includes(rawCvv),
      auditUnchangedBeforeHandler: auditAfterRejected === auditBefore,
      pendingDeltaAfterRejected: pendingAfterRejected.length - pendingBefore.length,
      legitimateStillWorks: legitimate.isError !== true,
      pendingDeltaAfterLegitimate: pendingAfterLegitimate.length - pendingBefore.length,
    }).toEqual({
      nestedAdditionalProperties: false,
      rejectedAsInputError: true,
      rejectedWithoutEcho: true,
      auditUnchangedBeforeHandler: true,
      pendingDeltaAfterRejected: 0,
      legitimateStillWorks: true,
      pendingDeltaAfterLegitimate: 1,
    });
  });

  it("request_purchase_authorization validates maxAmount BEFORE consuming the human's attention", async () => {
    // currency mismatch with the offer
    const wrongCurrency = await client.callTool({
      name: "request_purchase_authorization",
      arguments: { offerId: "item-1", intent: "x", maxAmount: { amount: 99999, currency: "EUR" } },
    });
    expect(wrongCurrency.isError).toBe(true);
    expect(JSON.stringify(wrongCurrency.content)).toContain("invalid_max_amount");
    expect(JSON.stringify(wrongCurrency.content)).toContain("EUR");

    // cap below the offer total — a mandate that could never verify
    const tooLow = await client.callTool({
      name: "request_purchase_authorization",
      arguments: { offerId: "item-1", intent: "x", maxAmount: { amount: 100, currency: "USD" } },
    });
    expect(tooLow.isError).toBe(true);
    expect(JSON.stringify(tooLow.content)).toContain("invalid_max_amount");
    expect(JSON.stringify(tooLow.content)).toContain("9800");
  });

  it("request_purchase_authorization for an offer never seen in a search is refused", async () => {
    const result = await client.callTool({
      name: "request_purchase_authorization",
      arguments: { offerId: "never-searched-offer", intent: "x" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("unknown_offer");
  });

  it("decline_purchase voids the pending authorization, is audited, and blocks approval + checkout afterwards", async () => {
    const requested = await client.callTool({
      name: "request_purchase_authorization",
      arguments: { offerId: "item-1", intent: "Buy, then change my mind" },
    });
    expect(requested.isError ?? false).toBe(false);
    const { authorizationId } = requested.structuredContent as { authorizationId: string };
    const codeFilePath = join(configDir, "pending-authorizations", `${authorizationId}.code`);
    const code = readFileSync(codeFilePath, "utf8").split("\n")[0]!.trim();

    const declined = await client.callTool({
      name: "decline_purchase",
      arguments: { authorizationId },
    });
    expect(declined.isError ?? false).toBe(false);
    const declinedStructured = declined.structuredContent as { authorizationId: string; status: string };
    expect(declinedStructured.status).toBe("declined");
    // Symmetric, guilt-free copy: a clean outcome, nothing bought, nothing owed.
    const text = JSON.stringify(declined.content);
    expect(text).toContain("Nothing was purchased");
    expect(text).not.toMatch(/are you sure|regret|missed/i);

    // The one-time code file is gone, and even the REAL code can no longer approve.
    expect(existsSync(codeFilePath)).toBe(false);
    const approveAfter = await client.callTool({
      name: "approve_purchase",
      arguments: { authorizationId, confirmationCode: code },
    });
    expect(approveAfter.isError).toBe(true);
    const checkoutAfter = await client.callTool({
      name: "complete_checkout",
      arguments: { authorizationId },
    });
    expect(checkoutAfter.isError).toBe(true);

    // Audited as a first-class event.
    const declineLine = auditLines().find((l) => l.type === "authorization_declined")!;
    expect(declineLine).toBeDefined();
    expect(declineLine.authorizationId).toBe(authorizationId);
    expect(declineLine.offerId).toBe("item-1");
  });

  it("declining an unknown authorization is a structured not_found", async () => {
    const result = await client.callTool({
      name: "decline_purchase",
      arguments: { authorizationId: "auth_nope" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not_found");
  });

  it("approving an unknown authorization is audited as authorization_not_found, NOT authorization_denied (a genuine denial, e.g. wrong code, is a different event)", async () => {
    const result = await client.callTool({
      name: "approve_purchase",
      arguments: { authorizationId: "auth_nope", confirmationCode: "XXXX-XXXX" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not_found");

    const notFoundLine = auditLines().find(
      (l) => l.type === "authorization_not_found" && l.authorizationId === "auth_nope",
    );
    expect(notFoundLine).toBeDefined();
    // Never miscategorized as a denial — a nonexistent authorization was
    // never denied, it never existed to begin with.
    expect(
      auditLines().some((l) => l.type === "authorization_denied" && l.authorizationId === "auth_nope"),
    ).toBe(false);
  });
});

describe("approval regression — decline cannot race an in-flight checkout", () => {
  it("decline during a slow rail execution is refused (structured checkout_in_progress) and the charge is audited exactly once", async () => {
    const raceConfigDir = mkdtempSync(join(tmpdir(), "northcinder-race-"));
    const keypair = loadOrCreateMandateKeypair({ configDir: raceConfigDir });
    const audit = createAuditLog(raceConfigDir);
    const store = createAuthorizationStore({ keypair, configDir: raceConfigDir, quiet: true });

    // A deliberately SLOW orchestrator: the charge is mid-flight for 150ms.
    const slowCheckout: CheckoutOrchestrator = {
      async completeCheckout(offer, mandate) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return {
          ok: true,
          order: {
            orderId: "order_race_1",
            createdAt: new Date().toISOString(),
            offerId: offer.id,
            merchantId: offer.merchant.id,
            merchantDomain: offer.merchant.domain,
            railId: "acp",
            status: "completed",
            mandateId: mandate.id,
            mandate,
            evidence: {
              rail: "acp",
              merchantBaseUrl: "http://mock.invalid",
              checkoutSessionId: "cs_race_1",
              orderId: "ord_race_1",
              totalCharged: offer.price,
            },
          },
        };
      },
    };

    const server = createNorthCinderMcpServer({ service: fakeService(), authorizations: store, checkout: slowCheckout, audit });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const raceClient = new Client({ name: "race-host-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), raceClient.connect(clientTransport)]);

    await raceClient.callTool({ name: "search_products", arguments: { text: "sneaker" } });
    const requested = await raceClient.callTool({
      name: "request_purchase_authorization",
      arguments: { offerId: "item-1", sourceStore: "ebay", intent: "race test" },
    });
    const { authorizationId } = requested.structuredContent as { authorizationId: string };
    const code = readFileSync(join(raceConfigDir, "pending-authorizations", `${authorizationId}.code`), "utf8")
      .split("\n")[0]!
      .trim();
    const approved = await raceClient.callTool({
      name: "approve_purchase",
      arguments: { authorizationId, confirmationCode: code },
    });
    expect(approved.isError ?? false).toBe(false);

    // Start checkout, then decline WHILE the rail is executing.
    const checkoutPromise = raceClient.callTool({ name: "complete_checkout", arguments: { authorizationId } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const declined = await raceClient.callTool({ name: "decline_purchase", arguments: { authorizationId } });
    expect(declined.isError).toBe(true);
    // Honest, structured refusal — never "nothing will be charged" while a charge is completing.
    expect(JSON.stringify(declined.content)).toContain("checkout_in_progress");
    expect(JSON.stringify(declined.content)).not.toContain("nothing will be charged");

    const checkout = await checkoutPromise;
    expect(checkout.isError ?? false).toBe(false);

    // The completed charge got its audit line — EXACTLY once — and no
    // authorization_declined line contradicts it.
    const lines = readFileSync(audit.path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const results = lines.filter((l) => l.type === "checkout_result" && l.authorizationId === authorizationId);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(lines.some((l) => l.type === "authorization_declined" && l.authorizationId === authorizationId)).toBe(false);

    // After the checkout attempt, decline reports already_consumed — the
    // race window is closed on both sides.
    const late = await raceClient.callTool({ name: "decline_purchase", arguments: { authorizationId } });
    expect(late.isError).toBe(true);
    expect(JSON.stringify(late.content)).toContain("already_consumed");
  });

  it("makes an ACP completion charge drift loud in text and durable in the audit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "northcinder-charge-drift-"));
    const keypair = loadOrCreateMandateKeypair({ configDir: dir });
    const audit = createAuditLog(dir);
    const authorizations = createAuthorizationStore({ keypair, configDir: dir, quiet: true });
    const driftCheckout: CheckoutOrchestrator = { async completeCheckout(offer, mandate) { return { ok: true, order: { orderId: "order_drift", createdAt: new Date().toISOString(), offerId: offer.id, merchantId: offer.merchant.id, merchantDomain: offer.merchant.domain, railId: "acp", status: "completed", mandateId: mandate.id, mandate, evidence: { rail: "acp", merchantBaseUrl: "http://mock.invalid", checkoutSessionId: "cs", orderId: "merchant-order", totalCharged: { amount: 9900, currency: "USD" } } } }; } };
    const server = createNorthCinderMcpServer({ service: fakeService(), authorizations, checkout: driftCheckout, audit });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "drift-test", version: "0.0.1" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    await client.callTool({ name: "search_products", arguments: { text: "sneaker" } });
    const requested = await client.callTool({ name: "request_purchase_authorization", arguments: { offerId: "item-1", sourceStore: "ebay" } });
    const { authorizationId } = requested.structuredContent as { authorizationId: string };
    const code = readFileSync(join(dir, "pending-authorizations", `${authorizationId}.code`), "utf8").split("\n")[0]!.trim();
    await client.callTool({ name: "approve_purchase", arguments: { authorizationId, confirmationCode: code } });
    const completed = await client.callTool({ name: "complete_checkout", arguments: { authorizationId } });
    const text = (completed.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("WARNING: merchant reported a completion charge of 99.00 USD");
    expect(text).toContain("authorized quoted total of 98.00 USD");
    expect(text).not.toContain("9900 USD");
    const events = readFileSync(audit.path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(expect.objectContaining({ type: "charge_drift_warning", authorizationId, quotedTotal: { amount: 9800, currency: "USD" }, chargedTotal: { amount: 9900, currency: "USD" } }));
    await client.close();
  });
});

describe("request_purchase_authorization refuses an offer with unrepresentable (cross-currency) shipping", () => {
  it("REFUSES rather than silently authorizing a total that drops the shipping cost", async () => {
    const mismatchedConfigDir = mkdtempSync(join(tmpdir(), "northcinder-mismatched-shipping-"));
    const keypair = loadOrCreateMandateKeypair({ configDir: mismatchedConfigDir });
    const audit = createAuditLog(mismatchedConfigDir);
    const store = createAuthorizationStore({ keypair, configDir: mismatchedConfigDir, quiet: true });

    const mismatchedOffer: Offer = {
      id: "item-mismatched-shipping",
      product: {
        id: "item-mismatched-shipping",
        title: "Cross-border Gadget",
        url: "https://mock-merchant.example/item-mismatched-shipping",
        attributes: {},
      },
      price: { amount: 5000, currency: "USD" },
      shipping: { cost: { amount: 300, currency: "EUR" } }, // different currency than price
      merchant: { id: "mock-merchant.example", name: "Mock Merchant", domain: "mock-merchant.example" },
      availability: "in_stock",
      sourceStore: "ebay",
      sponsored: false,
    };
    const mismatchedService: NorthCinderServiceClient = {
      async search() {
        return {
          ok: true,
          data: {
            trustSignals: {},
            results: rankOffers([mismatchedOffer], { text: "gadget" }, { trust: {} }),
            storeStatuses: [{ store: "ebay", ok: true, offerCount: 1, durationMs: 1 }],
          },
        };
      },
      async trust(merchant) {
        return { ok: true, data: { merchantId: merchant.id, level: "unknown", evidence: [{ source: "x", detail: "x" }] } };
      },
    };
    const checkout: CheckoutOrchestrator = {
      async completeCheckout() {
        throw new Error("must never be reached — authorization creation must be refused first");
      },
    };

    const server = createNorthCinderMcpServer({ service: mismatchedService, authorizations: store, checkout, audit });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mismatchedClient = new Client({ name: "mismatched-shipping-host", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), mismatchedClient.connect(clientTransport)]);

    await mismatchedClient.callTool({ name: "search_products", arguments: { text: "gadget" } });
    const result = await mismatchedClient.callTool({
      name: "request_purchase_authorization",
      arguments: { offerId: "item-mismatched-shipping", intent: "buy the gadget" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/shipping/i);
    expect(JSON.stringify(result.content)).toMatch(/currency/i);
    // No pending authorization/code file was ever created for this offer.
    expect(existsSync(join(mismatchedConfigDir, "pending-authorizations"))).toBe(false);
  });
});

describe("local trust evidence — client-local trust evidence wiring (display-only)", () => {
  /** No authorization/checkout tools are exercised here — search + trust only, so bare stubs suffice. */
  const NOOP_AUTHORIZATIONS = {} as AuthorizationStore;
  const NOOP_CHECKOUT: CheckoutOrchestrator = {
    async completeCheckout() {
      throw new Error("not used by this suite");
    },
  };

  function completedOrderFor(merchantId: string, merchantDomain = "mock-merchant.example"): OrderRecord {
    return {
      orderId: "order_1",
      createdAt: "2026-06-01T00:00:00.000Z",
      offerId: "item-1",
      merchantId,
      merchantDomain,
      railId: "acp",
      status: "completed",
      mandateId: "mandate_1",
      mandate: {} as OrderRecord["mandate"],
      evidence: { rail: "acp" } as unknown as OrderRecord["evidence"],
    };
  }

  it("get_trust_signal appends LOCAL evidence (source local-orders) after a completed local checkout, distinct from service evidence", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-trust-local-"));
    const orders = createOrderStore(configDir);
    orders.append(completedOrderFor("mock-merchant.example"));
    const audit = createAuditLog(configDir);
    const server = createNorthCinderMcpServer({
      service: fakeService(),
      authorizations: NOOP_AUTHORIZATIONS,
      checkout: NOOP_CHECKOUT,
      audit,
      orders,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-host", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "get_trust_signal",
      arguments: { merchant: { id: "mock-merchant.example", name: "Mock Merchant", domain: "mock-merchant.example" } },
    });
    const structured = result.structuredContent as { level: string; evidence: Array<{ source: string; detail: string }> };
    // Service evidence is preserved verbatim (unshifted, not overwritten).
    expect(structured.evidence[0]!.source).toBe("seed-list");
    // Local evidence is APPENDED, separately attributed.
    const local = structured.evidence.find((e) => e.source === "local-orders");
    expect(local).toBeDefined();
    expect(local!.detail).toBe("your history: 1 completed order from this merchant (local orders)");
    // The rendered text visually separates the two sections.
    const text = JSON.stringify(result.content);
    expect(text).toContain("Service evidence:");
    expect(text).toContain("Your local history:");
  });

  it("get_trust_signal without any local order history renders NO local section (absence is never asserted)", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-trust-local-empty-"));
    const orders = createOrderStore(configDir);
    const audit = createAuditLog(configDir);
    const server = createNorthCinderMcpServer({
      service: fakeService(),
      authorizations: NOOP_AUTHORIZATIONS,
      checkout: NOOP_CHECKOUT,
      audit,
      orders,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-host", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "get_trust_signal",
      arguments: { merchant: { id: "mock-merchant.example", name: "Mock Merchant", domain: "mock-merchant.example" } },
    });
    const structured = result.structuredContent as { evidence: Array<{ source: string }> };
    expect(structured.evidence.some((e) => e.source === "local-orders")).toBe(false);
    expect(JSON.stringify(result.content)).not.toContain("Your local history");
  });

  it("search_products carries localTrustEvidence as a SIBLING of brief, keyed by collision-safe trust key, only when local history exists", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-trust-local-brief-"));
    const orders = createOrderStore(configDir);
    orders.append(completedOrderFor("mock-merchant.example"));
    const audit = createAuditLog(configDir);
    const server = createNorthCinderMcpServer({
      service: fakeService(),
      authorizations: NOOP_AUTHORIZATIONS,
      checkout: NOOP_CHECKOUT,
      audit,
      orders,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-host", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: "search_products", arguments: { text: "sneaker", maxResults: 5 } });
    const structured = result.structuredContent as {
      localTrustEvidence?: Record<string, Array<{ source: string; detail: string }>>;
    };
    expect(structured.localTrustEvidence).toBeDefined();
    expect(structured.localTrustEvidence!["mock-merchant.example"]).toBeDefined();
    expect(structured.localTrustEvidence!["mock-merchant.example"]![0]!.source).toBe("local-orders");
    // The other finalist's merchant (never bought from) has no entry.
    expect(structured.localTrustEvidence!["demo-sponsored.invalid"]).toBeUndefined();
  });

  it("keeps same-id merchants collision-safe through search output, widget keys, and get_trust_signal shorthand", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-trust-local-collision-"));
    const orders = createOrderStore(configDir);
    orders.append(completedOrderFor("seller-1", "alpha.example"));
    const alpha: Offer = { ...ORGANIC_OFFER, id: "alpha-offer", sourceStore: "alpha", merchant: { id: "seller-1", name: "Alpha", domain: "alpha.example" } };
    const beta: Offer = { ...SPONSORED_WORSE_OFFER, id: "beta-offer", sourceStore: "beta", sponsored: false, merchant: { id: "seller-1", name: "Beta", domain: "beta.example" } };
    const collisionService: NorthCinderServiceClient = {
      async search(query) {
        const trustSignals = {
          [trustKey(alpha.merchant)]: { merchantId: alpha.merchant.id, level: "unknown" as const, evidence: [{ source: "seed-list", detail: "alpha" }] },
          [trustKey(beta.merchant)]: { merchantId: beta.merchant.id, level: "unknown" as const, evidence: [{ source: "seed-list", detail: "beta" }] },
        };
        return { ok: true, data: { trustSignals, results: rankOffers([alpha, beta], query, { trust: trustSignals }), storeStatuses: [
          { store: "alpha", ok: true as const, offerCount: 1, durationMs: 1 }, { store: "beta", ok: true as const, offerCount: 1, durationMs: 1 },
        ] } };
      },
      async trust(merchant) { return { ok: true, data: { merchantId: merchant.id, level: "unknown" as const, evidence: [{ source: "seed-list", detail: merchant.domain }] } }; },
    };
    const server = createNorthCinderMcpServer({ service: collisionService, authorizations: NOOP_AUTHORIZATIONS, checkout: NOOP_CHECKOUT, audit: createAuditLog(configDir), orders });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "collision-test", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const search = await client.callTool({ name: "search_products", arguments: { text: "sneaker" } });
    const structured = search.structuredContent as {
      localTrustEvidence?: Record<string, Array<{ source: string }>>;
      localTrustEvidenceKeys?: Record<string, string>;
    };
    expect(structured.localTrustEvidence?.["alpha.example#seller-1"]?.[0]?.source).toBe("local-orders");
    expect(structured.localTrustEvidence?.["beta.example#seller-1"]).toBeUndefined();
    expect(structured.localTrustEvidenceKeys?.["alpha:alpha-offer"]).toBe("alpha.example#seller-1");
    expect(structured.localTrustEvidenceKeys?.["beta:beta-offer"]).toBe("beta.example#seller-1");

    const ambiguous = await client.callTool({ name: "get_trust_signal", arguments: { merchantId: "seller-1" } });
    expect(ambiguous.isError).toBe(true);
    const betaTrust = await client.callTool({ name: "get_trust_signal", arguments: { merchant: beta.merchant } });
    expect(JSON.stringify(betaTrust.structuredContent)).not.toContain("local-orders");
  });

  it("THE LOAD-BEARING TEST: structuredContent.results and rankingVerified are BYTE-IDENTICAL whether or not local order history exists for the searched merchant", async () => {
    // Server A: no local order history at all (no `orders` dep configured).
    const configDirA = mkdtempSync(join(tmpdir(), "northcinder-trust-loadbearing-a-"));
    const auditA = createAuditLog(configDirA);
    const serverA = createNorthCinderMcpServer({
      service: fakeService(),
      authorizations: NOOP_AUTHORIZATIONS,
      checkout: NOOP_CHECKOUT,
      audit: auditA,
    });
    const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
    const clientA = new Client({ name: "test-host-a", version: "0.0.1" });
    await Promise.all([serverA.connect(serverTransportA), clientA.connect(clientTransportA)]);

    // Server B: SAME service/fixtures, but WITH a completed local purchase
    // history for the very merchant this search returns.
    const configDirB = mkdtempSync(join(tmpdir(), "northcinder-trust-loadbearing-b-"));
    const ordersB = createOrderStore(configDirB);
    ordersB.append(completedOrderFor("mock-merchant.example"));
    const auditB = createAuditLog(configDirB);
    const serverB = createNorthCinderMcpServer({
      service: fakeService(),
      authorizations: NOOP_AUTHORIZATIONS,
      checkout: NOOP_CHECKOUT,
      audit: auditB,
      orders: ordersB,
    });
    const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
    const clientB = new Client({ name: "test-host-b", version: "0.0.1" });
    await Promise.all([serverB.connect(serverTransportB), clientB.connect(clientTransportB)]);

    const [resultA, resultB] = await Promise.all([
      clientA.callTool({ name: "search_products", arguments: { text: "sneaker", maxResults: 5 } }),
      clientB.callTool({ name: "search_products", arguments: { text: "sneaker", maxResults: 5 } }),
    ]);
    const structuredA = resultA.structuredContent as { results: unknown; rankingVerified: unknown };
    const structuredB = resultB.structuredContent as { results: unknown; rankingVerified: unknown };

    // The load-bearing property: local history changes localTrustEvidence
    // ONLY — never results, never the ranking-verification outcome.
    expect(JSON.stringify(structuredA.results)).toBe(JSON.stringify(structuredB.results));
    expect(structuredA.rankingVerified).toBe(structuredB.rankingVerified);
    expect(structuredB.rankingVerified).toBe(true);

    // Sanity: the two runs really did differ in local history (otherwise
    // this test would trivially pass without proving anything).
    const structuredBFull = resultB.structuredContent as { localTrustEvidence?: Record<string, unknown> };
    const structuredAFull = resultA.structuredContent as { localTrustEvidence?: Record<string, unknown> };
    expect(structuredBFull.localTrustEvidence).toBeDefined();
    expect(structuredAFull.localTrustEvidence).toBeUndefined();
  });
});
