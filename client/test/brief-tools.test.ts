import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  BuyersBriefSchema,
  rankOffers,
  type BuyersBrief,
  type DecisionReadiness,
  type Offer,
  type SearchRankResponse,
  type TrustSignal,
} from "@northcinder/protocol";
import { loadOrCreateMandateKeypair } from "@northcinder/checkout";
import { createAuditLog } from "../src/audit-log.js";
import { createAuthorizationStore } from "../src/authorization.js";
import { createClientCheckout } from "../src/checkout-wiring.js";
import { BRIEF_WIDGET_MIME, BRIEF_WIDGET_URI } from "../src/brief-widget.js";
import { createNorthCinderMcpServer } from "../src/server.js";
import type { NorthCinderServiceClient } from "../src/service-client.js";

const FETCHED_AT = "2026-07-04T09:00:00.000Z";

function offer(id: string, amount: number, opts: { sponsored?: boolean } = {}): Offer {
  return {
    id,
    product: { id: `p-${id}`, title: `Wool Runner ${id}`, url: `https://ebay.example/p/${id}`, attributes: {} },
    price: { amount, currency: "USD" },
    merchant: { id: `${id}-shop.example`, name: `Shop ${id}`, domain: `${id}-shop.example` },
    availability: "in_stock",
    sourceStore: "ebay",
    sponsored: opts.sponsored ?? false,
    fetchedAt: FETCHED_AT,
  };
}

const OFFERS = [offer("o1", 9800), offer("o2", 10500), offer("o3", 5000, { sponsored: true })];
const FIVE_OFFERS = Array.from({ length: 5 }, (_, index) =>
  offer(`five-${index + 1}`, 10_000 + index * 500),
);

function trustFor(offers: Offer[]): Record<string, TrustSignal> {
  return Object.fromEntries(offers.map((o) => [
    o.merchant.id,
    {
      merchantId: o.merchant.id,
      level: "unknown" as const,
      evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
    },
  ]));
}

const TRUST = trustFor(OFFERS);

