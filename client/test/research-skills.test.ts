import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadOrCreateMandateKeypair } from "@northcinder/checkout";
import { rankOffers, type Offer, type SearchRankResponse, type TrustSignal } from "@northcinder/protocol";
import { createAuditLog } from "../src/audit-log.js";
import { createAuthorizationStore } from "../src/authorization.js";
import { createClientCheckout } from "../src/checkout-wiring.js";
import { loadResearchSkillPack } from "../src/research-skills.js";
import { createNorthCinderMcpServer } from "../src/server.js";
import type { NorthCinderServiceClient } from "../src/service-client.js";

const CLIENT_DIR = new URL("../", import.meta.url);
const PRODUCT_CONTENT = readFileSync(new URL("research-skills/product-research/SKILL.md", CLIENT_DIR), "utf8");
const SELLER_CONTENT = readFileSync(new URL("research-skills/seller-research/SKILL.md", CLIENT_DIR), "utf8");

const PRODUCT_IDS = [
  "product.identity",
  "product.intended-use",
  "product.primary-facts",
  "product.independent-evidence",
  "product.fit-compatibility",
  "product.failure-modes",
  "product.counterevidence",
  "product.commercial-claims",
  "product.unknowns",
  "product.stop-receipt",
];

const SELLER_IDS = [
  "seller.identity",
  "seller.platform-separation",
  "seller.policies",
  "seller.fulfillment-contact",
  "seller.domain-business-records",
  "seller.independent-outcomes",
  "seller.commercial-claims",
  "seller.red-flags",
  "seller.counterevidence",
  "seller.unknowns",
  "seller.stop-receipt",
];

const CANDIDATE: Offer = {
  id: "candidate-1",
  product: {
    id: "product-1",
    title: "Exact Product Variant",
    url: "https://merchant.example/products/exact-variant",
    attributes: {},
  },
  price: { amount: 12_500, currency: "USD" },
  merchant: { id: "merchant-1", name: "Merchant One", domain: "merchant.example" },
  availability: "in_stock",
  sourceStore: "shopify",
  sponsored: false,
};

const TRUST: Record<string, TrustSignal> = {
  "merchant-1": {
    merchantId: "merchant-1",
    level: "unknown",
    evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
  },
};

