import type { BriefFinalist, BuyersBrief, DecisionCandidateRole } from "@northcinder/protocol";
import { BRAND_NAME } from "./brand.js";
import { formatMoney } from "./compose.js";

/**
 * Deterministic markdown renderer — the UNIVERSAL fallback path for hosts
 * without MCP Apps support. A fixed template over the brief JSON: no model,
 * no clock, no randomness. Same brief → byte-identical markdown.
 *
 * Injection discipline: every interpolated string that a store (or the
 * service) controls — titles, merchant names, error messages, reason details —
 * passes through `md()`: newlines collapse to a space and Markdown control
 * characters are escaped, so hostile content cannot forge links, emphasis,
 * headings, or coverage-table rows. `md()` is the identity on text without
 * Markdown metacharacters.
 */

/** Exact badge attached to every sponsored finalist. */
export const SPONSORED_BADGE = "**SPONSORED** — paid placement, labeled and never ranked above organic results";
export const UNKNOWN_PLACEMENT_BADGE = "**PLACEMENT NOT CONFIRMED** — treated like sponsored for ranking";

/** Sanitize one inline value: no line breaks, no unescaped table pipes. */
function md(value: string | number): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/([`*_~!\[\]<>#])/g, "\\$1")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function markdownLink(label: string, url: string): string {
  return `[${md(label)}](<${url.replace(/>/g, "%3E")}>)`;
}

function roleHeading(role: DecisionCandidateRole): string {
  if (role === "top_fit") return "Top fit in this search";
  if (role === "lower_risk") return "Lower-risk alternative";
  return "Budget or different alternative";
}

function compactFinalistSection(f: BriefFinalist): string[] {
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
  const safeProductUrl = safeHttpUrl(f.url);
  const title = safeProductUrl === undefined ? md(f.title) : markdownLink(f.title, safeProductUrl);
  lines.push(`### #${f.rank} ${title} — ${md(f.merchant.name)} (via ${md(f.sourceStore)})${badge}`);
  lines.push("");
  const safeImageUrl = f.imageUrl === undefined ? undefined : safeHttpUrl(f.imageUrl);
  const facts = [
    `original rank: ${f.rank}`,
    `current price: ${formatMoney(f.price)}`,
    `availability: ${md(f.availability)}`,
    ...(f.deliveryBy !== undefined ? [`promised delivery: ${md(f.deliveryBy)}`] : []),
    `seller state: ${md(f.sellerState)}`,
    `verification: ${md(f.verificationState)}`,
    `readiness: ${md(f.decisionStatus)}`,
    `freshness: ${f.freshness.status === "known" ? `known at ${md(f.freshness.observedAt)}` : "unknown"}`,
    f.productIdentity !== undefined ? `exact variant: ${md(f.productIdentity.variant)}` : "exact variant: unknown",
    f.landedCost !== undefined ? `landed cost: ${formatMoney(f.landedCost.knownTotal)} (${md(f.landedCost.completeness)})` : "landed cost: not confirmed",
    ...(safeImageUrl !== undefined ? [`image: ${markdownLink("product image", safeImageUrl)}`] : []),
  ];
  lines.push(`_${facts.join(" · ")}_`);
  lines.push("");
  lines.push(`**Main ranking reason:** ${md(f.whyThis[0]!)}`);
  lines.push("");
  lines.push(`**Decisive downside:** ${md(f.decisiveDownside)}`);
  if (f.importantUnknowns.length > 0) {
    lines.push("");
    lines.push("**Important unknowns:**");
    for (const unknown of f.importantUnknowns) lines.push(`- ${md(unknown)}`);
  }
  lines.push("");
  return lines;
}

export function renderBriefMarkdown(brief: BuyersBrief): string {
  const lines: string[] = [];
  lines.push(`# ${BRAND_NAME} buyer's brief — "${md(brief.query.text)}"`);
  lines.push("");
  lines.push(`${brief.finalists.length} finalist(s) from ${brief.offersConsidered} ranked offer(s) (search ${md(brief.searchId)}). Composed deterministically by code from the neutrality ranking — deterministic and auditable.`);
  lines.push("");
  if (brief.decisionSummary.length === 0) {
    lines.push("## Top fit in this search");
    lines.push("");
    lines.push("_No offer met your criteria — nothing is padded in to fill the list. Structured details remain available when present._");
    lines.push("");
  } else {
    for (const summary of brief.decisionSummary.slice(0, 3)) {
      const finalist = brief.finalists.find((row) => row.sourceStore === summary.sourceStore && row.offerId === summary.offerId);
      if (finalist === undefined) continue;
      lines.push(`## ${roleHeading(summary.role)}`);
      lines.push("");
      lines.push(`**Why this role:** ${md(summary.roleReason)}`);
      lines.push("");
      lines.push(...compactFinalistSection(finalist));
    }
  }
  const additionalFinalists = Math.max(0, brief.finalists.length - brief.decisionSummary.length);
  const rawReasonCount = brief.finalists.reduce((count, finalist) => count + finalist.rawReasons.length, 0);
  lines.push(`${additionalFinalists} additional finalist(s), ${brief.rejected.length} rejected offer(s), and ${rawReasonCount} raw ranking reason(s) are available in structured/widget expansion.`);
  if (brief.unresolvedResearchQuestions.length > 0) {
    lines.push("");
    lines.push("**Unresolved research questions:**");
    for (const question of brief.unresolvedResearchQuestions) lines.push(`- ${md(question)}`);
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
