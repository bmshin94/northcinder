import { describe, expect, it } from "vitest";
import type { BuyersBrief } from "@northcinder/protocol";
import { renderBriefMarkdown, SPONSORED_BADGE } from "../src/markdown.js";

const BRIEF: BuyersBrief = {
  searchId: "search_snapshot",
  query: { text: "wool sneakers", maxPrice: { amount: 12000, currency: "USD" } },
  finalists: [
    {
      rank: 1,
      offerId: "o1",
      sourceStore: "ebay",
      title: "Wool Runner o1",
      url: "https://ebay.example/p/o1",
      merchant: { id: "trusted.example", name: "Shop o1" },
      price: { amount: 9800, currency: "USD" },
      availability: "in_stock",
      deliveryBy: "2026-07-08",
      trustLevel: "trusted",
      sponsored: false,
      whyThis: [
        "price: lowest price: 9800 USD",
        "availability: in stock",
      ],
      tradeoffs: [{ dimension: "price", detail: "cheapest finalist at 98.00 USD" }],
      provenance: {
        price: { source: "https://ebay.example/p/o1", fetchedAt: "2026-07-04T09:00:00.000Z" },
        trust: { source: "trust-signal:seed-list" },
      },
    },
    {
      rank: 2,
      offerId: "o10",
      sourceStore: "ebay",
      title: "Wool Runner o10",
      url: "https://ebay.example/p/o10",
      merchant: { id: "o10-shop.example", name: "Shop o10" },
      price: { amount: 9990, currency: "USD" },
      availability: "in_stock",
      sponsored: true,
      whyThis: ["price: price: 9990 USD, 190 USD above the cheapest offer"],
      tradeoffs: [],
      provenance: {
        price: { source: "https://ebay.example/p/o10", fetchedAt: "2026-07-04T09:00:00.000Z" },
      },
    },
  ],
  rejected: [
    {
      offerId: "o7",
      sourceStore: "ebay",
      title: "Wool Runner o7",
      eliminatedBy: ["over budget: price 15000 USD exceeds budget 12000 USD"],
    },
  ],
  coverage: [
    { store: "ebay", status: "searched", offerCount: 3 },
    { store: "amazon", status: "blocked", offerCount: 0, detail: "blocked: bot check triggered" },
    { store: "etsy", status: "not_configured", offerCount: 0, detail: "not_configured: ETSY_API_KEY not set" },
  ],
  offersConsidered: 3,
};

const EXPECTED = `# northcinder buyer's brief — "wool sneakers"

2 finalist(s) from 3 ranked offer(s) (search search_snapshot). Composed deterministically by code from the neutrality ranking — deterministic and auditable.

## Finalists

### 1. Wool Runner o1 — 98.00 USD from Shop o1 (via ebay)

_availability: in_stock · promised delivery: 2026-07-08 · merchant trust: trusted_

**Why this (your criteria):**
- price: lowest price: 9800 USD
- availability: in stock

**Tradeoffs vs the other finalists:**
- price: cheapest finalist at 98.00 USD

**Provenance:**
  - price: https://ebay.example/p/o1 (fetched 2026-07-04T09:00:00.000Z)
  - trust: trust-signal:seed-list

### 2. Wool Runner o10 — 99.90 USD from Shop o10 (via ebay) — **SPONSORED** — paid placement, labeled and never ranked above organic results

_availability: in_stock_

**Why this (your criteria):**
- price: price: 9990 USD, 190 USD above the cheapest offer

**Tradeoffs vs the other finalists:**
- none — no computed difference on price, delivery, trust, or spec

**Provenance:**
  - price: https://ebay.example/p/o10 (fetched 2026-07-04T09:00:00.000Z)

## Rejected (and the criteria that eliminated them)

- Wool Runner o7 (ebay:o7) — over budget: price 15000 USD exceeds budget 12000 USD

## Store coverage

| store | status | offers |
| --- | --- | --- |
| ebay | searched | 3 |
| amazon | blocked (blocked: bot check triggered) | 0 |
| etsy | not_configured (not_configured: ETSY_API_KEY not set) | 0 |

_Every registered store is listed above — nothing was silently skipped._
`;