function fakeService(): NorthCinderServiceClient {
  return {
    async search(query) {
      const results = query.text === "no candidates" ? [] : rankOffers([CANDIDATE], query, { trust: TRUST });
      const data: SearchRankResponse = {
        results,
        trustSignals: results.length === 0 ? {} : TRUST,
        registeredStores: ["shopify"],
        storeStatuses: [{ store: "shopify", ok: true, offerCount: results.length, durationMs: 1 }],
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

describe("canonical research skill loader", () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function fixtureRoot(product: string, seller?: string): URL {
    const root = mkdtempSync(join(tmpdir(), "northcinder-research-skills-"));
    dirs.push(root);
    mkdirSync(join(root, "product-research"), { recursive: true });
    writeFileSync(join(root, "product-research", "SKILL.md"), product);
    if (seller !== undefined) {
      mkdirSync(join(root, "seller-research"), { recursive: true });
      writeFileSync(join(root, "seller-research", "SKILL.md"), seller);
    }
    return pathToFileURL(`${root}/`);
  }

  const minimalProduct = `---\nname: product-research\ndescription: Product evidence.\n---\n\nRun a bounded pass: at most 8 focused queries and 12 source reads. Reserve two queries and two source reads for counterevidence.\n\n## Checklist\n\n- [ ] \`product.identity\` — Resolve identity.\n`;
  const minimalSeller = `---\nname: seller-research\ndescription: Seller evidence.\n---\n\nRun a bounded pass: at most 8 focused queries and 12 source reads. Reserve two queries and two source reads for counterevidence.\n\n## Checklist\n\n- [ ] \`seller.identity\` — Resolve identity.\n`;

  it("loads exactly the two canonical skills and preserves ordered checklist questions", () => {
    const pack = loadResearchSkillPack();
    expect(pack.map((skill) => skill.id)).toEqual(["product-research", "seller-research"]);
    expect(pack.map((skill) => skill.resourceUri)).toEqual([
      "northcinder://research/product",
      "northcinder://research/seller",
    ]);
    expect(pack.map((skill) => skill.promptName)).toEqual(["research_product", "research_seller"]);
    expect(pack[0]!.content).toBe(PRODUCT_CONTENT);
    expect(pack[1]!.content).toBe(SELLER_CONTENT);
    expect(pack[0]!.checklist.map((item) => item.id)).toEqual(PRODUCT_IDS);
    expect(pack[1]!.checklist.map((item) => item.id)).toEqual(SELLER_IDS);
    expect(pack[0]!.checklist[0]).toEqual({
      id: "product.identity",
      question: "Resolve the exact model, generation, size, and variant before binding any claim.",
      required: true,
    });
  });

  it("fails visibly when either exact canonical file is missing", () => {
    expect(() => loadResearchSkillPack(fixtureRoot(minimalProduct))).toThrow(/seller-research.*SKILL\.md/i);
  });

  it("fails visibly on malformed frontmatter, budget, and checklist markers", () => {
    const malformed = minimalProduct.replace("name: product-research", "name: wrong-product");
    expect(() => loadResearchSkillPack(fixtureRoot(malformed, minimalSeller))).toThrow(/product-research.*frontmatter/i);

    const noBudget = minimalProduct.replace(/Run a bounded pass:.*counterevidence\.\n/, "");
    expect(() => loadResearchSkillPack(fixtureRoot(noBudget, minimalSeller))).toThrow(/product-research.*budget/i);

    const badChecklist = minimalProduct.replace("- [ ] `product.identity` — Resolve identity.", "- [ ] product.identity — Resolve identity.");
    expect(() => loadResearchSkillPack(fixtureRoot(badChecklist, minimalSeller))).toThrow(/product-research.*checklist/i);
  });

  it("rejects duplicate checklist identifiers instead of silently collapsing work", () => {
    const duplicate = minimalProduct + "- [ ] `product.identity` — Resolve identity again.\n";
    expect(() => loadResearchSkillPack(fixtureRoot(duplicate, minimalSeller))).toThrow(/duplicate.*product\.identity/i);
  });

  it.each([
    ["completed checkbox", "- [x] `product.identity` — Resolve identity."],
    ["malformed bullet", "* [ ] `product.identity` — Resolve identity."],
  ])("rejects one %s among otherwise valid checklist entries", (_label, malformedLine) => {
    const malformed = minimalProduct.replace(
      "- [ ] `product.identity` — Resolve identity.",
      `${malformedLine}\n- [ ] \`product.primary-facts\` — Verify primary facts.`,
    );
    expect(() => loadResearchSkillPack(fixtureRoot(malformed, minimalSeller))).toThrow(/product-research.*checklist/i);
  });

  it.each([
    [
      "total",
      "Run a bounded pass: at most 8 focused queries and 12 source reads.",
      "Run a bounded pass: at most 8 focused queries and 12 source reads.\nRun a bounded pass: at most 7 focused queries and 10 source reads.",
    ],
    [
      "reservation",
      "Reserve two queries and two source reads for counterevidence.",
      "Reserve two queries and two source reads for counterevidence.\nReserve 1 queries and 1 source reads for counterevidence.",
    ],
  ])("rejects a duplicate contradictory %s budget marker", (_label, originalMarker, duplicateMarker) => {
    const duplicated = minimalProduct.replace(originalMarker, duplicateMarker);
    expect(() => loadResearchSkillPack(fixtureRoot(duplicated, minimalSeller))).toThrow(/product-research.*budget/i);
  });

  it("rejects a zero total research budget", () => {
    const zero = minimalProduct.replace("at most 8 focused queries", "at most 0 focused queries");
    expect(() => loadResearchSkillPack(fixtureRoot(zero, minimalSeller))).toThrow(/product-research.*budget/i);
  });

  it("rejects a counterevidence reservation greater than the total budget", () => {
    const overReserved = minimalProduct.replace(
      "Reserve two queries and two source reads",
      "Reserve 9 queries and 13 source reads",
    );
    expect(() => loadResearchSkillPack(fixtureRoot(overReserved, minimalSeller))).toThrow(/product-research.*budget/i);
  });
});

describe("research skills over a real MCP transport", () => {
  const configDir = mkdtempSync(join(tmpdir(), "northcinder-research-mcp-"));
  let client: Client;

  beforeAll(async () => {
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const checkout = createClientCheckout({ configDir, trustedPublicKeys: [keypair.publicKeyB64] });
    const server = createNorthCinderMcpServer({
      service: fakeService(),
      authorizations: createAuthorizationStore({ keypair, configDir, quiet: true }),
      checkout: checkout.orchestrator,
      railFor: checkout.railFor,
      audit: createAuditLog(configDir),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "research-skills-test-host", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("lists and reads both canonical Markdown resources without truncation", async () => {
    const { resources } = await client.listResources();
    const researchResources = resources.filter((resource) => resource.uri.startsWith("northcinder://research/"));
    expect(researchResources.map((resource) => resource.uri)).toEqual([
      "northcinder://research/product",
      "northcinder://research/seller",
    ]);

    for (const [uri, expected] of [
      ["northcinder://research/product", PRODUCT_CONTENT],
      ["northcinder://research/seller", SELLER_CONTENT],
    ] as const) {
      const { contents } = await client.readResource({ uri });
      expect(contents).toEqual([{ uri, mimeType: "text/markdown", text: expected }]);
    }
  });

  it("lists prompts and returns full skill content with the concrete request and subject", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(["research_product", "research_seller"]);

    const prompt = await client.getPrompt({
      name: "research_product",
      arguments: { request: "Check field-work fit", subject: "TrailCell 90 TC90-USBC-2026" },
    });
    const text = prompt.messages[0]!.content as { type: "text"; text: string };
    expect(text.text).toContain(PRODUCT_CONTENT);
    expect(text.text).toContain("Request: Check field-work fit");
    expect(text.text).toContain("Subject: TrailCell 90 TC90-USBC-2026");
  });

  it("lists create_research_plan as a deterministic, buyer-local read-only tool", async () => {
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "create_research_plan");
    expect(tool?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("creates deterministic plans with ordered IDs, fixed limits, and explicit claim fields", async () => {
    const result = await client.callTool({
      name: "create_research_plan",
      arguments: {
        skill: "seller-research",
        request: "Assess returns and merchant identity",
        subject: "BrightSound Outlet — https://brightsound.example.test/ca",
      },
    });
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent).toEqual({
      skill: "seller-research",
      skillResourceUri: "northcinder://research/seller",
      request: "Assess returns and merchant identity",
      subject: "BrightSound Outlet — https://brightsound.example.test/ca",
      checklist: expect.arrayContaining([]),
      limits: {
        maxQueries: 8,
        maxSourceReads: 12,
        reservedCounterevidenceQueries: 2,
        reservedCounterevidenceSourceReads: 2,
      },
      claimFormat: {
        identityField: "sellerIdentity",
        requiredFields: [
          "checklistIds",
          "sellerIdentity",
          "claim",
          "sourceIds",
          "sourceRelationship",
          "sourceUse",
          "sourceUrl",
          "sourceType",
          "observedAt",
          "confidence",
          "conflicts",
          "unknowns",
        ],
      },
    });
    const structured = result.structuredContent as { checklist: Array<{ id: string; required: boolean }> };
    expect(structured.checklist.map((item) => item.id)).toEqual(SELLER_IDS);
    expect(structured.checklist.every((item) => item.required === true)).toBe(true);
  });

  it("routes every search to product research and adds seller research only for candidate merchants", async () => {
    const empty = await client.callTool({ name: "search_products", arguments: { text: "no candidates" } });
    expect((empty.structuredContent as { discoveryState: { researchResourceUris: string[] } }).discoveryState.researchResourceUris)
      .toEqual(["northcinder://research/product"]);

    const candidate = await client.callTool({ name: "search_products", arguments: { text: "candidate present" } });
    expect((candidate.structuredContent as { discoveryState: { researchResourceUris: string[] } }).discoveryState.researchResourceUris)
      .toEqual(["northcinder://research/product", "northcinder://research/seller"]);
  });

  it.each([
    { skill: "other", request: "Research this", subject: "Subject" },
    { skill: "product-research", request: "", subject: "Subject" },
    { skill: "product-research", request: "Research this", subject: "" },
  ])("rejects invalid create_research_plan input at the MCP schema boundary: $skill/$request/$subject", async (args) => {
    const result = await client.callTool({ name: "create_research_plan", arguments: args });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: "text"; text: string }).text).toContain("Input validation error");
  });
});
