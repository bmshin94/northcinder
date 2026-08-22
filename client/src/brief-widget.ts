import { BRAND_NAME } from "./brand.js";

/**
 * MCP Apps (SEP-1865) buyer's-brief widget — a self-contained vanilla HTML/JS
 * comparison card the host renders in a sandboxed iframe.
 *
 * Wire convention (SEP-1865, dated spec 2026-01-26, followed manually — the
 * SDK v1.x in this repo has resources + tool `_meta` but no dedicated Apps
 * helpers):
 *   - the UI is a predeclared resource with a `ui://` URI and mimeType
 *     `text/html;profile=mcp-app`;
 *   - tools link to it via `_meta.ui.resourceUri` (we also emit the flat
 *     `"ui/resourceUri"` alias seen in earlier SEP drafts, for host compat).
 *
 * Content discipline (safety contract): everything rendered is composed by CODE from the
 * brief JSON the tool returned — no model-generated content, and every value
 * is HTML-escaped. Markdown (renderBriefMarkdown) is the universal fallback
 * for hosts without Apps support.
 *
 * Styling uses hairline rows rather than card chrome, tabular-mono money/provenance, a status-dot
 * (never a pill) for the criteria winner, a
 * quiet amber flag chip for sponsored/unknown-merchant rows, and an honest per-store
 * coverage footer. "Criteria winner" is a client-side presentational label (no such field
 * exists on BuyersBrief/BriefFinalist) derived as the first non-sponsored finalist — safe
 * because the ranking's own sponsored-deprioritization tier invariant guarantees a
 * sponsored offer can only occupy that position if there is no non-sponsored finalist at
 * all, in which case no winner badge is shown.
 */

export const BRIEF_WIDGET_URI = "ui://northcinder/buyers-brief";
export const BRIEF_WIDGET_MIME = "text/html;profile=mcp-app";
export const BRIEF_WIDGET_IMAGE_ORIGINS = [
  "https://cdn.shopify.com",
  "https://i.ebayimg.com",
  "https://i.sandbox.ebayimg.com",
  "https://i.etsystatic.com",
  "https://m.media-amazon.com",
] as const;
export const BRIEF_WIDGET_RESOURCE_META = {
  ui: {
    csp: {
      connectDomains: [],
      frameDomains: [],
      resourceDomains: [...BRIEF_WIDGET_IMAGE_ORIGINS],
    },
  },
};

/** Exact badge text on sponsored finalist rows (mirrors the markdown badge claim). */
export const WIDGET_SPONSORED_BADGE = "SPONSORED · labeled, never ranked above organic results";
export const WIDGET_UNKNOWN_PLACEMENT_BADGE = "PLACEMENT NOT CONFIRMED · treated like sponsored for ranking";

/**
 * The widget's pure rendering code: `renderBuyersBrief(brief) → html string`.
 * Deliberately DOM-free so the same code is exercised headlessly (node:vm)
 * by the test suite — what the tests run is byte-identical to what ships.
 */
