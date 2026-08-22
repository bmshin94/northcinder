/** Offline Markdown-link check for public repository documentation. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s/g, "-");
}

function headingsOf(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of markdown.split("\n")) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    let slug = slugify(m[1]);
    const n = counts.get(slug) ?? 0;
    counts.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    slugs.add(slug);
  }
  return slugs;
}

function extractLinks(markdown: string): string[] {
  const links: string[] = [];
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) links.push(m[1]);
  return links;
}

function headingSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return "";
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join("\n");
}

export function checkMarkdownLinks(filePath: string): { link: string; reason: string }[] {
  const markdown = readFileSync(filePath, "utf8");
  const baseDir = dirname(filePath);
  const problems: { link: string; reason: string }[] = [];

  for (const raw of extractLinks(markdown)) {
    if (/^https?:\/\//.test(raw)) {
      try {
        new URL(raw);
      } catch {
        problems.push({ link: raw, reason: "malformed URL" });
      }
      continue;
    }
    if (raw.startsWith("mailto:")) continue;

    const [pathPart, anchor] = raw.split("#");
    if (pathPart) {
      const target = resolve(baseDir, pathPart);
      if (!existsSync(target)) {
        problems.push({ link: raw, reason: `no such file: ${target}` });
        continue;
      }
      if (anchor && target.endsWith(".md")) {
        const targetHeadings = headingsOf(readFileSync(target, "utf8"));
        if (!targetHeadings.has(anchor)) {
          problems.push({ link: raw, reason: `no heading "#${anchor}" in ${target}` });
        }
      }
    } else if (anchor) {
      // same-file anchor
      const headings = headingsOf(markdown);
      if (!headings.has(anchor)) {
        problems.push({ link: raw, reason: `no heading "#${anchor}" in ${filePath}` });
      }
    }
  }
  return problems;
}

describe("README.md links resolve", () => {
  it("has zero broken local links or malformed URLs", () => {
    const problems = checkMarkdownLinks(join(REPO_ROOT, "README.md"));
    expect(problems).toEqual([]);
  });

  it("has zero broken local links in the public docs", () => {
    for (const doc of ["docs/INDEPENDENCE.md", "docs/RANKING.md", "docs/TRUST.md"]) {
      const problems = checkMarkdownLinks(join(REPO_ROOT, doc));
      expect({ doc, problems }).toEqual({ doc, problems: [] });
    }
  });

  it("leads with the public launcher and states the buyer-controlled runtime boundary", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    const normalized = readme.replace(/\s+/g, " ");
    expect(readme.indexOf("npx northcinder init")).toBeGreaterThan(0);
    expect(readme.indexOf("npx northcinder init")).toBeLessThan(readme.indexOf("## How NorthCinder works"));
    expect(normalized).toContain("NorthCinder is software you run");
    expect(normalized).toContain("The repository owner does not operate a NorthCinder service");
    expect(normalized).toContain("does not send your searches, settings, or local history to the repository owner");
    expect(readme).not.toMatch(/hosted NorthCinder operator|intended business is host/i);
  });

  it("keeps ordinary local first run keyless and single-command while self-hosted auth stays explicit", () => {
    const rootReadme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    const packageReadme = readFileSync(join(REPO_ROOT, "northcinder/README.md"), "utf8");
    const localSetup = [
      headingSection(rootReadme, "Get started"),
      headingSection(packageReadme, "Set up NorthCinder"),
    ].join("\n");
    const selfHosted = [rootReadme, packageReadme]
      .map((doc) => headingSection(doc, "Self-hosted engine"))
      .join("\n");

    expect(localSetup.match(/^npx northcinder init\s*$/gm)).toHaveLength(2);
    expect(localSetup).not.toMatch(/--client-key|NORTHCINDER_(?:CLIENT_KEY|API_KEYS)|northcinder service/i);
    expect(localSetup).not.toMatch(/(?:generate|provide|set|require|need)[^.!\n]{0,80}(?:client |API )?key/i);
    expect(selfHosted).toMatch(/NORTHCINDER_SERVICE_URL/);
    expect(selfHosted).toMatch(/NORTHCINDER_API_KEYS/);
    expect(selfHosted).toMatch(/NORTHCINDER_CLIENT_KEY/);
    expect(selfHosted).toMatch(/bearer/i);
  });

  it("keeps the active source-checkout setup on the built launcher and one bounded local MCP entry", () => {
    const agents = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
    const setup = headingSection(agents, "Build and initialize");
    const normalized = setup.replace(/\s+/g, " ");

    expect(setup).toMatch(/corepack pnpm release:build/);
    expect(setup).toMatch(/node northcinder\/bin\/northcinder\.js init/);
    expect(setup).not.toMatch(/openssl|NORTHCINDER_DEV_KEY|--client-key|--server-entry|--service-entry/);
    expect(normalized).toMatch(/one MCP(?:-host)? entry/i);
    expect(normalized).toMatch(/bounded readiness/i);
  });

  it("reads as a public product page rather than an operator or maintainer handoff", () => {
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    const words = readme.trim().split(/\s+/);
    const lines = readme.split("\n");

    expect(words.length).toBeLessThanOrEqual(1_000);
    expect(lines.length).toBeLessThanOrEqual(150);
    expect(readme.slice(0, 700)).toMatch(/compare/i);
    expect(readme.slice(0, 700)).toMatch(/ask before buying|approval/i);
    expect(readme).not.toMatch(/^## (?:Configuration|Approval boundary|Verify|Repository map)$/m);
    expect(readme).not.toMatch(/127\.0\.0\.1|request_purchase_authorization|complete_checkout|release:build|release:typecheck|SHOPIFY_UCP_AGENT_PROFILE_URL|per-boot token|same OS user|child-process stderr/i);
  });
});
