---
name: product-research
description: Use when researching or comparing a specific product, model, or variant for a buying decision, especially when specifications conflict, fit or compatibility matters, retailer copy dominates, or the evidence may be incomplete.
---

# Product research

Treat a product conclusion as evidence bound to one exact purchasable subject, not a conclusion about a product family. Keep a provisional result visibly provisional; do not turn missing evidence into a score or a recommendation.

## Required research contract

Ask these questions before binding claims; record an unanswered question as an identity or evidence unknown:

- "What will you use it for?"
- "What are the deal-breakers?"
- "What must it fit or work with?"
- "Which exact variant, size, and region are you considering?"

Resolve the buyer's intended use and non-negotiables before searching. Capture the exact subject identity as brand, model, generation/year, regional or sizing line, size, color/material, configuration, and SKU/part number where available. If any identity field affects a claim, do not infer it from a related variant.

Use this source ladder in order. A lower rung can corroborate or suggest a lead, but cannot silently replace a blocked higher rung.

1. Manufacturer product page, manual, technical sheet, warranty/repair policy, or regulatory filing for stated facts and compatibility.
2. Independent measurements, laboratory work, teardown, or hands-on test for performance and failure modes.
3. Owner reports for durability, lived fit, maintenance burden, and recurring return reasons; distinguish anecdotes from patterns.
4. Retailer, seller, or affiliate material only as a quarantined claim, marked with its commercial relationship and never counted as independent confirmation.

Classify a purported review or test from evidence of its relationship, not its title. Inspect its disclosure, outbound links, funder, author/publisher, editorial policy, review-unit terms, and source wording before assigning its source type:

- **Independent:** the source documents independent editorial control and no relevant manufacturer, retailer, affiliate, or sponsor funding; record it as an independent test/review.
- **Commercial assertion:** a manufacturer-authored page stays `primary` for what its maker says and uses `commercial_claim`; a third-party source with an affiliate link or commission, retailer/manufacturer funding or editorial control, sponsored placement, or copied retailer specification is `commercial` and uses `commercial_claim`.
- **Unknown relationship:** a supplied review unit, missing/ambiguous disclosure, or unresolved funding/editorial control remains commercial/unknown until independence is evidenced; use it as a lead or quarantined claim, not independent confirmation.

Run a bounded pass: at most 8 focused queries and 12 source reads for one variant, unless the buyer authorizes more. Start with identity and primary facts, then read at least one independent/disinterested source when it is available. Reserve two queries and two source reads for contrary evidence. Stop expanding when the budget is exhausted and issue the applicable receipt below.

Use focused query recipes, replacing bracketed terms with the exact subject:

- `"[brand model exact variant]" manual OR technical specifications`
- `"[SKU or part number]" compatibility OR sizing OR dimensions`
- `"[brand model exact variant]" independent test OR measured OR teardown`
- `"[brand model exact variant]" problem OR failure OR return OR warranty`
- `site:[manufacturer-domain] "[model]" warranty OR repair OR recall`

Search contrary evidence even when initial evidence agrees: look for the most consequential plausible downside in the buyer's intended use (for example heat, sizing, battery degradation, leakage, breakage, service cost, or an incompatible interface). Record both a found downside and an honestly unresolved search.

## Checklist

- [ ] `product.identity` — Resolve the exact model, generation, size, and variant before binding any claim.
- [ ] `product.intended-use` — State the buyer's use, constraints, and deal-breakers that make evidence material.
- [ ] `product.primary-facts` — Prefer manufacturer, manual, regulatory, warranty, and repair evidence for stated facts.
- [ ] `product.independent-evidence` — Seek independent measurement or disinterested testing for consequential performance claims.
- [ ] `product.fit-compatibility` — Verify fit, sizing line, dimensions, interfaces, and required companion equipment against the buyer.
- [ ] `product.failure-modes` — Investigate category-specific failures, maintenance, durability, warranty, repairability, history, and return reasons.
- [ ] `product.counterevidence` — Complete the reserved contrary-evidence search and record the material downside or unresolved result.
- [ ] `product.commercial-claims` — Quarantine retailer, seller, and affiliate assertions as claims rather than independent evidence.
- [ ] `product.unknowns` — Maintain an explicit conflict and unknown ledger for decision-relevant gaps.
- [ ] `product.stop-receipt` — State whether research is complete or which observable stop condition makes the result provisional.

## Claim record and output

Set one `researchSubjectIdentity` before writing claims: the exact researched variant, including explicit `unresolved` fields where the buyer has not supplied them. Copy that string byte-for-byte into every claim's `subjectIdentity`, including claims about a wrong variant. `checklistIds` binds each claim to the still-open or satisfied work.

Classify every claim source with these enum values:

