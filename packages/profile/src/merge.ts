/**
 * The deterministic profile-into-query merge behind the interpretation echo.
 *
 * Precedence is LAW: per-query criteria > profile defaults, always. A profile
 * entry only ever FILLS a gap; when the query already states the criterion,
 * the entry lands in `overriddenProfileEntries` instead — visible, never
 * silently dropped, never silently winning. Pure function: same query +
 * entries + clock → same interpretation, so the echo is auditable.
 */
import type {
  AppliedProfileEntry,
  InterpretedQuery,
  Money,
  OverriddenProfileEntry,
  ProfileEntry,
  SearchQuery,
} from "@northcinder/protocol";

function formatMoney(m: Money): string {
  return `${(m.amount / 100).toFixed(2)} ${m.currency}`;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** "sneakers" matches the tokens "sneakers" AND "sneaker" (naive plural fold). */
function categoryMatches(category: string, tokens: string[]): boolean {
  const cat = category.toLowerCase();
  const variants = new Set([cat, cat.endsWith("s") ? cat.slice(0, -1) : `${cat}s`]);
  return tokens.some((t) => variants.has(t));
}

/**
 * A per-query must-have that is the SAME size scheme as a profile size entry
 * but a DIFFERENT size (e.g. query "EU 38" vs profile "EU 43"): the query
 * wins outright — merging both sizes would downrank the offers the user
 * actually asked for (the gift scenario), a false positive worse than a miss.
 * Deliberately scoped to size entries: same alpha tokens (the scheme, e.g.
 * "eu"), both carrying numbers, numbers differing. No generic attribute
 * conflict logic.
 */
function conflictingSizeAttribute(entryValue: string, attributes: string[]): string | undefined {
  const isNum = (t: string) => /^\d/.test(t);
  const scheme = (tokens: string[]) => tokens.filter((t) => !isNum(t)).sort().join(" ");
  const numbers = (tokens: string[]) => tokens.filter(isNum).join(" ");
  const ev = tokenize(entryValue);
  if (numbers(ev) === "") return undefined;
  return attributes.find((a) => {
    const at = tokenize(a);
    return numbers(at) !== "" && scheme(at) === scheme(ev) && numbers(at) !== numbers(ev);
  });
}

function isoDatePlusDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function scopeMatches(entry: ProfileEntry, query: SearchQuery, tokens: string[]): boolean {
  if (entry.scope === undefined) return true;
  switch (entry.scope.kind) {
    case "subject":
      return query.buyerContext?.subject === entry.scope.value;
    case "project":
      return query.buyerContext?.project === entry.scope.value;
    case "category":
      return categoryMatches(entry.scope.value, tokens);
  }
}

export function interpretQuery(
  query: SearchQuery,
  entries: ProfileEntry[],
  now: () => Date = () => new Date(),
): InterpretedQuery {
  const tokens = tokenize(query.text);
  const currentTime = now();
  const eligibleEntries = entries.filter(
    (entry) => (entry.expiresAt === undefined || Date.parse(entry.expiresAt) > currentTime.getTime()) && scopeMatches(entry, query, tokens),
  );
  const criteria: SearchQuery = structuredClone(query);
  const applied: AppliedProfileEntry[] = [];
  const overridden: OverriddenProfileEntry[] = [];
  /** Categories consumed by an applied/overridden entry — those words WERE interpreted. */
  const interpretedCategories: string[] = [];

  const cite = (e: ProfileEntry, appliedTo: string, detail: string): AppliedProfileEntry => ({
    id: e.id,
    origin: e.origin,
    kind: e.kind,
    appliedTo,
    detail,
  });

  // ---- budget defaults (by category): fill maxPrice; latest matching entry wins
  const budgets = eligibleEntries
    .filter((e) => e.kind === "budget" && categoryMatches(e.category, tokens))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const budget = budgets[budgets.length - 1];
  if (budget && budget.kind === "budget") {
    const citation = cite(budget, "maxPrice", `budget for "${budget.category}": ${formatMoney(budget.maxPrice)}`);
    interpretedCategories.push(budget.category);
    if (criteria.maxPrice === undefined) {
      criteria.maxPrice = structuredClone(budget.maxPrice);
      applied.push(citation);
    } else {
      overridden.push({ ...citation, overriddenBy: "per-query maxPrice" });
    }
  }

  // ---- sizes (by category): append to mustHaveAttributes unless already stated
  for (const e of eligibleEntries) {
    if (e.kind !== "size" || !categoryMatches(e.category, tokens)) continue;
    const citation = cite(e, "mustHaveAttributes", `size for "${e.category}": ${e.value}`);
    interpretedCategories.push(e.category);
    const existing = criteria.mustHaveAttributes ?? [];
    const conflicting = conflictingSizeAttribute(e.value, existing);
    if (conflicting !== undefined) {
      overridden.push({ ...citation, overriddenBy: `per-query mustHaveAttributes (${JSON.stringify(conflicting)})` });
    } else if (existing.some((a) => a.toLowerCase() === e.value.toLowerCase())) {
      overridden.push({ ...citation, overriddenBy: "per-query mustHaveAttributes" });
    } else {
      criteria.mustHaveAttributes = [...existing, e.value];
      applied.push(citation);
    }
  }

  // ---- standing ethics flags: union into ethicsFlags (per-query flags first)
  for (const e of eligibleEntries) {
    if (e.kind !== "ethics") continue;
    const citation = cite(e, "ethicsFlags", `ethics flag "${e.flag}"`);
    const existing = criteria.ethicsFlags ?? [];
    if (existing.some((f) => f.toLowerCase() === e.flag.toLowerCase())) {
      overridden.push({ ...citation, overriddenBy: "per-query ethicsFlags" });
    } else {
      criteria.ethicsFlags = [...existing, e.flag];
      applied.push(citation);
    }
  }

  // ---- delivery default: fill deliveryBy = today + maxDays; tightest default wins
  const deliveries = eligibleEntries.filter((e) => e.kind === "delivery");
  const delivery = deliveries.reduce<(typeof deliveries)[number] | undefined>(
    (best, e) => (e.kind === "delivery" && (best === undefined || (best.kind === "delivery" && e.maxDays < best.maxDays)) ? e : best),
    undefined,
  );
  if (delivery && delivery.kind === "delivery") {
    const date = isoDatePlusDays(currentTime, delivery.maxDays);
    const citation = cite(delivery, "deliveryBy", `delivery within ${delivery.maxDays} day(s) → ${date}`);
    if (criteria.deliveryBy === undefined) {
      criteria.deliveryBy = date;
      applied.push(citation);
    } else {
      overridden.push({ ...citation, overriddenBy: "per-query deliveryBy" });
    }
  }

  // Brand + notification entries never touch SearchQuery: it has no brand or
  // notification field. They are exposed via get_profile for the host agent
  // to reason with — merging a brand preference into a hard filter would
  // silently turn a soft preference into an exclusion the user never asked for.

  // ---- honest fuzzy-only disclosure: query words no structured criterion covers
  const structuredTokens = new Set<string>();
  for (const v of criteria.mustHaveAttributes ?? []) for (const t of tokenize(v)) structuredTokens.add(t);
  for (const v of criteria.ethicsFlags ?? []) for (const t of tokenize(v)) structuredTokens.add(t);
  for (const c of interpretedCategories) {
    for (const t of tokenize(c)) {
      structuredTokens.add(t);
      structuredTokens.add(t.endsWith("s") ? t.slice(0, -1) : `${t}s`);
    }
  }
  const unmatchedQueryWords = tokens.filter((t) => !structuredTokens.has(t));

  return {
    criteria,
    appliedProfileEntries: applied,
    overriddenProfileEntries: overridden,
    unmatchedQueryWords,
  };
}