export const WIDGET_RENDER_JS = `
function escHtml(v) {
  return String(v).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function moneyFmt(m) {
  return (m.amount / 100).toFixed(2) + " " + m.currency;
}
function safeHttpsUrl(u) {
  try {
    var parsed = new URL(String(u));
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed : null;
  } catch (_) {
    return null;
  }
}
function listHtml(items) {
  if (!items.length) return "";
  return "<ul class=\\"f-why\\">" + items.map(function (i) { return "<li>" + escHtml(i) + "</li>"; }).join("") + "</ul>";
}
function provenanceHtml(prov) {
  var cells = Object.keys(prov).map(function (cell) {
    var p = prov[cell];
    var label = escHtml(cell);
    var fetched = p.fetchedAt ? " <span class=\\"muted\\">(fetched " + escHtml(p.fetchedAt) + ")</span>" : "";
    var sourceUrl = safeHttpsUrl(p.source);
    if (sourceUrl) {
      return label + ": <a class=\\"mono\\" href=\\"" + escHtml(sourceUrl.href) + "\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\">source for " + label + "</a>" + fetched;
    }
    return label + ": <span class=\\"mono\\">" + escHtml(p.source) + "</span>" + fetched;
  });
  return cells.join(" · ");
}
function roleLabel(role) {
  return ({ top_fit: "TOP FIT", lower_risk: "LOWER RISK", budget_or_different: "BUDGET OR DIFFERENT" })[role] || "CANDIDATE";
}
function trustFlagHtml(trustLevel) {
  if (trustLevel === "unknown") return "<span class=\\"flag-chip\\">unknown merchant</span>";
  if (trustLevel === "flagged") return "<span class=\\"flag-chip\\">flagged merchant</span>";
  return "";
}
/**
 * Local trust evidence (local trust evidence): "your history: N completed
 * orders..." lines, keyed by the collision-safe trust key in a SIBLING map alongside
 * brief (never a field on the brief/finalist itself — the brief's own shape
 * is untouched, see client/src/local-trust-evidence.ts). Rendered under its
 * own "Your local history" heading, visually distinct from the
 * service-sourced provenance line above it.
 */
function localTrustEvidenceHtml(localTrustEvidence, trustKey) {
  var lines = localTrustEvidence && trustKey && localTrustEvidence[trustKey];
  if (!lines || !lines.length) return "";
  var items = lines.map(function (e) { return "<li>" + escHtml(e.detail) + "</li>"; }).join("");
  return "<div class=\\"f-local-history\\"><h3>Your local history</h3><ul>" + items + "</ul></div>";
}
function safeImageHtml(f) {
  var imageUrl = safeHttpsUrl(f.imageUrl);
  if (!imageUrl) return "";
  var href = escHtml(imageUrl.href);
  var label = "Open image for " + escHtml(f.title);
  var allowedOrigins = [
    "https://cdn.shopify.com",
    "https://i.ebayimg.com",
    "https://i.sandbox.ebayimg.com",
    "https://i.etsystatic.com",
    "https://m.media-amazon.com"
  ];
  if (allowedOrigins.indexOf(imageUrl.origin) === -1) {
    return "<a class=\\"f-image-link\\" href=\\"" + href + "\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\" aria-label=\\"" + label + "\\">" + label + "</a>";
  }
  return "<a class=\\"f-image-link\\" href=\\"" + href + "\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\" aria-label=\\"" + label + "\\"><img class=\\"f-image\\" src=\\"" + href + "\\" alt=\\"\\" loading=\\"lazy\\" referrerpolicy=\\"no-referrer\\"></a>";
}
function decisionFactsHtml(f) {
  var variant = f.productIdentity && f.productIdentity.variant ? f.productIdentity.variant : "variant unknown";
  var landed = f.landedCost ? moneyFmt(f.landedCost.knownTotal) + " " + f.landedCost.completeness : "landed cost unknown";
  var freshness = f.freshness && f.freshness.status === "known" ? "observed " + f.freshness.observedAt : "freshness unknown";
  var verification = f.verificationState || "verification unknown";
  var seller = f.sellerState || f.trustLevel || "seller unknown";
  var unknowns = f.importantUnknowns && f.importantUnknowns.length ? f.importantUnknowns.map(function (item) { return escHtml(item); }).join("; ") : "none recorded";
  return "<dl class=\\"f-facts\\">" +
    "<div><dt>original rank</dt><dd>" + escHtml(f.rank) + "</dd></div>" +
    "<div><dt>variant</dt><dd>" + escHtml(variant) + "</dd></div>" +
    "<div><dt>landed cost</dt><dd>" + escHtml(landed) + "</dd></div>" +
    "<div><dt>seller</dt><dd>" + escHtml(seller) + "</dd></div>" +
    "<div><dt>freshness</dt><dd>" + escHtml(freshness) + "</dd></div>" +
    "<div><dt>verification</dt><dd>" + escHtml(verification) + "</dd></div>" +
    "<div><dt>downside</dt><dd>" + escHtml(f.decisiveDownside || "not assessed") + "</dd></div>" +
    "<div><dt>important unknowns</dt><dd>" + unknowns + "</dd></div>" +
    "</dl>";
}
function finalistRow(f, summary, localTrustEvidence, localTrustEvidenceKeys) {
  var badges = "";
  if (summary) badges += "<span class=\\"dot-verified\\">" + escHtml(roleLabel(summary.role)) + "</span>";
  if (f.acquisition && f.acquisition.kind === "agent_observed") {
    badges += "<span class=\\"flag-chip\\">AGENT-OBSERVED · reported from product page at " + escHtml(f.acquisition.observedAt) + " · not independently verified</span>";
  }
  if (f.acquisition && f.acquisition.placement === "unknown") {
    badges += "<span class=\\"flag-chip\\">${WIDGET_UNKNOWN_PLACEMENT_BADGE}</span>";
  } else if (f.sponsored) {
    badges += "<span class=\\"flag-chip\\">${WIDGET_SPONSORED_BADGE}</span>";
  }
  badges += trustFlagHtml(f.trustLevel);
  var badgesHtml = badges ? "<div class=\\"f-badges\\">" + badges + "</div>" : "";
  // Store-controlled URL: only HTTPS without credentials may become a link.
  var productUrl = safeHttpsUrl(f.url);
  var titleHtml = productUrl
    ? "<a href=\\"" + escHtml(productUrl.href) + "\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\">" + escHtml(f.title) + "</a>"
    : escHtml(f.title);
  var avail = escHtml(f.availability) + (f.deliveryBy ? " · by " + escHtml(f.deliveryBy) : "");
  var reasons = (f.whyThis || []).concat((f.tradeoffs || []).map(function (t) { return t.dimension + ": " + t.detail; }));
  var mainReason = f.whyThis && f.whyThis.length ? f.whyThis[0] : "No concise reason was supplied.";
  var rawReasons = (f.rawReasons || []).map(function (reason) { return escHtml(typeof reason === "object" ? JSON.stringify(reason) : reason); });
  var detail = "<details class=\\"f-details\\"><summary>Details and provenance</summary>" +
    (summary ? "<p class=\\"f-role-reason\\">" + escHtml(summary.roleReason) + "</p>" : "") +
    listHtml(reasons) +
    (rawReasons.length ? "<div class=\\"f-raw-reasons\\"><h3>Raw reasons</h3><ul>" + rawReasons.map(function (reason) { return "<li>" + reason + "</li>"; }).join("") + "</ul></div>" : "") +
    "<div class=\\"f-prov\\">provenance — " + provenanceHtml(f.provenance || {}) + "</div>" +
    localTrustEvidenceHtml(localTrustEvidence, localTrustEvidenceKeys && localTrustEvidenceKeys[f.sourceStore + ":" + f.offerId]) +
    "</details>";
  return (
    "<article class=\\"frow" + (summary ? " is-verified" : "") + (f.sponsored ? " is-sponsored" : "") + "\\">" +
    "<div class=\\"rank mono\\">" + escHtml(f.rank) + "</div>" +
    "<div class=\\"f-main\\">" +
    "<div class=\\"f-title\\">" + titleHtml + "</div>" +
    "<div class=\\"f-sub\\">" + escHtml(f.merchant.name) + " · " + escHtml(f.sourceStore) + "</div>" +
    "<p class=\\"f-main-reason\\">" + escHtml(mainReason) + "</p>" +
    badgesHtml +
    "</div>" +
    safeImageHtml(f) +
    "<div class=\\"f-side\\">" +
    "<div class=\\"f-price mono\\">" + escHtml(moneyFmt(f.price)) + "</div>" +
    "<div class=\\"f-avail\\">" + avail + "</div>" +
    "</div>" +
    decisionFactsHtml(f) +
    detail +
    "</article>"
  );
}
function coverageLine(c) {
  var detail = c.detail ? " — " + escHtml(c.detail) : "";
  return "<li class=\\"coverage-line coverage-" + escHtml(c.status) + "\\"><strong>" + escHtml(c.store) + "</strong>: " + escHtml(c.status) + " (" + escHtml(c.offerCount) + " offer(s))" + detail + "</li>";
}
function renderBuyersBrief(brief, localTrustEvidence, localTrustEvidenceKeys) {
  var decisionSummary = (brief.decisionSummary || []).slice(0, 3);
  var summaryByOffer = {};
  decisionSummary.forEach(function (summary) { summaryByOffer[summary.sourceStore + "\\u0000" + summary.offerId] = summary; });
  var summaries = decisionSummary.map(function (summary) {
    for (var i = 0; i < brief.finalists.length; i++) {
      var finalist = brief.finalists[i];
      if (finalist.sourceStore === summary.sourceStore && finalist.offerId === summary.offerId) return finalistRow(finalist, summary, localTrustEvidence, localTrustEvidenceKeys);
    }
    return "";
  }).join("");
  var readiness = summaries.length === 0 ? "provisional — no role-based candidate is ready" : decisionSummary.every(function (summary) {
    for (var i = 0; i < brief.finalists.length; i++) if (brief.finalists[i].sourceStore === summary.sourceStore && brief.finalists[i].offerId === summary.offerId) return brief.finalists[i].decisionStatus === "ready";
    return false;
  }) ? "ready" : "provisional — important evidence remains unresolved";
  var head =
    "<header class=\\"w-head\\"><h1>Buyer&#39;s brief</h1><p>\\u201C" + escHtml(brief.query.text) + "\\u201D — " +
    escHtml(brief.finalists.length) + " finalist(s) from " + escHtml(brief.offersConsidered) +
    " ranked offer(s) — " + escHtml(readiness) + ".</p></header>";
  var rows;
  if (brief.finalists.length === 0) {
    rows = "<div class=\\"empty\\"><p>No offer met your criteria — nothing is padded in to fill the list.</p><p>Review or broaden your criteria, then search again.</p></div>";
  } else {
    var more = brief.finalists.filter(function (f) { return !summaryByOffer[f.sourceStore + "\\u0000" + f.offerId]; });
    rows = "<section class=\\"finalists decision-summary\\" aria-label=\\"Decision summary\\">" + summaries + "</section>" +
      (more.length ? "<details class=\\"more-finalists\\"><summary>More finalists (" + escHtml(more.length) + ")</summary><section class=\\"finalists\\" aria-label=\\"More finalists\\">" + more.map(function (f) { return finalistRow(f, null, localTrustEvidence, localTrustEvidenceKeys); }).join("") + "</section></details>" : "");
  }
  var rejected =
    brief.rejected.length === 0
      ? ""
      : "<details class=\\"rejected\\"><summary>Rejected (" + escHtml(brief.rejected.length) + ")</summary><ul>" +
        brief.rejected.map(function (r) {
          return "<li>" + escHtml(r.title) + " <span class=\\"mono muted\\">(" + escHtml(r.sourceStore) + ":" + escHtml(r.offerId) + ")</span> — " + escHtml(r.eliminatedBy.join("; ")) + "</li>";
        }).join("") +
        "</ul></details>";
  var searched = 0, blocked = 0, notConfigured = 0;
  brief.coverage.forEach(function (c) {
    if (c.status === "searched") searched++;
    else if (c.status === "blocked") blocked++;
    else if (c.status === "not_configured") notConfigured++;
  });
  var summary =
    "searched " + searched + " store(s) · " + blocked + " blocked · " + notConfigured + " not configured — " +
    "Every registered store is listed — nothing was silently skipped.";
  var coverage =
    "<footer class=\\"coverage\\"><h2>Store coverage</h2><ul>" +
    brief.coverage.map(coverageLine).join("") +
    "</ul><p class=\\"coverage-footer\\">" + summary + "</p></footer>";
  return head + rows + rejected + coverage;
}
`;

