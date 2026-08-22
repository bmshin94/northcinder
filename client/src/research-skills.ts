import { readFileSync } from "node:fs";

export type ResearchSkillId = "product-research" | "seller-research";

export interface ResearchChecklistItem {
  readonly id: string;
  readonly question: string;
  readonly required: true;
}

export interface ResearchSkillDefinition {
  readonly id: ResearchSkillId;
  readonly resourceUri: string;
  readonly promptName: string;
  readonly content: string;
  readonly checklist: readonly ResearchChecklistItem[];
}

export interface ResearchLimits {
  readonly maxQueries: number;
  readonly maxSourceReads: number;
  readonly reservedCounterevidenceQueries: number;
  readonly reservedCounterevidenceSourceReads: number;
}

const DEFAULT_ROOT = new URL("../research-skills/", import.meta.url);
const SKILLS = [
  {
    id: "product-research",
    path: "product-research/SKILL.md",
    resourceUri: "northcinder://research/product",
    promptName: "research_product",
  },
  {
    id: "seller-research",
    path: "seller-research/SKILL.md",
    resourceUri: "northcinder://research/seller",
    promptName: "research_seller",
  },
] as const;

function parseNumberMarker(value: string, id: ResearchSkillId): number {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "zero") return 0;
  if (value === "two") return 2;
  throw new Error(`${id} has a malformed research budget marker`);
}

export function researchLimitsFromContent(content: string, id: ResearchSkillId): ResearchLimits {
  const checklistIndex = /^## Checklist\r?$/m.exec(content)?.index ?? content.length;
  const budgetScope = content.slice(0, checklistIndex);
  const totals = [...budgetScope.matchAll(/at most (\d+) focused queries and (\d+) source reads\b/g)];
  const reservations = [
    ...budgetScope.matchAll(/Reserve (\w+) queries and (\w+) source reads for (?:contrary evidence|counterevidence)\./g),
  ];
  if (totals.length !== 1 || reservations.length !== 1) {
    throw new Error(`${id} has a missing, duplicate, or malformed research budget marker`);
  }
  const total = totals[0]!;
  const reserved = reservations[0]!;
  const limits = {
    maxQueries: Number(total[1]),
    maxSourceReads: Number(total[2]),
    reservedCounterevidenceQueries: parseNumberMarker(reserved[1]!, id),
    reservedCounterevidenceSourceReads: parseNumberMarker(reserved[2]!, id),
  };
  if (
    !Number.isSafeInteger(limits.maxQueries) ||
    !Number.isSafeInteger(limits.maxSourceReads) ||
    !Number.isSafeInteger(limits.reservedCounterevidenceQueries) ||
    !Number.isSafeInteger(limits.reservedCounterevidenceSourceReads) ||
    limits.maxQueries <= 0 ||
    limits.maxSourceReads <= 0 ||
    limits.reservedCounterevidenceQueries < 0 ||
    limits.reservedCounterevidenceSourceReads < 0 ||
    limits.reservedCounterevidenceQueries > limits.maxQueries ||
    limits.reservedCounterevidenceSourceReads > limits.maxSourceReads
  ) {
    throw new Error(`${id} has an unusable research budget`);
  }
  return limits;
}

function parseSkill(
  root: URL,
  coordinate: (typeof SKILLS)[number],
): ResearchSkillDefinition {
  const skillUrl = new URL(coordinate.path, root);
  let content: string;
  try {
    content = readFileSync(skillUrl, "utf8");
  } catch (error) {
    throw new Error(`cannot load canonical ${coordinate.id} file ${coordinate.path}`, { cause: error });
  }

  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const frontmatterBody = frontmatter?.[1];
  const name = frontmatterBody?.match(/^name: ([^\r\n]+)$/m)?.[1];
  const description = frontmatterBody?.match(/^description: ([^\r\n]+)$/m)?.[1];
  if (name !== coordinate.id || !description?.trim()) {
    throw new Error(`${coordinate.id} has missing or malformed frontmatter`);
  }

  researchLimitsFromContent(content, coordinate.id);

  const checklistHeader = /^## Checklist\r?\n/m.exec(content);
  if (!checklistHeader) throw new Error(`${coordinate.id} has a missing or malformed checklist`);
  const checklistTail = content.slice(checklistHeader.index + checklistHeader[0].length);
  const nextHeader = /^## /m.exec(checklistTail);
  const checklistSection = nextHeader ? checklistTail.slice(0, nextHeader.index) : checklistTail;
  const checklist: ResearchChecklistItem[] = [];
  const seen = new Set<string>();
  for (const line of checklistSection.split(/\r?\n/).filter((candidate) => candidate.trim().length > 0)) {
    const marker = line.match(/^- \[ \] `([a-z0-9.-]+)` — (\S.*)$/);
    if (!marker || !marker[1]!.startsWith(`${coordinate.id === "product-research" ? "product" : "seller"}.`)) {
      throw new Error(`${coordinate.id} has a malformed checklist marker`);
    }
    const id = marker[1]!;
    if (seen.has(id)) throw new Error(`duplicate checklist identifier ${id} in ${coordinate.id}`);
    seen.add(id);
    checklist.push({ id, question: marker[2]!, required: true });
  }
  if (checklist.length === 0) throw new Error(`${coordinate.id} has a missing or malformed checklist`);

  return {
    id: coordinate.id,
    resourceUri: coordinate.resourceUri,
    promptName: coordinate.promptName,
    content,
    checklist,
  };
}

export function loadResearchSkillPack(root: URL = DEFAULT_ROOT): readonly ResearchSkillDefinition[] {
  return SKILLS.map((coordinate) => parseSkill(root, coordinate));
}
