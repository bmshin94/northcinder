import type { BriefFinalist, BuyersBrief } from "@northcinder/protocol";
import { BRAND_NAME } from "./brand.js";
import { formatMoney } from "./compose.js";

/**
 * Deterministic markdown renderer — the UNIVERSAL fallback path for hosts
 * without MCP Apps support. A fixed template over the brief JSON: no model,
 * no clock, no randomness. Same brief → byte-identical markdown.
 *
 * Injection discipline: every interpolated string that a store (or the
 * service) controls — titles, merchant names, error messages, reason details —
 * passes through `md()`: newlines collapse to a space and pipes are escaped,
 * so hostile content cannot forge its own lines, headings, or coverage-table
 * rows. `md()` is the identity on clean strings (snapshots unaffected).
 */

/** Exact badge attached to every sponsored finalist. */
export const SPONSORED_BADGE = "**SPONSORED** — paid placement, labeled and never ranked above organic results";
export const UNKNOWN_PLACEMENT_BADGE = "**PLACEMENT NOT CONFIRMED** — treated like sponsored for ranking";

/** Sanitize one inline value: no line breaks, no unescaped table pipes. */
function md(value: string | number): string {
  return String(value)
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");
}

function provenanceLines(finalist: BriefFinalist): string[] {
  return Object.entries(finalist.provenance).map(([cell, p]) => {
    const fetched = p.fetchedAt !== undefined ? ` (fetched ${md(p.fetchedAt)})` : "";
    return `  - ${md(cell)}: ${md(p.source)}${fetched}`;
  });
}

function finalistSection(f: BriefFinalist): string[] {
  const lines: string[] = [];
  const badges: string[] = [];
  if (f.acquisition?.kind === "agent_observed") {
    badges.push(
      `**AGENT-OBSERVED** — reported from the product page at ${md(f.acquisition.observedAt)}; not independently verified`,
    );
  }
  if (f.acquisition?.placement === "unknown") badges.push(UNKNOWN_PLACEMENT_BADGE);
  else if (f.sponsored) badges.push(SPONSORED_BADGE);
  const badge = badges.length > 0 ? ` — ${badges.join(" — ")}` : "";
  lines.push(
    `### ${f.rank}. ${md(f.title)} — ${formatMoney(f.price)} from ${md(f.merchant.name)} (via ${md(f.sourceStore)})${badge}`,
  );
  lines.push("");
  const facts = [
    `availability: ${md(f.availability)}`,
    ...(f.deliveryBy !== undefined ? [`promised delivery: ${md(f.deliveryBy)}`] : []),
    ...(f.trustLevel !== undefined ? [`merchant trust: ${md(f.trustLevel)}`] : []),
  ];
  lines.push(`_${facts.join(" · ")}_`);
  lines.push("");
  lines.push("**Why this (your criteria):**");
  for (const w of f.whyThis) lines.push(`- ${md(w)}`);
  lines.push("");
  lines.push("**Tradeoffs vs the other finalists:**");
  if (f.tradeoffs.length === 0) {
    lines.push("- none — no computed difference on price, delivery, trust, or spec");
  } else {
    for (const t of f.tradeoffs) lines.push(`- ${md(t.dimension)}: ${md(t.detail)}`);
  }
  lines.push("");
  lines.push("**Provenance:**");
  lines.push(...provenanceLines(f));
  lines.push("");
  return lines;
}

export function renderBriefMarkdown(brief: BuyersBrief): string {
  const lines: string[] = [];
  lines.push(`# ${BRAND_NAME} buyer's brief — "${md(brief.query.text)}"`);
  lines.push("");
  lines.push(
    `${brief.finalists.length} finalist(s) from ${brief.offersConsidered} ranked offer(s) (search ${md(brief.searchId)}). ` +
      `Composed deterministically by code from the neutrality ranking — deterministic and auditable.`,
  );
  lines.push("");
  lines.push("## Finalists");
  lines.push("");
  if (brief.finalists.length === 0) {
    lines.push("_No offer met your criteria — nothing is padded in to fill the list. See the rejected appendix._");
    lines.push("");
  } else {
    for (const f of brief.finalists) lines.push(...finalistSection(f));
  }
  lines.push("## Rejected (and the criteria that eliminated them)");
  lines.push("");
  if (brief.rejected.length === 0) {
    lines.push("_Nothing was rejected._");
  } else {
    for (const r of brief.rejected) {
      lines.push(`- ${md(r.title)} (${md(r.sourceStore)}:${md(r.offerId)}) — ${md(r.eliminatedBy.join("; "))}`);
    }
  }
  lines.push("");
  lines.push("## Store coverage");
  lines.push("");
  lines.push("| store | status | offers |");
  lines.push("| --- | --- | --- |");
  for (const c of brief.coverage) {
    const status = c.detail !== undefined ? `${md(c.status)} (${md(c.detail)})` : md(c.status);
    lines.push(`| ${md(c.store)} | ${status} | ${c.offerCount} |`);
  }
  lines.push("");
  lines.push("_Every registered store is listed above — nothing was silently skipped._");
  lines.push("");
  return lines.join("\n");
}
