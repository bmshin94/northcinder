import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rankOffers, type Offer, type SearchQuery, type SearchRankResponse } from "@northcinder/protocol";
import { loadOrCreateMandateKeypair } from "@northcinder/checkout";
import { createProfileStore, PROFILE_FILENAME } from "@northcinder/profile";
import { createAuditLog } from "../src/audit-log.js";
import { createAuthorizationStore } from "../src/authorization.js";
import { createClientCheckout } from "../src/checkout-wiring.js";
import { createNorthCinderMcpServer } from "../src/server.js";
import type { NorthCinderServiceClient } from "../src/service-client.js";

const OFFER: Offer = {
  id: "item-1",
  product: {
    id: "item-1",
    title: "Wool Blend Sneaker",
    url: "https://mock-merchant.example/item-1",
    brand: "Acme",
    attributes: {},
  },
  price: { amount: 9800, currency: "USD" },
  merchant: { id: "mock-merchant.example", name: "Mock Merchant", domain: "mock-merchant.example" },
  availability: "in_stock",
  sourceStore: "ebay",
  sponsored: false,
};

const TRUST = {
  "mock-merchant.example": {
    merchantId: "mock-merchant.example",
    level: "unknown" as const,
    evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
  },
};

describe("profile tools + interpretation echo (profile)", () => {
  const configDir = mkdtempSync(join(tmpdir(), "northcinder-profile-tools-"));
  let client: Client;
  let auditPath: string;
  let lastServiceQuery: SearchQuery | undefined;

  const service: NorthCinderServiceClient = {
    async search(query) {
      lastServiceQuery = query;
      const data: SearchRankResponse = {
        trustSignals: TRUST,
        results: rankOffers([OFFER], query, { trust: TRUST }),
        storeStatuses: [{ store: "ebay", ok: true, offerCount: 1, durationMs: 5 }],
      };
      return { ok: true, data };
    },
    async trust(merchant) {
      return {
        ok: true,
        data: { merchantId: merchant.id, level: "unknown", evidence: [{ source: "seed-list", detail: "not seeded" }] },
      };
    },
  };

  beforeAll(async () => {
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const audit = createAuditLog(configDir);
    auditPath = audit.path;
    const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
    const server = createNorthCinderMcpServer({
      service,
      authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }),
      checkout: checkout.orchestrator,
      audit,
      profile: createProfileStore({ configDir }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-host-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  function auditEvents(): Array<Record<string, unknown>> {
    return readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("tool descriptions carry the usage-based elicitation guidance and the trust-boundary statement", async () => {
    const tools = await client.listTools();
    const byName = new Map(tools.tools.map((t) => [t.name, t.description ?? ""]));
    expect(byName.get("search_products")).toContain("usage-based");
    expect(byName.get("search_products")).toContain("How will you use it");
    expect(byName.get("update_profile")).toContain("EXPLICITLY STATED");
    expect(byName.get("update_profile")).toContain("TRUST BOUNDARY");
    expect(byName.get("update_profile")).toContain("dashboard");
    expect(byName.get("record_feedback")).toContain("inferred");
  });

  it("get_profile on an empty profile returns zero entries (and never errors about absence)", async () => {
    const res = await client.callTool({ name: "get_profile", arguments: {} });
    expect(res.isError ?? false).toBe(false);
    const structured = res.structuredContent as { entries: unknown[]; statedCount: number; inferredCount: number };
    expect(structured.entries).toEqual([]);
    expect(structured.statedCount).toBe(0);
    expect(structured.inferredCount).toBe(0);
    expect(auditEvents().some((e) => e.type === "profile_read")).toBe(true);
  });

  let budgetId: string;

  it("update_profile adds STATED entries (origin stamped by the store, audited)", async () => {
    const res = await client.callTool({
      name: "update_profile",
      arguments: {
        add: [
          { kind: "budget", category: "sneakers", maxPrice: { amount: 12000, currency: "USD" } },
          { kind: "ethics", flag: "fair-trade" },
        ],
      },
    });
    expect(res.isError ?? false).toBe(false);
    const structured = res.structuredContent as { added: Array<{ id: string; origin: string; kind: string }> };
    expect(structured.added).toHaveLength(2);
    for (const e of structured.added) expect(e.origin).toBe("stated");
    budgetId = structured.added[0]!.id;
    const write = auditEvents().find((e) => e.type === "profile_write");
    expect(write).toBeDefined();
    expect((write!.added as Array<{ id: string }>).map((a) => a.id)).toContain(budgetId);
  });

  it("search WITHOUT maxPrice: profile budget fills it — echoed by exact id+origin, and the service got the merged query", async () => {
    const res = await client.callTool({ name: "search_products", arguments: { text: "wool sneakers" } });
    expect(res.isError ?? false).toBe(false);
    const structured = res.structuredContent as {
      interpretedQuery: {
        criteria: SearchQuery;
        appliedProfileEntries: Array<Record<string, unknown>>;
        overriddenProfileEntries: unknown[];
        unmatchedQueryWords: string[];
      };
      rankingVerified: unknown;
      decisionReadiness: { status: string; reasons: string[] };
    };
    expect(structured.rankingVerified).toBe(true); // ranking verification preserved
    expect(structured.decisionReadiness.status).toBe("provisional");
    const iq = structured.interpretedQuery;
    expect(iq.criteria.maxPrice).toEqual({ amount: 12000, currency: "USD" });
    expect(iq.appliedProfileEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: budgetId, origin: "stated", kind: "budget", appliedTo: "maxPrice" }),
      ]),
    );
    expect(lastServiceQuery?.maxPrice).toEqual({ amount: 12000, currency: "USD" });
    // "wool" maps to no structured criterion — honestly disclosed
    expect(iq.unmatchedQueryWords).toContain("wool");
    // the human-readable echo marks origin
    expect(res.content?.[0]).toMatchObject({ type: "text" });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain(`[stated ${budgetId}]`);
  });

  it("PRECEDENCE: per-query maxPrice overrides the profile budget — both visible in interpretedQuery", async () => {
    const res = await client.callTool({
      name: "search_products",
      arguments: { text: "wool sneakers", maxPrice: { amount: 9000, currency: "USD" } },
    });
    const iq = (res.structuredContent as Record<string, any>).interpretedQuery;
    expect(iq.criteria.maxPrice).toEqual({ amount: 9000, currency: "USD" });
    expect(iq.overriddenProfileEntries).toEqual([
      expect.objectContaining({ id: budgetId, origin: "stated", overriddenBy: "per-query maxPrice" }),
    ]);
    expect(lastServiceQuery?.maxPrice).toEqual({ amount: 9000, currency: "USD" });
  });

  let pendingProposalId: string;

  it("record_feedback(not_interested) on a seen offer creates a pending brand-deny proposal, origin-tagged", async () => {
    const res = await client.callTool({
      name: "record_feedback",
      arguments: { chip: "not_interested", offerId: "item-1", sourceStore: "ebay", reason: "fit" },
    });
    expect(res.isError ?? false).toBe(false);
    const structured = res.structuredContent as { pendingProposal?: Record<string, any> };
    expect(structured.pendingProposal).toMatchObject({
      kind: "brand",
      brand: "Acme",
      stance: "deny",
      reason: "fit",
    });
    expect(structured.pendingProposal!.source).toContain("record_feedback:not_interested");
    pendingProposalId = structured.pendingProposal!.id as string;
    const fb = auditEvents().find((e) => e.type === "profile_feedback" && e.chip === "not_interested");
    expect(fb).toBeDefined();
  });

  it("get_profile keeps pending proposals separate from stated entries", async () => {
    const res = await client.callTool({ name: "get_profile", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("[STATED]");
    const structured = res.structuredContent as { inferredCount: number; proposals: Array<{ id: string }> };
    expect(structured.inferredCount).toBe(0);
    expect(structured.proposals).toEqual([expect.objectContaining({ id: pendingProposalId })]);
  });

  it("record_feedback(wrong_interpretation) creates NO entry — it is a correction signal, audited only", async () => {
    const before = (
      (await client.callTool({ name: "get_profile", arguments: {} })).structuredContent as { entries: unknown[] }
    ).entries.length;
    const res = await client.callTool({
      name: "record_feedback",
      arguments: { chip: "wrong_interpretation", offerId: "item-1", sourceStore: "ebay" },
    });
    expect(res.isError ?? false).toBe(false);
    expect((res.structuredContent as Record<string, unknown>).createdEntry).toBeUndefined();
    const after = (
      (await client.callTool({ name: "get_profile", arguments: {} })).structuredContent as { entries: unknown[] }
    ).entries.length;
    expect(after).toBe(before);
    expect(auditEvents().some((e) => e.type === "profile_feedback" && e.chip === "wrong_interpretation")).toBe(true);
  });

  it("a pending proposal can be explicitly confirmed, then the resulting stated entry is deletable in ONE call", async () => {
    const confirmed = await client.callTool({ name: "review_preference_proposal", arguments: { proposalId: pendingProposalId, action: "confirm" } });
    const confirmedEntry = (confirmed.structuredContent as { entry: { id: string } }).entry;
    const res = await client.callTool({ name: "update_profile", arguments: { deleteIds: [confirmedEntry.id] } });
    expect(res.isError ?? false).toBe(false);
    expect((res.structuredContent as Record<string, unknown>).deleted).toEqual([
      { id: confirmedEntry.id, kind: "brand", origin: "stated" },
    ]);
    const del = auditEvents().find((e) => e.type === "profile_delete");
    expect(del).toBeDefined();
    expect(JSON.stringify(del)).not.toContain("Acme");
    const profile = (await client.callTool({ name: "get_profile", arguments: {} })).structuredContent as {
      inferredCount: number;
    };
    expect(profile.inferredCount).toBe(0);
  });

  it("errors never leak stored values: deleting an unknown id names the id only", async () => {
    const res = await client.callTool({ name: "update_profile", arguments: { deleteIds: ["pref_missing"] } });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("pref_missing");
    expect(text).not.toContain("Acme");
    expect(text).not.toContain("fair-trade");
    expect(text).not.toContain("12000");
  });

  it("record_feedback on an unseen offer fails without inventing or leaking anything", async () => {
    const res = await client.callTool({
      name: "record_feedback",
      arguments: { chip: "more_like_this", offerId: "never-seen", sourceStore: "ebay" },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("never-seen");
    expect(text).not.toContain("Acme");
  });

  it("duplicate deleteIds are deduped — one deletion, no fabricated metadata", async () => {
    const addRes = await client.callTool({
      name: "update_profile",
      arguments: { add: [{ kind: "delivery", maxDays: 4 }] },
    });
    const id = (addRes.structuredContent as { added: Array<{ id: string }> }).added[0]!.id;
    const res = await client.callTool({ name: "update_profile", arguments: { deleteIds: [id, id] } });
    expect(res.isError ?? false).toBe(false);
    const deleted = (res.structuredContent as { deleted: Array<{ id: string; kind: string; origin: string }> }).deleted;
    expect(deleted).toEqual([{ id, kind: "delivery", origin: "stated" }]);
    // no invented {kind:"unknown"} anywhere — output or audit
    expect(JSON.stringify(res.structuredContent)).not.toContain('"unknown"');
    expect(readFileSync(auditPath, "utf8")).not.toContain('"kind":"unknown"');
  });

  it("the profile file on disk is mode 0600", () => {
    const mode = statSync(join(configDir, PROFILE_FILENAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("record_feedback(wrong_interpretation) against a SEARCH — the misread-query case", () => {
  const configDir = mkdtempSync(join(tmpdir(), "northcinder-searchfb-"));
  let c: Client;
  let auditPath: string;

  beforeAll(async () => {
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
    const audit = createAuditLog(configDir);
    auditPath = audit.path;
    const server = createNorthCinderMcpServer({
      service: {
        // A misread query's primary symptom: ZERO results — there is no offer to point at.
        async search(query) {
          return {
            ok: true,
            data: { trustSignals: {}, results: rankOffers([], query, { trust: {} }), storeStatuses: [] },
          };
        },
        async trust() {
          throw new Error("unused");
        },
      } as unknown as NorthCinderServiceClient,
      authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }),
      checkout: checkout.orchestrator,
      audit,
      profile: createProfileStore({ configDir }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    c = new Client({ name: "test-host-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), c.connect(clientTransport)]);
  });

  it("search_products returns a stable searchId; wrong_interpretation with that searchId succeeds and is audited", async () => {
    const search = await c.callTool({ name: "search_products", arguments: { text: "wool sneakers" } });
    const structured = search.structuredContent as { searchId: string; results: unknown[] };
    expect(structured.results).toEqual([]);
    expect(structured.searchId).toMatch(/^search_/);

    const res = await c.callTool({
      name: "record_feedback",
      arguments: { chip: "wrong_interpretation", searchId: structured.searchId },
    });
    expect(res.isError ?? false).toBe(false);
    const fb = res.structuredContent as { chip: string; searchId?: string; createdEntry?: unknown };
    expect(fb.chip).toBe("wrong_interpretation");
    expect(fb.searchId).toBe(structured.searchId);
    expect(fb.createdEntry).toBeUndefined(); // correction signal — never an inference

    const events = readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const searchEvent = events.find((e) => e.type === "search");
    expect(searchEvent?.searchId).toBe(structured.searchId);
    const fbEvent = events.find((e) => e.type === "profile_feedback" && e.chip === "wrong_interpretation");
    expect(fbEvent?.searchId).toBe(structured.searchId);
    // the feedback references the interpreted query it corrects
    expect((fbEvent?.interpretedQuery as { criteria: { text: string } }).criteria.text).toBe("wool sneakers");
  });

  it("an unknown searchId fails structurally without leaking anything", async () => {
    const res = await c.callTool({
      name: "record_feedback",
      arguments: { chip: "wrong_interpretation", searchId: "search_bogus" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("unknown_search");
  });

  it("offer-targeted chips still require an offerId — a searchId is not an offer", async () => {
    const search = await c.callTool({ name: "search_products", arguments: { text: "wool sneakers" } });
    const { searchId } = search.structuredContent as { searchId: string };
    const res = await c.callTool({ name: "record_feedback", arguments: { chip: "not_interested", searchId } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("missing_offer");
  });

  it("record_feedback with neither offerId nor searchId fails structurally", async () => {
    const res = await c.callTool({ name: "record_feedback", arguments: { chip: "wrong_interpretation" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("missing_target");
  });
});

describe("record_feedback offer disambiguation", () => {
  it("refuses a bare offerId returned by more than one store — never learns from the wrong offer", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-ambig-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
    const twin: Offer = {
      ...OFFER,
      sourceStore: "etsy",
      product: { ...OFFER.product, brand: "OtherBrand" },
    };
    const server = createNorthCinderMcpServer({
      service: {
        async search(query) {
          return {
            ok: true,
            data: {
              trustSignals: TRUST,
              results: rankOffers([OFFER, twin], query, { trust: TRUST }),
              storeStatuses: [{ store: "ebay", ok: true, offerCount: 2, durationMs: 5 }],
            },
          };
        },
        async trust() {
          throw new Error("unused");
        },
      } as unknown as NorthCinderServiceClient,
      authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }),
      checkout: checkout.orchestrator,
      audit: createAuditLog(configDir),
      profile: createProfileStore({ configDir }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test-host-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), c.connect(clientTransport)]);
    await c.callTool({ name: "search_products", arguments: { text: "sneakers" } });
    const res = await c.callTool({ name: "record_feedback", arguments: { chip: "not_interested", offerId: "item-1" } });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("ambiguous_offer");
    expect(text).toContain("ebay");
    expect(text).toContain("etsy");
    // and nothing was inferred
    const profile = (await c.callTool({ name: "get_profile", arguments: {} })).structuredContent as {
      entries: unknown[];
    };
    expect(profile.entries).toEqual([]);
  });
});

describe("record_feedback for an agent-observed result", () => {
  it("supports feedback and preserves observation provenance in the local audit", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-observed-feedback-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
    const audit = createAuditLog(configDir);
    const observedOffer: Offer = {
      id: "browser-offer-1",
      product: {
        id: "browser-product-1",
        title: "Observed Wool Sneaker",
        url: "https://observed-shop.example/products/wool-sneaker",
        brand: "Observed Brand",
        attributes: {},
      },
      price: { amount: 8900, currency: "USD" },
      merchant: {
        id: "observed-shop.example",
        name: "Observed Shop",
        domain: "observed-shop.example",
      },
      availability: "in_stock",
      sourceStore: "agent_browser",
      sponsored: false,
      fetchedAt: "2026-08-16T10:00:00.000Z",
      acquisition: {
        kind: "agent_observed",
        observedAt: "2026-08-16T10:00:00.000Z",
        receivedAt: "2026-08-16T10:01:00.000Z",
        placement: "organic",
      },
    };
    const observedTrust = {
      "observed-shop.example": {
        merchantId: "observed-shop.example",
        level: "unknown" as const,
        evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
      },
    };
    const service: NorthCinderServiceClient = {
      async search(query, options) {
        if (options?.browserObservations === undefined) {
          return {
            ok: true,
            data: { trustSignals: {}, results: [], storeStatuses: [], registeredStores: [] },
          };
        }
        return {
          ok: true,
          data: {
            trustSignals: observedTrust,
            results: rankOffers([observedOffer], query, { trust: observedTrust }),
            storeStatuses: [{ store: "agent_browser", ok: true, offerCount: 1, durationMs: 1 }],
            registeredStores: ["agent_browser"],
            browserObservationReport: { submitted: 1, accepted: 1, rejected: [] },
          },
        };
      },
      async trust() {
        throw new Error("unused");
      },
    };
    const server = createNorthCinderMcpServer({
      service,
      authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }),
      checkout: checkout.orchestrator,
      audit,
      profile: createProfileStore({ configDir }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-host-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const initial = await client.callTool({ name: "search_products", arguments: { text: "wool sneaker" } });
    const { searchId: initialSearchId } = initial.structuredContent as { searchId: string };
    const continued = await client.callTool({
      name: "submit_browser_observations",
      arguments: {
        searchId: initialSearchId,
        observations: [
          {
            productUrl: observedOffer.product.url,
            title: observedOffer.product.title,
            price: observedOffer.price,
            availability: observedOffer.availability,
            merchantName: observedOffer.merchant.name,
            brand: observedOffer.product.brand,
            placement: "organic",
            observedAt: "2026-08-16T10:00:00.000Z",
          },
        ],
      },
    });
    expect(continued.isError ?? false).toBe(false);
    const continuedSearchId = (continued.structuredContent as { searchId: string }).searchId;

    const feedback = await client.callTool({
      name: "record_feedback",
      arguments: {
        chip: "not_interested",
        offerId: observedOffer.id,
        sourceStore: "agent_browser",
        reason: "fit",
      },
    });
    expect(feedback.isError ?? false).toBe(false);
    expect((feedback.structuredContent as { pendingProposal?: Record<string, unknown> }).pendingProposal).toMatchObject({
      kind: "brand",
      brand: "Observed Brand",
      stance: "deny",
      reason: "fit",
    });

    const events = readFileSync(audit.path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const continuedSearch = events.find((event) => event.type === "search" && event.searchId === continuedSearchId);
    expect(continuedSearch?.continuedFrom).toBe(initialSearchId);
    expect(continuedSearch?.ranking).toEqual([
      expect.objectContaining({
        offerId: observedOffer.id,
        store: "agent_browser",
        acquisition: expect.objectContaining({ kind: "agent_observed", placement: "organic" }),
      }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "profile_feedback",
        chip: "not_interested",
        offerKey: `agent_browser:${observedOffer.id}`,
      }),
    );
  });
});

describe("corrupt profile file — structured failure envelope", () => {
  const configDir = mkdtempSync(join(tmpdir(), "northcinder-corrupt-"));
  let c: Client;

  beforeAll(async () => {
    writeFileSync(join(configDir, PROFILE_FILENAME), "{not json", { mode: 0o600 });
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
    const server = createNorthCinderMcpServer({
      service: {
        async search(query) {
          return {
            ok: true,
            data: { trustSignals: {}, results: rankOffers([], query, { trust: {} }), storeStatuses: [] },
          };
        },
        async trust() {
          throw new Error("unused");
        },
      } as unknown as NorthCinderServiceClient,
      authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }),
      checkout: checkout.orchestrator,
      audit: createAuditLog(configDir),
      profile: createProfileStore({ configDir }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    c = new Client({ name: "test-host-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), c.connect(clientTransport)]);
  });

  for (const call of [
    { name: "get_profile", arguments: {} },
    { name: "update_profile", arguments: { deleteIds: ["pref_x"] } },
    { name: "search_products", arguments: { text: "wool sneakers" } },
  ]) {
    it(`${call.name} returns a profile_unreadable envelope without a buyer-local path or stored values`, async () => {
      const res = await c.callTool(call);
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ text: string }>)[0]!.text;
      const parsed = JSON.parse(text) as { error: { code: string; message: string } };
      expect(parsed.error.code).toBe("profile_unreadable");
      expect(parsed.error.message).toBe("the buyer-local profile could not be read");
      expect(text).not.toContain(configDir);
      expect(text).not.toContain("{not json");
    });
  }
});

describe("profile-less server (no profile store wired)", () => {
  it("search still echoes an interpretedQuery with nothing applied; profile tools are absent", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-noprofile-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
    const server = createNorthCinderMcpServer({
      service: {
        async search(query) {
          return {
            ok: true,
            data: {
              trustSignals: TRUST,
              results: rankOffers([OFFER], query, { trust: TRUST }),
              storeStatuses: [{ store: "ebay", ok: true, offerCount: 1, durationMs: 5 }],
            },
          };
        },
        async trust() {
          throw new Error("unused");
        },
      } as unknown as NorthCinderServiceClient,
      authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }),
      checkout: checkout.orchestrator,
      audit: createAuditLog(configDir),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test-host-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), c.connect(clientTransport)]);
    const tools = await c.listTools();
    expect(tools.tools.map((t) => t.name)).not.toContain("get_profile");
    const res = await c.callTool({ name: "search_products", arguments: { text: "wool sneakers" } });
    const iq = (res.structuredContent as Record<string, any>).interpretedQuery;
    expect(iq.appliedProfileEntries).toEqual([]);
    expect(iq.criteria.text).toBe("wool sneakers");
  });
});

describe("proposal-gated feedback tools", () => {
  it("records a reasoned brand reaction as a pending proposal and confirms or dismisses only by explicit action", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-profile-proposal-tools-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
    const profile = createProfileStore({ configDir });
    const server = createNorthCinderMcpServer({
      service: {
        async search(query) {
          return {
            ok: true,
            data: { trustSignals: TRUST, results: rankOffers([OFFER], query, { trust: TRUST }), storeStatuses: [] },
          };
        },
        async trust() {
          throw new Error("unused");
        },
      } as unknown as NorthCinderServiceClient,
      authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }),
      checkout: checkout.orchestrator,
      audit: createAuditLog(configDir),
      profile,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test-host-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), c.connect(clientTransport)]);
    await c.callTool({ name: "search_products", arguments: { text: "sneakers", buyerContext: { subject: "dad" } } });

    const unreasoned = await c.callTool({ name: "record_feedback", arguments: { chip: "not_interested", offerId: OFFER.id, sourceStore: OFFER.sourceStore } });
    expect(unreasoned.isError ?? false).toBe(false);
    expect((unreasoned.structuredContent as Record<string, unknown>).pendingProposal).toBeUndefined();
    expect(profile.list()).toEqual([]);
    expect(profile.listProposals()).toEqual([]);

    const reaction = await c.callTool({ name: "record_feedback", arguments: { chip: "not_interested", offerId: OFFER.id, sourceStore: OFFER.sourceStore, reason: "fit" } });
    expect(reaction.isError ?? false).toBe(false);
    const pending = (reaction.structuredContent as { pendingProposal: { id: string; scope?: unknown }; createdEntry?: unknown }).pendingProposal;
    expect(pending).toMatchObject({ scope: { kind: "subject", value: "dad" } });
    expect((reaction.structuredContent as { createdEntry?: unknown }).createdEntry).toBeUndefined();
    expect(profile.list()).toEqual([]);

    const confirmed = await c.callTool({ name: "review_preference_proposal", arguments: { proposalId: pending!.id, action: "confirm" } });
    expect(confirmed.isError ?? false).toBe(false);
    expect((confirmed.structuredContent as { entry: { origin: string; kind: string } }).entry).toMatchObject({ origin: "stated", kind: "brand" });

    const second = await c.callTool({ name: "record_feedback", arguments: { chip: "more_like_this", offerId: OFFER.id, sourceStore: OFFER.sourceStore, reason: "style" } });
    const dismissedPending = (second.structuredContent as { pendingProposal: { id: string } }).pendingProposal;
    const dismissed = await c.callTool({ name: "review_preference_proposal", arguments: { proposalId: dismissedPending!.id, action: "dismiss" } });
    expect(dismissed.isError ?? false).toBe(false);
    expect(profile.listProposals()).toEqual([]);

    const listed = await c.callTool({ name: "get_profile", arguments: {} });
    expect((listed.structuredContent as { proposals: unknown[] }).proposals).toEqual([]);
  });

  it("keeps duplicate feedback evidence pending, then promotes only a second distinct matching MCP offer", async () => {
    // Regression: treating a repeated click on one offer as independent evidence
    // would silently create an inferred preference without a second offer.
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-profile-repeat-evidence-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
    const profile = createProfileStore({ configDir });
    const audit = createAuditLog(configDir);
    const secondOffer: Offer = {
      ...OFFER,
      id: "item-2",
      product: { ...OFFER.product, id: "item-2", title: "Wool Blend Sneaker II" },
    };
    const server = createNorthCinderMcpServer({
      service: {
        async search(query) {
          return {
            ok: true,
            data: { trustSignals: TRUST, results: rankOffers([OFFER, secondOffer], query, { trust: TRUST }), storeStatuses: [] },
          };
        },
        async trust() {
          throw new Error("unused");
        },
      } as unknown as NorthCinderServiceClient,
      authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }),
      checkout: checkout.orchestrator,
      audit,
      profile,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test-host-agent", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), c.connect(clientTransport)]);
    await c.callTool({ name: "search_products", arguments: { text: "sneakers", buyerContext: { subject: "dad" } } });

    const first = await c.callTool({
      name: "record_feedback",
      arguments: { chip: "not_interested", offerId: OFFER.id, sourceStore: OFFER.sourceStore, reason: "fit" },
    });
    const proposal = (first.structuredContent as { pendingProposal: { id: string; evidenceKeys: string[]; scope: unknown } }).pendingProposal;
    expect(proposal).toMatchObject({ scope: { kind: "subject", value: "dad" }, evidenceKeys: ['["ebay","item-1"]'] });
    expect(profile.list()).toEqual([]);

    const duplicate = await c.callTool({
      name: "record_feedback",
      arguments: { chip: "not_interested", offerId: OFFER.id, sourceStore: OFFER.sourceStore, reason: "fit" },
    });
    expect(duplicate.isError ?? false).toBe(false);
    expect((duplicate.structuredContent as { pendingProposal: { id: string; evidenceKeys: string[] }; createdEntry?: unknown }).pendingProposal).toEqual(
      expect.objectContaining({ id: proposal.id, evidenceKeys: ['["ebay","item-1"]'] }),
    );
    expect((duplicate.structuredContent as { createdEntry?: unknown }).createdEntry).toBeUndefined();
    expect(profile.list()).toEqual([]);
    expect(profile.listProposals()).toEqual([expect.objectContaining({ id: proposal.id, evidenceKeys: ['["ebay","item-1"]'] })]);

    const promoted = await c.callTool({
      name: "record_feedback",
      arguments: { chip: "not_interested", offerId: secondOffer.id, sourceStore: secondOffer.sourceStore, reason: "fit" },
    });
    expect(promoted.isError ?? false).toBe(false);
    expect((promoted.structuredContent as { pendingProposal?: unknown }).pendingProposal).toBeUndefined();
    expect((promoted.structuredContent as { createdEntry: Record<string, unknown> }).createdEntry).toMatchObject({
      origin: "inferred",
      kind: "brand",
      brand: "Acme",
      stance: "deny",
      scope: { kind: "subject", value: "dad" },
    });
    expect(profile.list()).toEqual([expect.objectContaining({ origin: "inferred", kind: "brand", brand: "Acme", stance: "deny" })]);
    expect(profile.listProposals()).toEqual([]);
    const feedbackAudits = readFileSync(audit.path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === "profile_feedback");
    expect(feedbackAudits).toHaveLength(3);
    expect(feedbackAudits[0]).toMatchObject({
      chip: "not_interested",
      offerKey: "ebay:item-1",
      reason: "fit",
      proposalId: proposal.id,
      createdEntry: null,
    });
    expect(feedbackAudits[1]).toMatchObject({
      chip: "not_interested",
      offerKey: "ebay:item-1",
      reason: "fit",
      proposalId: proposal.id,
      createdEntry: null,
    });
    expect(feedbackAudits[2]).toMatchObject({
      chip: "not_interested",
      offerKey: "ebay:item-2",
      reason: "fit",
      createdEntry: expect.objectContaining({ id: expect.any(String), kind: "brand", origin: "inferred" }),
    });
    expect(feedbackAudits[2]!.proposalId).toBeUndefined();
  });
});
