import { createServer, type Server } from "node:http";
import { runInNewContext } from "node:vm";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuyersBrief } from "@northcinder/protocol";
import {
  BRIEF_WIDGET_HTML,
  BRIEF_WIDGET_MIME,
  BRIEF_WIDGET_URI,
  WIDGET_RENDER_JS,
  WIDGET_SPONSORED_BADGE,
} from "../src/brief-widget.js";

const FIXTURE_BRIEF: BuyersBrief = {
  searchId: "search_widget_fixture",
  query: { text: "wool sneakers", maxPrice: { amount: 12000, currency: "USD" } },
  finalists: [
    {
      rank: 1,
      offerId: "o1",
      sourceStore: "ebay",
      title: "Wool Runner <script>alert(1)</script>",
      url: "https://ebay.example/p/o1",
      merchant: { id: "trusted.example", name: "Shop o1" },
      price: { amount: 9800, currency: "USD" },
      availability: "in_stock",
      deliveryBy: "2026-07-08",
      trustLevel: "trusted",
      sponsored: false,
      whyThis: ["price: lowest price: 9800 USD"],
      tradeoffs: [{ dimension: "price", detail: "cheapest finalist at 98.00 USD" }],
      provenance: {
        price: { source: "https://ebay.example/p/o1", fetchedAt: "2026-07-04T09:00:00.000Z" },
        trust: { source: "trust-signal:seed-list" },
      },
    },
    {
      rank: 2,
      offerId: "o3",
      sourceStore: "ebay",
      title: "Wool Runner o3",
      url: "https://ebay.example/p/o3",
      merchant: { id: "o3-shop.example", name: "Shop o3" },
      price: { amount: 5000, currency: "USD" },
      availability: "in_stock",
      sponsored: true,
      whyThis: ["price: lowest price: 5000 USD"],
      tradeoffs: [],
      provenance: { price: { source: "https://ebay.example/p/o3", fetchedAt: "2026-07-04T09:00:00.000Z" } },
    },
  ],
  rejected: [
    {
      offerId: "o7",
      sourceStore: "ebay",
      title: "Overpriced Runner",
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

/** Run the EXACT render code that ships inside the widget, headlessly. */
function renderWithWidgetCode(
  brief: BuyersBrief,
  localTrustEvidence?: Record<string, Array<{ source: string; detail: string }>>,
  localTrustEvidenceKeys?: Record<string, string>,
): string {
  const sandbox: Record<string, unknown> = {};
  runInNewContext(`${WIDGET_RENDER_JS}\nthis.renderBuyersBrief = renderBuyersBrief;`, sandbox);
  return (sandbox.renderBuyersBrief as (b: BuyersBrief, l?: unknown, k?: unknown) => string)(brief, localTrustEvidence, localTrustEvidenceKeys);
}

function bridgeHarness(referrer: string, toolOutput?: unknown) {
  let listener: ((event: { source: unknown; origin: string; data: unknown }) => void) | undefined;
  const root = { innerHTML: "" };
  const parent = {};
  const window = {
    parent,
    ...(toolOutput === undefined ? {} : { openai: { toolOutput } }),
    addEventListener(kind: string, fn: typeof listener) { if (kind === "message") listener = fn; },
  };
  const document = { referrer, getElementById(id: string) { return id === "root" ? root : null; } };
  const script = BRIEF_WIDGET_HTML.match(/<script>\n([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error("widget bootstrap script missing");
  runInNewContext(script, { window, document, URL });
  return { root, parent, dispatch: (event: { source: unknown; origin: string; data: unknown }) => listener?.(event) };
}

describe("buyer's-brief widget — headless check (SEP-1865 resource)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(BRIEF_WIDGET_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("serve + fetch: the widget document is self-contained vanilla HTML/JS with the render code inline", async () => {
    const res = await fetch(baseUrl);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toBe(BRIEF_WIDGET_HTML);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("function renderBuyersBrief(brief, localTrustEvidence, localTrustEvidenceKeys)");
    // No framework, no external scripts — sandbox-friendly per SEP-1865.
    expect(html).not.toContain("<script src=");
    expect(html).not.toContain("import ");
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1" />');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain(":focus-visible");
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).toContain("@media (max-width: 480px)");
    expect(html).not.toMatch(/font[^;}]*Inter|font[^;}]*JetBrains Mono/);
  });

  it("renders the fixture brief: finalists table, provenance link + fetchedAt, sponsored badge", () => {
    const html = renderWithWidgetCode(FIXTURE_BRIEF);
    // Finalists table with real content.
    expect(html).toContain("Wool Runner &lt;script&gt;alert(1)&lt;/script&gt;"); // escaped, never executable
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("98.00 USD");
    expect(html).toContain('href="https://ebay.example/p/o1"');
    expect(html).toContain("(fetched 2026-07-04T09:00:00.000Z)");
    expect(html).toContain("trust-signal:seed-list");
    // Why-this against the user's criteria.
    expect(html).toContain("price: lowest price: 9800 USD");
    // Sponsored badge on the sponsored finalist only.
    expect(html.split(WIDGET_SPONSORED_BADGE)).toHaveLength(2);
    expect(html).toContain('<section class="finalists" aria-label="Finalists">');
    expect(html).toContain('<article class="frow is-verified">');
    expect(html).toContain("source for price");
  });

  it("labels an unknown-placement browser observation without falsely calling it sponsored", () => {
    const observed: BuyersBrief = {
      ...FIXTURE_BRIEF,
      finalists: [
        {
          ...FIXTURE_BRIEF.finalists[0]!,
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

    const html = renderWithWidgetCode(observed);
    expect(html).toContain("AGENT-OBSERVED · reported from product page at 2026-08-16T10:00:00.000Z · not independently verified");
    expect(html).toContain("PLACEMENT NOT CONFIRMED · treated like sponsored for ranking");
    expect(html).not.toContain(WIDGET_SPONSORED_BADGE);
  });

  it("coverage footer lists EVERY store including the blocked one; rejected appendix carries eliminating criteria", () => {
    const html = renderWithWidgetCode(FIXTURE_BRIEF);
    expect(html).toContain("<strong>ebay</strong>: searched (3 offer(s))");
    expect(html).toContain("<strong>amazon</strong>: blocked (0 offer(s)) — blocked: bot check triggered");
    expect(html).toContain("<strong>etsy</strong>: not_configured (0 offer(s)) — not_configured: ETSY_API_KEY not set");
    expect(html).toContain("Every registered store is listed — nothing was silently skipped.");
    expect(html).toContain("Overpriced Runner");
    expect(html).toContain("over budget: price 15000 USD exceeds budget 12000 USD");
  });

  it("zero finalists renders the honest empty state (never padded)", () => {
    const html = renderWithWidgetCode({ ...FIXTURE_BRIEF, finalists: [] });
    expect(html).toContain("No offer met your criteria — nothing is padded in to fill the list.");
    expect(html).not.toContain("<table");
    expect(html).toContain("Review or broaden your criteria, then search again.");
  });

  it("widget constants match the SEP-1865 conventions (ui:// scheme + mcp-app profile)", () => {
    expect(BRIEF_WIDGET_URI).toBe("ui://northcinder/buyers-brief");
    expect(BRIEF_WIDGET_MIME).toBe("text/html;profile=mcp-app");
  });
});

describe("widget URL hardening regression", () => {
  it("a javascript: finalist URL is rendered as plain text — never an <a href>", () => {
    const hostile: BuyersBrief = {
      ...FIXTURE_BRIEF,
      finalists: [
        {
          ...FIXTURE_BRIEF.finalists[0]!,
          title: "Hostile Offer",
          url: "javascript:alert(1)",
          provenance: { price: { source: "javascript:alert(2)" } },
        },
      ],
    };
    const html = renderWithWidgetCode(hostile);
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("Hostile Offer"); // still shown, just unlinked
    expect(html).not.toContain("<a href=\"javascript:alert(2)\"");
  });

  it("https finalist URLs still link (guard is scheme-scoped, not link-killing)", () => {
    const html = renderWithWidgetCode(FIXTURE_BRIEF);
    expect(html).toContain('href="https://ebay.example/p/o1"');
  });
});

describe("widget host bridge boundary", () => {
  it("binds postMessage to the embedding parent, its referrer origin, and the dedicated channel while retaining window.openai support", () => {
    expect(BRIEF_WIDGET_HTML).toContain("northcinder.buyers-brief.v1");
    expect(BRIEF_WIDGET_HTML).toContain("ev.source !== window.parent");
    expect(BRIEF_WIDGET_HTML).toContain("ev.origin !== trustedOrigin");
    expect(BRIEF_WIDGET_HTML).toContain("data.channel !== CHANNEL");
    expect(BRIEF_WIDGET_HTML).toContain("window.openai.toolOutput");
  });

  it("mounts only the trusted parent-origin-channel event; forged sibling, origin, channel, and referrerless events do nothing", () => {
    const harness = bridgeHarness("https://apps.example/host");
    const payload = { channel: "northcinder.buyers-brief.v1", brief: FIXTURE_BRIEF };
    harness.dispatch({ source: {}, origin: "https://apps.example", data: payload });
    harness.dispatch({ source: harness.parent, origin: "https://evil.example", data: payload });
    harness.dispatch({ source: harness.parent, origin: "https://apps.example", data: { brief: FIXTURE_BRIEF } });
    expect(harness.root.innerHTML).toBe("");
    harness.dispatch({ source: harness.parent, origin: "https://apps.example", data: payload });
    expect(harness.root.innerHTML).toContain("Wool Runner");

    const noReferrer = bridgeHarness("");
    noReferrer.dispatch({ source: noReferrer.parent, origin: "https://apps.example", data: payload });
    expect(noReferrer.root.innerHTML).toBe("");
  });

  it("preserves the MCP Apps window.openai bridge without any postMessage", () => {
    const harness = bridgeHarness("", { brief: FIXTURE_BRIEF });
    expect(harness.root.innerHTML).toContain("Wool Runner");
  });

  it("turns a malformed payload from the trusted bridge into a clear retry state", () => {
    const harness = bridgeHarness("https://apps.example/host");
    harness.dispatch({
      source: harness.parent,
      origin: "https://apps.example",
      data: { channel: "northcinder.buyers-brief.v1", brief: { finalists: "not-an-array" } },
    });
    expect(harness.root.innerHTML).toContain('role="alert"');
    expect(harness.root.innerHTML).toContain("Brief unavailable");
    expect(harness.root.innerHTML).toContain("Run the search again");
  });
});

describe("local trust evidence rendering (local trust evidence — display-only, never part of BuyersBrief itself)", () => {
  it("with no localTrustEvidence argument, renders exactly as before (brief shape untouched)", () => {
    const html = renderWithWidgetCode(FIXTURE_BRIEF);
    expect(html).not.toContain("Your local history");
  });

  it("with localTrustEvidence keyed by the finalist's collision-safe key, renders a distinct 'Your local history' block with the escaped detail", () => {
    const html = renderWithWidgetCode(FIXTURE_BRIEF, {
      "trusted.example": [
        { source: "local-orders", detail: "your history: 2 completed orders from this merchant, last delivered 2026-06-20 (local orders)" },
      ],
    }, { "ebay:o1": "trusted.example" });
    expect(html).toContain("Your local history");
    expect(html).toContain("your history: 2 completed orders from this merchant, last delivered 2026-06-20 (local orders)");
    // Still visually separate from (not merged into) the service provenance line.
    const provIdx = html.indexOf("provenance —");
    const localIdx = html.indexOf("Your local history");
    expect(provIdx).toBeGreaterThan(-1);
    expect(localIdx).toBeGreaterThan(provIdx);
  });

  it("a finalist with no matching entry in localTrustEvidence renders no local-history block for that row", () => {
    const html = renderWithWidgetCode(FIXTURE_BRIEF, { "some-other-merchant.example": [{ source: "local-orders", detail: "x" }] });
    expect(html).not.toContain("Your local history");
  });

  it("hostile detail text in localTrustEvidence is HTML-escaped, never executable markup", () => {
    const html = renderWithWidgetCode(FIXTURE_BRIEF, {
      "trusted.example": [{ source: "local-orders", detail: "<script>alert(1)</script>" }],
    }, { "ebay:o1": "trusted.example" });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("never renders one merchant's local history for a same-id merchant on another domain", () => {
    const brief: BuyersBrief = {
      ...FIXTURE_BRIEF,
      finalists: [
        { ...FIXTURE_BRIEF.finalists[0]!, offerId: "alpha-offer", sourceStore: "alpha", merchant: { id: "seller-1", name: "Alpha" } },
        { ...FIXTURE_BRIEF.finalists[1]!, offerId: "beta-offer", sourceStore: "beta", merchant: { id: "seller-1", name: "Beta" } },
      ],
    };
    const html = renderWithWidgetCode(
      brief,
      { "alpha.example#seller-1": [{ source: "local-orders", detail: "your history: Alpha only" }] },
      { "alpha:alpha-offer": "alpha.example#seller-1", "beta:beta-offer": "beta.example#seller-1" },
    );
    expect(html).toContain("your history: Alpha only");
    expect(html.match(/Your local history/g)).toHaveLength(1);
  });

  it("carries collision-safe local-evidence keys through the shipped MCP widget bridge", () => {
    const brief: BuyersBrief = {
      ...FIXTURE_BRIEF,
      finalists: [
        { ...FIXTURE_BRIEF.finalists[0]!, offerId: "alpha-offer", sourceStore: "alpha", merchant: { id: "seller-1", name: "Alpha" } },
        { ...FIXTURE_BRIEF.finalists[1]!, offerId: "beta-offer", sourceStore: "beta", merchant: { id: "seller-1", name: "Beta" } },
      ],
    };
    const harness = bridgeHarness("https://apps.example/embed");
    harness.dispatch({
      source: harness.parent,
      origin: "https://apps.example",
      data: {
        channel: "northcinder.buyers-brief.v1",
        structuredContent: {
          brief,
          localTrustEvidence: { "alpha.example#seller-1": [{ source: "local-orders", detail: "your history: Alpha only" }] },
          localTrustEvidenceKeys: { "alpha:alpha-offer": "alpha.example#seller-1", "beta:beta-offer": "beta.example#seller-1" },
        },
      },
    });
    expect(harness.root.innerHTML).toContain("your history: Alpha only");
    expect(harness.root.innerHTML.match(/Your local history/g)).toHaveLength(1);
  });
});