- `primary`: first-party manufacturer/maker pages, manuals, technical documents, regulatory records (including an exact-model absence record), warranty, repair, or policy sources. A manufacturer/maker product or marketing page is `primary` for what that party states, even when the assertion is promotional.
- `independent`: an evidenced disinterested test or review.
- `owner`: an actual owner report for the exact product identity, including the material size, width, and revision where those affect the claim; never use this for manufacturer ownership.
- `commercial`: retailer, seller, affiliate, or other non-manufacturer promotional material.
- `unknown`: a report or search record with unresolved exact-product identity (including material size or width), no publisher/source found, an unresolved relationship, or a search result that reports an absence.

Set `sourceUse` by the claim's role: `subject_evidence` for exact-subject factual support; `counterevidence` for a downside or contrary fact; `commercial_claim` for a promotional assertion; and `context_only` for a wrong variant, size, region, or lookalike. A manufacturer/maker promotional assertion is `primary` plus `commercial_claim`; manuals, technical documents, and regulatory facts are `primary` plus `subject_evidence` or `counterevidence` as applicable; retailer and affiliate assertions are `commercial` plus `commercial_claim`. `primary` never means independent.

Before `Claims`, build an internal one-source-ID-to-relationship ledger. A record's `ownership` field names its controller; it is not the `owner` enum. Assign only actual individual exact-product owner reports to `owner`; assign maker pages, manuals, and regulatory records (including an absence record) to `primary`.

Build `Claims` by iterating that ledger one relationship bucket at a time: set `sourceRelationship` to the current bucket and cite only source IDs from it. End `Claims` before writing any aggregate, conclusion, or cross-source synthesis. Put that synthesis and its cross-bucket source IDs in `conflicts` or the unknown ledger outside `Claims`.

```json
{
  "lane": "product",
  "checklistIds": ["product.identity", "product.primary-facts"],
  "subjectIdentity": "Brand Model, 2026, women's wide, US 8, charcoal, SKU ABC-8W-CH",
  "claim": "The manual lists a removable 200 Wh battery.",
  "sourceIds": ["manual-abc-2026"],
  "sourceRelationship": "primary",
  "sourceUse": "subject_evidence",
  "sourceUrl": "https://source.example/manual.pdf",
  "sourceType": "manufacturer manual",
  "observedAt": "2026-08-19T12:00:00Z",
  "confidence": "high",
  "conflicts": [],
  "unknowns": []
}
```

Return, in order: resolved identity; intended-use fit; **Claims** as one JSON array of claim objects; material downside; quarantined commercial claims; conflict/unknown ledger; sources searched; and a completion or stop receipt. Populate every material claim in that array with every field in the claim-object shape above; put supporting explanation after the array. If a structured boundary requests `checklistItemIds`, supply every canonical `product.*` ID considered, including open items, and retain the provisional/open stop receipt separately. Do not calculate a score unless the buyer supplied a scoring rule and the required evidence is sufficient.

## Stop conditions

Stop and mark the result **provisional** when any of these observable conditions applies:

- wrong variant: a source is for a different generation, sizing line, SKU, configuration, or region than the candidate;
- blocked primary evidence: a consequential manufacturer/manual/regulatory fact cannot be read or verified;
- incompatible identity: the buyer's required fit, interface, dimensions, or companion equipment conflicts with the exact candidate;
- insufficient evidence: the bounded pass ends with a decision-relevant unknown, unresolved conflict, or no usable independent evidence where performance is consequential.

Name the condition, remaining checklist IDs, source/read counts, and the one next evidence item that could change the result. A retailer or affiliate assertion cannot clear a stop condition by itself.

## Worked provisional example

Buyer: "I need a carry-on battery pack for a week of field work: USB-C laptop charging, under 100 Wh, repairable if possible. I use a 14-inch Laptop Q. Do not assume a score."

Resolved identity: **FictionalCo TrailCell 90, 2026 USB-C edition, 90 Wh, TC90-USBC-2026**. This is not a claim about TrailCell 60, the 2025 edition, or a retailer bundle.