describe("renderBriefMarkdown — deterministic universal fallback", () => {
  it("renders the EXACT markdown template (snapshot with exact content)", () => {
    expect(renderBriefMarkdown(BRIEF)).toBe(EXPECTED);
  });

  it("sponsored badge text is exact and appears once per sponsored finalist", () => {
    const md = renderBriefMarkdown(BRIEF);
    expect(md.split(SPONSORED_BADGE)).toHaveLength(2);
  });

  it("labels an unknown-placement browser observation without falsely calling it sponsored", () => {
    const observed: BuyersBrief = {
      ...BRIEF,
      finalists: [
        {
          ...BRIEF.finalists[0]!,
          sourceStore: "agent_browser",
          sponsored: true,
          acquisition: {
            kind: "agent_observed",
            observedAt: "2026-08-16T10:00:00.000Z",
            receivedAt: "2026-08-16T10:01:00.000Z",
            placement: "unknown",
          },
        },
      ],
      offersConsidered: 1,
    };

    const md = renderBriefMarkdown(observed);
    expect(md).toContain("**AGENT-OBSERVED** — reported from the product page at 2026-08-16T10:00:00.000Z; not independently verified");
    expect(md).toContain("**PLACEMENT NOT CONFIRMED** — treated like sponsored for ranking");
    expect(md).not.toContain(SPONSORED_BADGE);
  });

  it("byte-identical on repeated renders (no clock, no randomness)", () => {
    expect(renderBriefMarkdown(BRIEF)).toBe(renderBriefMarkdown(BRIEF));
  });

  it("zero finalists renders the honest empty state, never padding", () => {
    const empty: BuyersBrief = { ...BRIEF, finalists: [], offersConsidered: 1 };
    const md = renderBriefMarkdown(empty);
    expect(md).toContain("_No offer met your criteria — nothing is padded in to fill the list. See the rejected appendix._");
  });
});

describe("markdown injection hardening regression", () => {
  it("pipes and newlines in store-controlled strings cannot forge coverage-table rows or new lines", () => {
    const hostile: BuyersBrief = {
      ...BRIEF,
      finalists: [
        {
          ...BRIEF.finalists[0]!,
          title: "Nice Shoe\n| forged-store | searched | 999 |",
          merchant: { id: "evil.example", name: "Evil | Merchant" },
          whyThis: ["price: cheap\n## Forged heading"],
        },
      ],
      rejected: [
        {
          offerId: "r1",
          sourceStore: "ebay",
          title: "Bad | Product\nInjected line",
          eliminatedBy: ["out of stock"],
        },
      ],
      coverage: [
        { store: "ebay", status: "searched", offerCount: 1 },
        {
          store: "amazon",
          status: "error",
          offerCount: 0,
          detail: "internal: oops | forged | cell |\n| another | row | 1 |",
        },
      ],
      offersConsidered: 2,
    };
    const md = renderBriefMarkdown(hostile);
    const lines = md.split("\n");
    // No store-controlled string may materialize as its own (table) line.
    expect(lines).not.toContain("| forged-store | searched | 999 |");
    expect(lines).not.toContain("| another | row | 1 |");
    expect(lines).not.toContain("## Forged heading");
    expect(lines).not.toContain("Injected line");
    // Pipes inside table cells are escaped, so every coverage table row has exactly 3 cells.
    const tableRows = lines.filter((l) => l.startsWith("| ") && l.includes("amazon"));
    for (const row of tableRows) {
      expect(row.split(/(?<!\\)\|/).length).toBe(5); // "", 3 cells, "" — unescaped pipes only
    }
    // Content survives, sanitized inline.
    expect(md).toContain("Nice Shoe \\| forged-store \\| searched \\| 999 \\|");
    expect(md).toContain("Bad \\| Product Injected line");
  });

  it("the sanitizer is identity on clean strings (snapshot unchanged)", () => {
    expect(renderBriefMarkdown(BRIEF)).toBe(EXPECTED);
  });
});
