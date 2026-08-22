#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const ALLOWED_TOP_LEVEL_FILES = new Set([
  ".env.example", ".gitignore", "CHANGELOG.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md",
  "LICENSE", "MANIFESTO.md", "README.md", "SECURITY.md", "SUPPORT.md", "eslint.config.mjs",
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "vitest.config.ts",
]);

const ALLOWED_DOC_PATHS = new Set([
  "docs/INDEPENDENCE.md", "docs/NEUTRALITY-AUDIT.md", "docs/RANKING.md", "docs/TRUST.md",
  "docs/brand/mark-on-tile.svg", "docs/brand/mark.svg", "docs/brand/wordmark.svg",
]);

const ALLOWED_RELEASE_PATHS = new Set([
  "scripts/release/astro-check.mjs", "scripts/release/audit.mjs", "scripts/release/mcp-manifest.mjs",
  "scripts/release/public-surface-audit.mjs", "scripts/release/test/audit.test.mjs",
  "scripts/release/test/mcp-manifest.test.mjs", "scripts/release/test/public-surface-audit.test.mjs",
  "scripts/release/test/release-typecheck.test.mjs", "scripts/release/test/northcinder-identity.test.mjs",
]);

const ALLOWED_CLIENT_SCRIPT_PATHS = new Set([
  "client/scripts/build-mcpb.mjs", "client/scripts/grade-research-skill-evals.mjs",
  "client/scripts/validate-mcpb-manifest.mjs", "client/scripts/zip-lite.mjs",
]);

const ALLOWED_GITHUB_PATHS = new Set([
  ".github/FUNDING.yml",
  ".github/ISSUE_TEMPLATE/bug-report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/feature-proposal.yml",
  ".github/pull_request_template.md",
]);

const ALLOWED_PUBLIC_MAINTAINER_EMAILS = new Set([
  "jdshfhds@users.noreply.github.com",
  "150383880+cinderline@users.noreply.github.com",
]);

const PUBLIC_AUDIENCE_FILES = [
  "README.md",
  "MANIFESTO.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CODE_OF_CONDUCT.md",
  "LICENSE",
  "docs/INDEPENDENCE.md",
  "docs/brand/mark.svg",
  "docs/brand/mark-on-tile.svg",
  "docs/brand/wordmark.svg",
  "remote/README.md",
  "site/src/pages/llms.txt.ts",
  "site/src/pages/install.astro",
  "site/src/pages/checkout-safety.astro",
];

const INTERNAL_COPY_PATTERNS = [
  ["obsolete public-status disclaimer", /public (?:repository|coordinates?).{0,60}(?:do not exist|not configured)|not published by this source tree/i],
];

const PATH_SPECIFIC_SEMANTIC_COPY_PATTERNS = new Map([
  ["site/src/pages/install.astro", [
    ["obsolete local-install credential copy", /local client key|buyer-run engine command/i],
  ]],
  ["site/src/pages/checkout-safety.astro", [
    ["unsupported variable-quantity copy", /exact number of units|different item or quantity/i],
  ]],
]);