```json
[
  {
    "lane": "product",
    "checklistIds": ["product.identity", "product.primary-facts", "product.fit-compatibility"],
    "subjectIdentity": "FictionalCo TrailCell 90, 2026 USB-C edition, 90 Wh, TC90-USBC-2026",
    "claim": "The product manual states 90 Wh and USB-C PD output up to 65 W.",
    "sourceIds": ["trailcell-90-2026-manual"],
    "sourceRelationship": "primary",
    "sourceUse": "subject_evidence",
    "sourceUrl": "https://docs.example.test/trailcell-90-2026-manual.pdf",
    "sourceType": "manufacturer manual",
    "observedAt": "2026-08-19T12:00:00Z",
    "confidence": "high",
    "conflicts": [],
    "unknowns": ["Laptop Q charging profile has not been verified against the exact 65 W port."]
  },
  {
    "lane": "product",
    "checklistIds": ["product.independent-evidence", "product.failure-modes", "product.counterevidence"],
    "subjectIdentity": "FictionalCo TrailCell 90, 2026 USB-C edition, 90 Wh, TC90-USBC-2026",
    "claim": "An independent teardown found the enclosure glued shut, making field battery replacement impractical.",
    "sourceIds": ["trailcell-90-2026-teardown"],
    "sourceRelationship": "independent",
    "sourceUse": "counterevidence",
    "sourceUrl": "https://lab.example.test/reviews/trailcell-90-2026-teardown",
    "sourceType": "independent teardown",
    "observedAt": "2026-08-19T12:05:00Z",
    "confidence": "medium",
    "conflicts": ["Manufacturer support page advertises repair support but does not identify replaceable parts or a process."],
    "unknowns": ["No long-term capacity-retention measurement was found within the budget."]
  },
  {
    "lane": "product",
    "checklistIds": ["product.primary-facts", "product.commercial-claims"],
    "subjectIdentity": "FictionalCo TrailCell 90, 2026 USB-C edition, 90 Wh, TC90-USBC-2026",
    "claim": "The maker marketing page says TrailCell 90 is easy to repair in the field.",
    "sourceIds": ["trailcell-90-maker-marketing"],
    "sourceRelationship": "primary",
    "sourceUse": "commercial_claim",
    "sourceUrl": "https://fictionalco.example.test/trailcell-90",
    "sourceType": "manufacturer marketing page",
    "observedAt": "2026-08-20T12:06:00Z",
    "confidence": "unverified",
    "conflicts": ["The independent teardown found a glued enclosure."],
    "unknowns": ["The page provides no parts, repair instructions, or field-repair evidence."]
  },
  {
    "lane": "product",
    "checklistIds": ["product.commercial-claims"],
    "subjectIdentity": "FictionalCo TrailCell 90, 2026 USB-C edition, 90 Wh, TC90-USBC-2026",
    "claim": "Seller says it charges every USB-C laptop and is easily repairable.",
    "sourceIds": ["trailcell-90-retailer-bundle"],
    "sourceRelationship": "commercial",
    "sourceUse": "commercial_claim",
    "sourceUrl": "https://shop.example.test/trailcell-90-bundle",
    "sourceType": "retailer claim",
    "observedAt": "2026-08-19T12:07:00Z",
    "confidence": "unverified",
    "conflicts": ["The teardown conflicts with the repairability assertion."],
    "unknowns": ["Seller did not identify the Laptop Q power profile." ]
  },
  {
    "lane": "product",
    "checklistIds": ["product.failure-modes", "product.counterevidence"],
    "subjectIdentity": "FictionalCo TrailCell 90, 2026 USB-C edition, 90 Wh, TC90-USBC-2026",
    "claim": "A 2025 TrailCell 60 teardown found corrosion after a wet-use test; it is a different model and cannot establish TrailCell 90 durability.",
    "sourceIds": ["trailcell-60-2025-teardown"],
    "sourceRelationship": "independent",
    "sourceUse": "context_only",
    "sourceUrl": "https://lab.example.test/reviews/trailcell-60-2025-teardown",
    "sourceType": "independent teardown for different model",
    "observedAt": "2026-08-19T12:08:00Z",
    "confidence": "low",
    "conflicts": [],
    "unknowns": ["The TrailCell 90 wet-use durability remains unmeasured."]
  }
]
```

Material downside: the independent teardown indicates poor repairability, directly conflicting with the buyer's preference. The maker marketing and retailer assertions remain quarantined and do not resolve that conflict.

Unknown ledger: exact Laptop Q charging compatibility; long-term capacity retention; manufacturer repair process. Sources searched: 6 queries, 9 reads, including 2 contrary-evidence queries and 2 reads.

If a structured boundary requests a checklist receipt, emit all considered IDs and keep the provisional/open state separate:

```json
{
  "checklistItemIds": ["product.identity", "product.intended-use", "product.primary-facts", "product.independent-evidence", "product.fit-compatibility", "product.failure-modes", "product.counterevidence", "product.commercial-claims", "product.unknowns", "product.stop-receipt"],
  "provisional": true,
  "openChecklistItemIds": ["product.fit-compatibility", "product.failure-modes", "product.unknowns"]
}
```

Stop receipt: **provisional — insufficient evidence**. Open work: fit/compatibility, failure modes, and unknowns. Do not recommend or score this exact variant until a primary charging-compatibility source and a concrete repair policy or parts path are found.
