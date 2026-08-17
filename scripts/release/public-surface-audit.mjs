#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  "client/scripts/build-mcpb.mjs", "client/scripts/validate-mcpb-manifest.mjs", "client/scripts/zip-lite.mjs",
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
  "site/public/llms.txt",
];

const INTERNAL_COPY_PATTERNS = [
  ["obsolete public-status disclaimer", /public (?:repository|coordinates?).{0,60}(?:do not exist|not configured)|not published by this source tree/i],
];

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
  ["local operator path", /\/home\/bsg(?:\/|\b)|\/mnt\/c\/Users\/Gamer(?:\/|\b)|[A-Za-z]:\\Users\\Gamer(?:\\|\b)/i],
  ["private commit email", /\bagenticcommerce@local\b/i],
  ["private IPv4 address", /\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b/],
];

// SHA-256 fingerprints let the public checker reject private vocabulary
// without republishing the vocabulary itself. Candidates are normalized to
// lowercase words and adjacent two-word phrases before hashing.
const PRIVATE_TOOL_HASHES = new Set([
  "c857d09db23e6822e3600bc06ad8d58f92ed62bc8efd81c753f77048662cb97d",
  "57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93",
  "09cf980b5ff304ac11b7f6d2c5c263da2a867425798ef5cc5d2ebcf55c4fcd23",
  "b225390a8984c8de4206c746772ab5ef2abb0a02bcb043da10f6d41c274d1a02",
  "556d1f14c80f008eb61334df7417e0adb53464a22552ce44913c435fd39f3fe5",
]);

const PRIVATE_PROCESS_HASHES = new Set([
  "0dabc0c8832b5ef3c1fdaad660ccbbb67611cc8c0fcc2d182ba6ba78f43c6995",
  "29be9f45c066041ace1f8132fe46097d2bafecf335b56753e782ff7933a65c10",
  "bce5837fb3b36b2275cf717231971ddee2de08523814a37042ea8b68c4231690",
  "df47229adfadbe30813dac4a4c7385e005297e3e6eb388fb76d737e36e754e9d",
  "a0933f51ba80cc6e9f729b0029c8962559093f2d73a7add759bc2a8a128d0890",
  "a5144ed83fa9121d1e2d5eee2a4cb0511c470f7ce493732168765c7e6471a627",
  "b7e01797fe615533085892725f763a4c677e203abdf212103c9079efd5c6b3c2",
  "8ab9e162e73409ade00acc14be4907b5270abcc02b70daf3f5d64a8eb4c999ed",
  "db6f17e4e1b7c659cfd4347b3ce0df70ea783d394c7c74f4514e3e493405c694",
  "1d16a32028098bd74c0ee098b28e5af6415da5f9f773acd600319161c6532ebc",
  "759c562374c8a22f7a5e4aef15a50aacec4c70ed895ca5682258b524b1664d19",
  "be4765eb4b40373a51311583eac8c5b0555f312e5dc7ee3312d420261aaaf302",
  "0fcddd6228724be99b1dfb5d935e55e3de402dd64d969cc2a3b1f2a03ede2d12",
  "8d4392980a375524812037945a74a5cac7532d0a744a863b7b727a2a6a0f7681",
]);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function vocabularyCandidates(body) {
  const words = body.toLowerCase().match(/[a-z]+|\d+/g) ?? [];
  const candidates = new Set(words);
  for (let index = 0; index + 1 < words.length; index += 1) {
    candidates.add(`${words[index]} ${words[index + 1]}`);
    candidates.add(`${words[index]}${words[index + 1]}`);
  }
  return candidates;
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
      path.startsWith("service/scripts/") || path.startsWith("packages/checkout/scripts/") ||
      (hidden && !ALLOWED_TOP_LEVEL_FILES.has(path));
    return disallowed ? [`${path}: internal-only or unreviewed public path is tracked`] : [];
  });
}

export function publicCopyFindings(path, body) {
  return INTERNAL_COPY_PATTERNS
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

export function internalToolFindings(path, body) {
  const candidates = vocabularyCandidates(body);
  return [...candidates].some((candidate) => PRIVATE_TOOL_HASHES.has(digest(candidate)))
    ? [`${path}: references a private development tool or model`]
    : [];
}

export function internalProcessFindings(path, body) {
  const candidates = vocabularyCandidates(body);
  const words = body.toLowerCase().match(/[a-z]+|\d+/g) ?? [];
  const hasNumberedFixLabel = words.some((word, index) => word === "fix" && /^\d+$/.test(words[index + 1] ?? ""));
  const legacyCompatibilityPath =
    path === ".env.example" ||
    path === "northcinder/bin/northcinder.js" ||
    path === "client/test/config.test.ts" ||
    path.startsWith("packages/protocol/src/config-dir.") ||
    path.startsWith("packages/protocol/test/config-dir.") ||
    path.startsWith("packages/checkout/src/mandate/canonical.") ||
    path.startsWith("packages/checkout/test/mandate.") ||
    path.startsWith("packages/checkout/test/built-process-compat.") ||
    path.startsWith("packages/checkout/test/fixtures/legacy-");
  return !legacyCompatibilityPath && (hasNumberedFixLabel || [...candidates].some((candidate) => PRIVATE_PROCESS_HASHES.has(digest(candidate))))
    ? [`${path}: references private release/process or former-identity vocabulary`]
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
    if (record.authorEmail !== "jdshfhds@users.noreply.github.com") findings.push(`history: unexpected public author email ${JSON.stringify(record.authorEmail)}`);
    if (record.committerName !== "NorthCinder maintainers") findings.push(`history: unexpected public committer name ${JSON.stringify(record.committerName)}`);
    if (record.committerEmail !== "jdshfhds@users.noreply.github.com") findings.push(`history: unexpected public committer email ${JSON.stringify(record.committerEmail)}`);
    const metadata = `${record.subject}\n${record.body}`;
    findings.push(...sensitiveTextFindings("history", metadata));
    findings.push(...internalToolFindings("history", metadata));
    findings.push(...internalProcessFindings("history", metadata));
  }
  return findings;
}

export function runAudit({ requireRootHistory = false } = {}) {
  const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  const findings = forbiddenPathFindings(tracked);
  const trackedSet = new Set(tracked);

  for (const path of PUBLIC_AUDIENCE_FILES) {
    if (!trackedSet.has(path)) findings.push(`${path}: required public file is not tracked`);
  }

  for (const path of tracked) {
    const body = textFile(path);
    if (body === null) continue;
    findings.push(...sensitiveTextFindings(path, body));
    findings.push(...internalToolFindings(path, body));
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

  return { findings, trackedCount: tracked.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requireRootHistory = process.argv.includes("--release-root");
  const result = runAudit({ requireRootHistory });
  if (result.findings.length > 0) {
    for (const finding of result.findings) process.stderr.write(`[public-surface] ${finding}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`[public-surface] PASS (${result.trackedCount} tracked paths; internal paths, public copy, secrets, links${requireRootHistory ? ", and public history" : ""} clean)\n`);
  }
}