const STANDALONE_COPY_PATTERNS = [
  ["NorthCinder-operated hosting claim", /\b(?:a|the) hosted NorthCinder (?:operator|service)\b|\bNorthCinder hosted remote MCP\b/i],
  ["hosting business claim", /\bintended business is (?:hosting|hosted operations)\b/i],
  ["closed-service product claim", /\bclosed service\b/i],
  ["external service-owner claim", /\bservice is someone else's to run\b/i],
  ["operator-issued runtime key", /\bAPI key issued by the operator\b/i],
  ["ambiguous same-user host warning", /\ba host running as the same OS user\b|\bhost itself must not access approval material\b/i],
  ["ambiguous repository-owner local-state wording", /\bowner-(?:local|readable)\b/i],
  ["repository-owned runtime endpoint", /https?:\/\/(?:api|app|cloud|mcp)\.northcinder\.(?:com|io|dev|app|ai|example)\b/i],
  ["telemetry dependency", /["'](?:@sentry\/[^"']+|posthog(?:-node|-js)?|analytics-node|mixpanel|amplitude-js|@segment\/[^"']+)["']\s*:/i],
];

const REQUIRED_STANDALONE_COPY = new Map([
  ["README.md", [
    "NorthCinder is software you run",
    "The repository owner does not operate a NorthCinder service",
    "does not send your searches, settings, or local history to the repository owner",
  ]],
  ["MANIFESTO.md", ["NorthCinder is published as software, not operated as a service"]],
  ["docs/INDEPENDENCE.md", ["No continuing relationship"]],
  ["remote/README.md", ["The NorthCinder repository owner does not run a bridge"]],
]);

const SENSITIVE_PATTERNS = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["OpenAI key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["Stripe live key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/],
  ["private commit email", /\bagenticcommerce@local\b/i],
  ["private IPv4 address", /\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b/],
];

const INTERNAL_POSITIONING_PATTERNS = [
  /\b(?:slice|batch)\s+\d+\b/i,
  /\bin this handoff\b/i,
  /\b(?:model|agent|host)[ -]tier\b|\b(?:weak|strong|fresh)[ -](?:model|agent)\b|\bfresh-agent\b/i,
  /\binternal(?:ly)?[ -](?:sample|evaluation|score|benchmark|run)s?\b/i,
  /\b(?:fix|review)\s+wave\b/i,
  /\b(?:spec|invariant)\s*(?:§|#|number\s*)\d+\b/i,
  /\b(?:determinism|safety contract)\s+law\b|\barchitectural test\b|\bdead[- ]code(?: history)?\b/i,
];

const SHIPPED_SOURCE_INTERNAL_PATTERNS = [
  /\b(?:slice|batch)\s+\d+\b/i,
];

const SYNTHETIC_OPERATOR_ROOTS = new Map([
  ["client/test/local-ui.test.ts", new Set(["/home/alice"])],
  ["packages/checkout/test/keystore.test.ts", new Set(["/home/u"])],
  ["scripts/release/public-surface-audit.mjs", new Set(["/home/private-operator", "/home/alice", "/home/u", "/mnt/c/users/synthetic-operator"])],
  ["scripts/release/test/public-surface-audit.test.mjs", new Set([
    "/home/private-operator",
    "/home/alice",
    "/home/u",
    "/mnt/c/users/synthetic-operator",
  ])],
]);

function isPublicPositioningPath(path) {
  return path === "history" ||
    path === "CHANGELOG.md" ||
    path === "docs/RANKING.md" ||
    path === "client/mcpb/manifest.json" ||
    path === "client/server.template.json" ||
    path === "site/src/pages/store-coverage.astro" ||
    path === "site/src/site-content.ts" ||
    path.endsWith("/package.json") ||
    path.endsWith("/README.md") ||
    path === "README.md" ||
    path.startsWith(".github/");
}

function git(args, options = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout;
}

export function forbiddenPathFindings(paths) {
  return paths.flatMap((path) => {
    const topLevel = !path.includes("/");
    const segments = path.split("/");
    const hidden = segments.some((segment) => segment.startsWith(".") && segment !== ".gitkeep");
    const disallowed =
      (topLevel && !ALLOWED_TOP_LEVEL_FILES.has(path)) ||
      (path.startsWith("docs/") && !ALLOWED_DOC_PATHS.has(path)) ||
      (path.startsWith("scripts/release/") && !ALLOWED_RELEASE_PATHS.has(path)) ||
      (path.startsWith("client/scripts/") && !ALLOWED_CLIENT_SCRIPT_PATHS.has(path)) ||
      (path.startsWith(".github/") && !ALLOWED_GITHUB_PATHS.has(path)) ||
      path.startsWith("service/scripts/") || path.startsWith("packages/checkout/scripts/") ||
      (hidden && !ALLOWED_TOP_LEVEL_FILES.has(path) && !ALLOWED_GITHUB_PATHS.has(path));
    return disallowed ? [`${path}: internal-only or unreviewed public path is tracked`] : [];
  });
}

export function publicCopyFindings(path, body) {
  return [...INTERNAL_COPY_PATTERNS, ...(PATH_SPECIFIC_SEMANTIC_COPY_PATTERNS.get(path) ?? [])]
    .filter(([, pattern]) => pattern.test(body))
    .map(([label]) => `${path}: ${label}`);
}

export function standaloneBoundaryFindings(path, body) {
  if (
    path === "scripts/release/public-surface-audit.mjs" ||
    path.startsWith("scripts/release/test/") ||
    /(?:^|\/)test(?:s)?\//.test(path) ||
    /\.test\.[cm]?[jt]s$/.test(path)
  ) return [];
  return STANDALONE_COPY_PATTERNS
    .filter(([, pattern]) => pattern.test(body))
    .map(([label]) => `${path}: ${label}`);
}

function missingStandaloneCopyFindings(path, body) {
  const normalized = body.replace(/\s+/g, " ");
  return (REQUIRED_STANDALONE_COPY.get(path) ?? [])
    .filter((required) => !normalized.includes(required))
    .map((required) => `${path}: missing standalone contract text ${JSON.stringify(required)}`);
}

export function sensitiveTextFindings(path, body) {
  const findings = SENSITIVE_PATTERNS
    .filter(([, pattern]) => pattern.test(body))
    .map(([label]) => `${path}: ${label}`);
  const localPathRoots = [...new Set([
    ...body.matchAll(/\/home\/[A-Za-z0-9._-]+/g),
    ...body.matchAll(/\/mnt\/[a-z]\/Users\/[A-Za-z0-9._ -]+/gi),
    ...body.matchAll(/[A-Za-z]:\\Users\\[^\\\r\n]+/g),
  ].map((match) => match[0].replaceAll("\\", "/").toLowerCase()))];
  const allowedRoots = SYNTHETIC_OPERATOR_ROOTS.get(path) ?? new Set();
  if (localPathRoots.some((candidate) => !allowedRoots.has(candidate))) {
    findings.push(`${path}: local operator path`);
  }
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[ \t]*=[ \t]*([^#]*)/);
    if (!match) continue;
    const value = match[1].trim().replace(/[;,]$/, "").replace(/^(['"])(.*)\1$/, "$2");
    if (value.length >= 16 && !/(?:test|fixture|example|placeholder|replace-me|dummy|changeme|generate|\$\{|process\.env)/i.test(value)) {
      findings.push(`${path}: possible assigned secret`);
    }
  }
  return findings;
}

export function internalProcessFindings(path, body) {
  const shippedSource = /^(?:(?:adapters|packages)\/[^/]+|client|northcinder|remote|service)\/src\//.test(path);
  const containsInternalProcess =
    (isPublicPositioningPath(path) && INTERNAL_POSITIONING_PATTERNS.some((pattern) => pattern.test(body))) ||
    (shippedSource && SHIPPED_SOURCE_INTERNAL_PATTERNS.some((pattern) => pattern.test(body)));
  return containsInternalProcess
    ? [`${path}: contains internal development or evaluation prose`]
    : [];
}

function textFile(path) {
  const body = readFileSync(resolve(root, path));
  if (body.includes(0)) return null;
  return body.toString("utf8");
}

function slugify(heading) {
  return heading.trim().toLowerCase().replace(/<[^>]+>/g, "")
    .replace(/[\u2018\u2019'"`*_:.,!?()[\]{}]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-")
    .replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function anchorsFor(body) {
  const anchors = new Set();
  const repeats = new Map();
  for (const match of body.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = slugify(match[1]);
    if (!base) continue;
    const count = repeats.get(base) ?? 0;
    repeats.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function markdownLinkFindings(path, body) {
  const findings = [];
  for (const match of body.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = match[1];
    if (/^(?:https?:|mailto:)/i.test(raw)) continue;
    const [targetPart, fragment = ""] = raw.split("#", 2);
    const absolute = targetPart ? resolve(root, dirname(path), decodeURIComponent(targetPart)) : resolve(root, path);
    const rel = relative(root, absolute);
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || !existsSync(absolute)) {
      findings.push(`${path}: broken local link ${raw}`);
      continue;
    }
    if (fragment && [".md", ".markdown"].includes(extname(absolute).toLowerCase())) {
      const anchors = anchorsFor(readFileSync(absolute, "utf8"));
      if (!anchors.has(decodeURIComponent(fragment).toLowerCase())) findings.push(`${path}: broken anchor ${raw}`);
    }
  }
  return findings;
}

export function commitMetadataFindings(records, { rootCount, mergeCount }) {
  const findings = [];
  if (rootCount !== 1) findings.push(`history: expected one sanitized root commit, found ${rootCount} roots`);
  if (mergeCount !== 0) findings.push(`history: expected linear public history, found ${mergeCount} merge commits`);
  for (const record of records) {
    if (record.authorName !== "NorthCinder maintainers") findings.push(`history: unexpected public author name ${JSON.stringify(record.authorName)}`);
    if (!ALLOWED_PUBLIC_MAINTAINER_EMAILS.has(record.authorEmail)) findings.push(`history: unexpected public author email ${JSON.stringify(record.authorEmail)}`);
    if (record.committerName !== "NorthCinder maintainers") findings.push(`history: unexpected public committer name ${JSON.stringify(record.committerName)}`);
    if (!ALLOWED_PUBLIC_MAINTAINER_EMAILS.has(record.committerEmail)) findings.push(`history: unexpected public committer email ${JSON.stringify(record.committerEmail)}`);
    const metadata = `${record.subject}\n${record.body}`;
    findings.push(...sensitiveTextFindings("history", metadata));
    findings.push(...internalProcessFindings("history", metadata));
  }
  return findings;
}

export function runAudit({ requireRootHistory = false } = {}) {
  const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const publicPaths = [...new Set([...tracked, ...untracked])].filter((path) => existsSync(resolve(root, path)));
  const findings = forbiddenPathFindings(publicPaths);
  const publicPathSet = new Set(publicPaths);

  for (const path of PUBLIC_AUDIENCE_FILES) {
    if (!publicPathSet.has(path)) findings.push(`${path}: required public file is missing from the publication candidate`);
  }

  for (const path of publicPaths) {
    const body = textFile(path);
    if (body === null) continue;
    findings.push(...sensitiveTextFindings(path, body));
    findings.push(...internalProcessFindings(path, body));
    findings.push(...standaloneBoundaryFindings(path, body));
    findings.push(...missingStandaloneCopyFindings(path, body));
    if (PUBLIC_AUDIENCE_FILES.includes(path)) {
      findings.push(...publicCopyFindings(path, body));
      if (path.endsWith(".md")) findings.push(...markdownLinkFindings(path, body));
    }
  }

  if (requireRootHistory) {
    const rootCount = git(["rev-list", "--max-parents=0", "HEAD"]).trim().split(/\r?\n/).filter(Boolean).length;
    const mergeCount = git(["rev-list", "--min-parents=2", "HEAD"]).trim().split(/\r?\n/).filter(Boolean).length;
    const fields = git(["log", "--format=%an%x00%ae%x00%cn%x00%ce%x00%s%x00%b%x00", "HEAD"]).split("\0");
    const records = [];
    for (let index = 0; index + 5 < fields.length; index += 6) {
      const record = {
        authorName: fields[index].trim(),
        authorEmail: fields[index + 1].trim(),
        committerName: fields[index + 2].trim(),
        committerEmail: fields[index + 3].trim(),
        subject: fields[index + 4].trim(),
        body: fields[index + 5].trim(),
      };
      if (!record.authorName && !record.authorEmail) continue;
      records.push(record);
    }
    findings.push(...commitMetadataFindings(records, { rootCount, mergeCount }));
  }

  return { findings, trackedCount: tracked.length, untrackedCount: untracked.length, reviewedCount: publicPaths.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requireRootHistory = process.argv.includes("--release-root");
  const result = runAudit({ requireRootHistory });
  if (result.findings.length > 0) {
    for (const finding of result.findings) process.stderr.write(`[public-surface] ${finding}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `[public-surface] PASS (${result.reviewedCount} present tracked/untracked candidate paths checked against the publication allowlist, generic internal-process and operator-path patterns, recognized secret patterns, standalone ownership claims, and public Markdown links${requireRootHistory ? "; reachable public history metadata also checked" : ""})\n`,
    );
  }
}