/** Fake service whose storeStatuses include a BLOCKED and a NOT_CONFIGURED store. */
function fakeService(): NorthCinderServiceClient {
  return {
    async search(query) {
      const offers = query.text === "five candidates"
        ? FIVE_OFFERS
        : query.text === "required delivery missed"
          ? OFFERS.map((candidate) => ({ ...candidate, shipping: { deliveryBy: "2026-12-31" } }))
          : OFFERS;
      const trust = query.text === "five candidates" ? trustFor(FIVE_OFFERS) : TRUST;
      const data: SearchRankResponse = {
        trustSignals: trust,
        results: rankOffers(offers, query, { trust }),
        storeStatuses: [
          { store: "ebay", ok: true, offerCount: offers.length, durationMs: 12 },
          {
            store: "amazon",
            ok: false,
            durationMs: 3,
            error: { store: "amazon", code: "blocked", message: "bot check triggered", retryable: false },
          },
          {
            store: "etsy",
            ok: false,
            durationMs: 1,
            error: { store: "etsy", code: "not_configured", message: "ETSY_API_KEY not set", retryable: false },
          },
        ],
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

describe("buyer's brief tools + MCP Apps widget wiring (buyer brief)", () => {
  const configDir = mkdtempSync(join(tmpdir(), "northcinder-brief-"));
  let auditPath: string;
  let client: Client;

  beforeAll(async () => {
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
    const audit = createAuditLog(configDir);
    auditPath = audit.path;
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

  async function search(): Promise<{ brief: BuyersBrief; decisionReadiness: DecisionReadiness; searchId: string }> {
    const result = await client.callTool({ name: "search_products", arguments: { text: "wool sneakers" } });
    const structured = result.structuredContent as {
      brief: BuyersBrief;
      decisionReadiness: DecisionReadiness;
      searchId: string;
    };
    return {
      brief: structured.brief,
      decisionReadiness: structured.decisionReadiness,
      searchId: structured.searchId,
    };
  }

  it("search_products emits a schema-valid brief: finalists inherit ranking, sponsored badged + last, coverage honest", async () => {
    const { brief } = await search();
    const parsed = BuyersBriefSchema.parse(brief);
    // Ranking inherited: sponsored (cheapest!) offer is a finalist but LAST, badged.
    expect(parsed.finalists.map((f) => f.offerId)).toEqual(["o1", "o2", "o3"]);
    expect(parsed.finalists[2]!.sponsored).toBe(true);
    // Coverage lists EVERY registered store — the blocked one is never omitted.
    expect(parsed.coverage).toEqual([
      { store: "ebay", status: "searched", offerCount: 3 },
      { store: "amazon", status: "blocked", offerCount: 0, detail: "blocked: bot check triggered" },
      { store: "etsy", status: "not_configured", offerCount: 0, detail: "not_configured: ETSY_API_KEY not set" },
    ]);
    // Provenance carries url + fetchedAt end-to-end.
    expect(parsed.finalists[0]!.provenance.price).toEqual({
      source: "https://ebay.example/p/o1",
      fetchedAt: FETCHED_AT,
    });
    const latestSearch = readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>).at(-1)!;
    expect(latestSearch.decisionState).toMatchObject({
      searchId: parsed.searchId,
      request: "wool sneakers",
      chosenOffer: null,
      outcome: null,
    });
    expect(JSON.stringify(latestSearch.decisionState)).not.toContain("buyerContext");
  });

  it.each([
    ["required attribute", { id: "attribute", label: "Impossible attribute", importance: "required", kind: "attribute", value: "never-present" }, "required attribute missing:"],
    ["required price", { id: "price", label: "One-cent ceiling", importance: "required", kind: "max_price", value: { amount: 1, currency: "USD" } }, "required price exceeded:"],
    ["required delivery missed", { id: "delivery", label: "Arrive in January", importance: "required", kind: "delivery_by", value: "2026-01-01" }, "required delivery missed:"],
    ["required delivery unknown", { id: "delivery", label: "Known arrival", importance: "required", kind: "delivery_by", value: "2026-12-31" }, "required delivery unknown:"],
    ["required ethics", { id: "ethics", label: "Missing certification", importance: "required", kind: "ethics", value: "never-certified" }, "required ethics missing:"],
    ["required availability", { id: "availability", label: "Must be unavailable", importance: "required", kind: "availability", value: "out_of_stock" }, "required availability mismatch:"],
  ] as const)("search_products places every offer failing %s in the real brief rejected appendix", async (text, criterion, expected) => {
    const result = await client.callTool({
      name: "search_products",
      arguments: { text, criteria: [criterion] },
    });
    expect(result.isError ?? false).toBe(false);
    const brief = (result.structuredContent as { brief: BuyersBrief }).brief;
    expect(brief.finalists).toEqual([]);
    expect(brief.rejected).toHaveLength(OFFERS.length);
    expect(brief.rejected.every((row) => row.eliminatedBy.some((line) => line.startsWith(expected)))).toBe(true);
  });

  it("search_products text carries the markdown fallback (universal path)", async () => {
    const result = await client.callTool({ name: "search_products", arguments: { text: "wool sneakers" } });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('# northcinder buyer\'s brief — "wool sneakers"');
    expect(text).toContain("| amazon | blocked (blocked: bot check triggered) | 0 |");
    expect(text).toContain("_Every registered store is listed above — nothing was silently skipped._");
  });

  it("keeps non-summary finalists out of the default search_products text", async () => {
    const result = await client.callTool({ name: "search_products", arguments: { text: "five candidates" } });
    const structured = result.structuredContent as { brief: BuyersBrief };
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const summaryKeys = new Set(
      structured.brief.decisionSummary.map((entry) => `${entry.sourceStore}:${entry.offerId}`),
    );
    const nonSummary = structured.brief.finalists.filter(
      (finalist) => !summaryKeys.has(`${finalist.sourceStore}:${finalist.offerId}`),
    );

    expect(nonSummary.length).toBeGreaterThan(0);
    for (const finalist of nonSummary) expect(text).not.toContain(finalist.title);
  });

  it("get_buyers_brief re-emits the SAME brief for the searchId, with the markdown rendering as text", async () => {
    const { brief, decisionReadiness, searchId } = await search();
    const result = await client.callTool({ name: "get_buyers_brief", arguments: { searchId } });
    expect(result.isError ?? false).toBe(false);
    const structured = result.structuredContent as { brief: BuyersBrief; decisionReadiness: DecisionReadiness };
    expect(structured.brief).toEqual(brief);
    expect(structured.decisionReadiness).toEqual(decisionReadiness);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('# northcinder buyer\'s brief — "wool sneakers"');
  });

  it("get_buyers_brief refuses an unknown searchId with a structured error", async () => {
    const result = await client.callTool({ name: "get_buyers_brief", arguments: { searchId: "search_nope" } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(JSON.parse(text).error.code).toBe("unknown_search");
  });

  it("tools carry the SEP-1865 widget link in _meta (ui.resourceUri + flat alias)", async () => {
    const { tools } = await client.listTools();
    for (const name of ["search_products", "submit_browser_observations", "get_buyers_brief"]) {
      const tool = tools.find((t) => t.name === name)!;
      const meta = tool._meta as { ui?: { resourceUri?: string }; "ui/resourceUri"?: string };
      expect(meta.ui?.resourceUri).toBe(BRIEF_WIDGET_URI);
      expect(meta["ui/resourceUri"]).toBe(BRIEF_WIDGET_URI);
    }
  });

  it("resources/list exposes the widget; resources/read serves the self-contained HTML", async () => {
    const { resources } = await client.listResources();
    const widget = resources.find((r) => r.uri === BRIEF_WIDGET_URI)!;
    expect(widget).toBeDefined();
    expect(widget.mimeType).toBe(BRIEF_WIDGET_MIME);
    const { contents } = await client.readResource({ uri: BRIEF_WIDGET_URI });
    const content = contents[0] as { text: string; _meta?: Record<string, unknown> };
    const html = content.text;
    expect(contents[0]!.mimeType).toBe(BRIEF_WIDGET_MIME);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("function renderBuyersBrief(brief, localTrustEvidence, localTrustEvidenceKeys)");
    expect(html).toContain("Every registered store is listed");
    expect(content._meta).toEqual({
      ui: {
        csp: {
          connectDomains: [],
          frameDomains: [],
          resourceDomains: [
            "https://cdn.shopify.com",
            "https://i.ebayimg.com",
            "https://i.sandbox.ebayimg.com",
            "https://i.etsystatic.com",
            "https://m.media-amazon.com",
          ],
        },
      },
    });
  });
});