/**
 * The complete widget document served as the `ui://` resource. The bootstrap
 * accepts the brief from the host bridge: a channel-bound SEP-1865-shaped
 * postMessage payload from the embedding parent, or the OpenAI Apps
 * `window.openai.toolOutput` global.
 */
export const BRIEF_WIDGET_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${BRAND_NAME} buyer's brief</title>
<style>
  /* Respects the host's light/dark preference; hairlines structure the ledger and color only
     identifies verified or flagged state. */
  :root {
    color-scheme: light dark;
    --paper: #FBFAF7;
    --ink: #1A1A17;
    --ink-2: #57544C;
    --line: #E6E2D9;
    --surface: #FFFFFF;
    --verified: #1F7A5C;
    --flag: #9C4A1C;
    --flag-tint: #F5E9E0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #14140F;
      --ink: #F2EFE7;
      --ink-2: #A6A296;
      --line: #2A2A22;
      --surface: #1B1B14;
      --verified: #4FB48C;
      --flag: #D98A5C;
      --flag-tint: #2E241B;
    }
  }
  * { box-sizing: border-box; }
  body {
    font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0;
    padding: 16px;
    background: var(--surface);
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .mono { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-variant-numeric: tabular-nums; }
  h1 { font-size: 15px; font-weight: 700; margin: 0 0 3px; letter-spacing: -0.01em; }
  h2 {
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--ink-2); margin: 0 0 6px;
  }
  .muted { color: var(--ink-2); }
  .w-head { margin-bottom: 14px; }
  .w-head p { margin: 0; color: var(--ink-2); font-size: 11.5px; line-height: 1.45; }

  .finalists { display: flex; flex-direction: column; }
  .frow {
    display: grid;
    grid-template-columns: 22px 1fr auto;
    gap: 10px;
    padding: 10px 0;
    border-top: 1px solid var(--line);
    align-items: start;
  }
  .finalists .frow:first-child { border-top: none; padding-top: 0; }
  .frow .rank { font-weight: 700; font-size: 12px; color: var(--ink-2); padding-top: 1px; }
  .frow.is-verified .rank { color: var(--verified); }

  .f-main .f-title { font-weight: 600; font-size: 13px; }
  .f-main .f-title a { display: inline-flex; align-items: center; min-height: 44px; color: inherit; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
  .f-main .f-sub { color: var(--ink-2); font-size: 11px; margin-top: 2px; }
  .f-main-reason { margin: 4px 0 0; color: var(--ink-2); font-size: 11px; line-height: 1.45; }
  .f-main .f-badges { margin-top: 5px; display: flex; gap: 6px; flex-wrap: wrap; }

  .dot-verified {
    display: inline-flex; align-items: center; gap: 4px;
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--verified);
  }
  .dot-verified::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--verified); display: inline-block; }

  /* Quiet flag chip: sponsored-deprioritized + unknown-merchant. NEVER visually
     louder than an organic row — no border, no shadow, small muted-amber wash. */
  .flag-chip {
    display: inline-flex; align-items: center;
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 9px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase;
    color: var(--flag); background: var(--flag-tint);
    padding: 1.5px 6px; border-radius: 3px;
  }

  .f-side { text-align: right; }
  .f-price { font-weight: 700; font-size: 13.5px; white-space: nowrap; }
  .f-avail { color: var(--ink-2); font-size: 10.5px; margin-top: 3px; }
  .f-image-link { grid-column: 2 / 3; display: inline-flex; width: 44px; min-height: 44px; margin-top: 6px; }
  .f-image { display: block; width: 44px; height: 44px; object-fit: cover; border: 1px solid var(--line); border-radius: 3px; }
  .f-facts { grid-column: 2 / 4; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px 12px; margin: 8px 0 0; }
  .f-facts div { min-width: 0; }
  .f-facts dt { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 9px; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-2); }
  .f-facts dd { margin: 1px 0 0; font-size: 10.5px; overflow-wrap: anywhere; }
  .f-details { grid-column: 2 / 4; margin-top: 7px; border-top: 1px solid var(--line); }
  .f-details summary, .more-finalists > summary { display: flex; align-items: center; min-height: 44px; cursor: pointer; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-2); }
  .f-role-reason { margin: 0 0 4px; font-size: 11px; color: var(--ink-2); }
  .f-raw-reasons h3 { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 9px; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-2); margin: 8px 0 2px; }
  .f-raw-reasons ul { margin: 0; padding-left: 14px; font-size: 10.5px; }
  .more-finalists { margin-top: 6px; padding-top: 8px; border-top: 1px solid var(--line); }

  .f-why { grid-column: 2 / 4; margin: 6px 0 0; padding-left: 0; list-style: none; }
  .f-why li { position: relative; padding-left: 12px; font-size: 11.5px; line-height: 1.55; }
  .f-why li::before { content: "\\00b7"; position: absolute; left: 0; color: var(--ink-2); }

  .f-prov { grid-column: 2 / 4; margin-top: 6px; color: var(--ink-2); font-size: 10.5px; }
  .f-prov a { display: inline-flex; align-items: center; min-height: 44px; color: inherit; }

  /* Trust-corpus local trust evidence: the user's OWN local order history — visually
     distinct from (never merged into) the service-sourced provenance line
     above it: a quiet labeled heading, no chip/badge (this is a fact, not a
     flag). */
  .f-local-history { grid-column: 2 / 4; margin-top: 4px; color: var(--ink-2); font-size: 10.5px; }
  .f-local-history h3 {
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 9px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
    margin: 0 0 2px; color: var(--ink-2);
  }
  .f-local-history ul { margin: 0; padding-left: 14px; }
  .f-local-history li { margin: 0; }

  .rejected { margin-top: 6px; padding-top: 10px; border-top: 1px solid var(--line); color: var(--ink-2); font-size: 11px; }
  .rejected summary {
    display: flex; align-items: center; min-height: 44px;
    cursor: pointer;
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 10.5px; letter-spacing: 0.03em; text-transform: uppercase;
  }
  .rejected ul { margin: 8px 0 0; padding-left: 14px; }
  .rejected li { margin-bottom: 4px; }

  .coverage { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
  .coverage ul { list-style: none; margin: 0; padding: 0; }
  .coverage-line { color: var(--ink-2); font-size: 11px; margin: 0 0 4px; }
  .coverage-line strong { color: var(--ink); }
  .coverage-blocked, .coverage-error { color: var(--flag); }
  .coverage-footer { margin-top: 6px; color: var(--ink-2); font-size: 10.5px; }

  .empty { color: var(--ink-2); }
  .empty p { margin: 0 0 6px; }
  .widget-error { padding: 12px; border: 1px solid var(--flag); background: var(--flag-tint); color: var(--ink); }
  .widget-error p { margin: 6px 0 0; }
  :focus-visible { outline: 3px solid var(--verified); outline-offset: 3px; }

  @media (max-width: 480px) {
    body { padding: 12px; }
    .frow { grid-template-columns: 18px minmax(0, 1fr); gap: 8px; }
    .f-side, .f-why, .f-prov, .f-local-history, .f-facts, .f-details { grid-column: 2 / 3; text-align: left; }
    .f-side { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
    .f-facts { grid-template-columns: 1fr; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      scroll-behavior: auto !important;
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }
</style>
</head>
<body>
<div id="root" class="empty-state" role="status" aria-live="polite"><p class="muted">Waiting for a buyer's brief from the host…</p></div>
<script>
${WIDGET_RENDER_JS}
(function () {
  if (typeof document === "undefined") return;
  function hasValidMountedBrief(brief) {
    if (!brief || !Array.isArray(brief.decisionSummary) || !Array.isArray(brief.finalists) || !Array.isArray(brief.rejected) || !Array.isArray(brief.coverage)) return false;
    if (brief.decisionSummary.length > 3) return false;
    var allowedRoles = { top_fit: true, lower_risk: true, budget_or_different: true };
    var roles = {};
    var tuples = {};
    var finalistCounts = {};
    for (var i = 0; i < brief.finalists.length; i++) {
      var finalist = brief.finalists[i];
      if (!finalist || typeof finalist.sourceStore !== "string" || finalist.sourceStore.trim().length === 0 || typeof finalist.offerId !== "string" || finalist.offerId.trim().length === 0) return false;
      var finalistKey = finalist.sourceStore + "\u0000" + finalist.offerId;
      finalistCounts[finalistKey] = (finalistCounts[finalistKey] || 0) + 1;
    }
    for (var j = 0; j < brief.decisionSummary.length; j++) {
      var summary = brief.decisionSummary[j];
      if (!summary || !allowedRoles[summary.role] || typeof summary.sourceStore !== "string" || summary.sourceStore.trim().length === 0 || typeof summary.offerId !== "string" || summary.offerId.trim().length === 0 || typeof summary.roleReason !== "string" || summary.roleReason.trim().length === 0) return false;
      if ((j === 0 && summary.role !== "top_fit") || roles[summary.role]) return false;
      var summaryKey = summary.sourceStore + "\u0000" + summary.offerId;
      if (tuples[summaryKey] || finalistCounts[summaryKey] !== 1) return false;
      roles[summary.role] = true;
      tuples[summaryKey] = true;
    }
    if (roles.lower_risk && roles.budget_or_different) {
      var lowerRiskIndex = brief.decisionSummary.findIndex(function (summary) { return summary.role === "lower_risk"; });
      var budgetIndex = brief.decisionSummary.findIndex(function (summary) { return summary.role === "budget_or_different"; });
      if (lowerRiskIndex > budgetIndex) return false;
    }
    return true;
  }
  function mount(brief, localTrustEvidence, localTrustEvidenceKeys) {
    var root = document.getElementById("root");
    if (!hasValidMountedBrief(brief)) {
      root.innerHTML = '<section class="widget-error" role="alert"><h1>Brief unavailable</h1><p>The host sent an incomplete brief. Run the search again to retry.</p></section>';
      return;
    }
    try {
      root.innerHTML = renderBuyersBrief(brief, localTrustEvidence, localTrustEvidenceKeys);
    } catch (_) {
      root.innerHTML = '<section class="widget-error" role="alert"><h1>Brief unavailable</h1><p>The brief could not be displayed safely. Run the search again to retry.</p></section>';
    }
  }
  function extractBrief(data) {
    if (!data || typeof data !== "object") return null;
    if (data.params && data.params.structuredContent && data.params.structuredContent.brief) {
      return data.params.structuredContent.brief; // SEP-1865-shaped tool-result notification
    }
    if (data.structuredContent && data.structuredContent.brief) return data.structuredContent.brief;
    if (data.brief) return data.brief;
    return null;
  }
  // Trust-corpus local trust evidence: localTrustEvidence travels as a SIBLING of brief in
  // the same structured-content payload (search_products' output), never a
  // field on the brief object itself — the brief's own shape is untouched.
  function extractLocalTrustEvidence(data) {
    if (!data || typeof data !== "object") return undefined;
    if (data.params && data.params.structuredContent && data.params.structuredContent.localTrustEvidence) {
      return data.params.structuredContent.localTrustEvidence;
    }
    if (data.structuredContent && data.structuredContent.localTrustEvidence) return data.structuredContent.localTrustEvidence;
    if (data.localTrustEvidence) return data.localTrustEvidence;
    return undefined;
  }
  function extractLocalTrustEvidenceKeys(data) {
    if (!data || typeof data !== "object") return undefined;
    if (data.params && data.params.structuredContent && data.params.structuredContent.localTrustEvidenceKeys) {
      return data.params.structuredContent.localTrustEvidenceKeys;
    }
    if (data.structuredContent && data.structuredContent.localTrustEvidenceKeys) return data.structuredContent.localTrustEvidenceKeys;
    if (data.localTrustEvidenceKeys) return data.localTrustEvidenceKeys;
    return undefined;
  }
  // The Apps global is the preferred MCP Apps bridge. The legacy postMessage
  // fallback is deliberately narrow: only the embedding parent at the origin
  // named by document.referrer may send our dedicated channel. This prevents a
  // sibling frame or arbitrary origin from replacing a displayed brief.
  var CHANNEL = "northcinder.buyers-brief.v1";
  var trustedOrigin = "";
  try { trustedOrigin = document.referrer ? new URL(document.referrer).origin : ""; } catch (_) {}
  window.addEventListener("message", function (ev) {
    var data = ev.data;
    if (!trustedOrigin || ev.source !== window.parent || ev.origin !== trustedOrigin || !data || data.channel !== CHANNEL) return;
    mount(extractBrief(data), extractLocalTrustEvidence(data), extractLocalTrustEvidenceKeys(data));
  });
  if (typeof window.openai === "object" && window.openai && window.openai.toolOutput) {
    mount(
      extractBrief(window.openai.toolOutput) || window.openai.toolOutput.brief,
      extractLocalTrustEvidence(window.openai.toolOutput) || window.openai.toolOutput.localTrustEvidence,
      extractLocalTrustEvidenceKeys(window.openai.toolOutput) || window.openai.toolOutput.localTrustEvidenceKeys,
    );
  }
})();
</script>
</body>
</html>
`;
