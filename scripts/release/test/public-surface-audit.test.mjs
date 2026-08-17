import assert from "node:assert/strict";
import test from "node:test";
import {
  commitMetadataFindings,
  forbiddenPathFindings,
  internalProcessFindings,
  internalToolFindings,
  publicCopyFindings,
  sensitiveTextFindings,
  standaloneBoundaryFindings,
} from "../public-surface-audit.mjs";

test("rejects every documentation and release-script path not explicitly reviewed for publication", () => {
  const unreviewedPaths = ["docs/unreviewed/result.md", "scripts/release/private-check.mjs"];
  assert.deepEqual(forbiddenPathFindings(["README.md", ...unreviewedPaths]), [
    ...unreviewedPaths.map((path) => `${path}: internal-only or unreviewed public path is tracked`),
  ]);
});

test("rejects hidden tracked artifacts outside the explicit public exceptions", () => {
  assert.deepEqual(forbiddenPathFindings(["adapters/.gitkeep", "client/.private-state", ".github/workflows/private.yml"]), [
    "client/.private-state: internal-only or unreviewed public path is tracked",
    ".github/workflows/private.yml: internal-only or unreviewed public path is tracked",
  ]);
});

test("rejects an obsolete public-coordinate disclaimer", () => {
  const body = "The public repository coordinates do not exist.";
  assert.equal(publicCopyFindings("README.md", body).length, 1);
});

test("rejects copy or metadata that implies a NorthCinder-operated service", () => {
  for (const body of [
    "A hosted NorthCinder operator issues your key.",
    "NorthCinder's intended business is hosting and support.",
    '"description": "NorthCinder hosted remote MCP variant"',
    '"@sentry/node": "latest"',
    "Connect to https://api.northcinder.example/mcp",
    "A host running as the same OS user can still read local files.",
    "Treat owner-local configuration as sensitive.",
  ]) {
    assert.equal(standaloneBoundaryFindings("README.md", body).length, 1, body);
  }
});

test("allows buyer-run local and explicitly self-hosted deployment copy", () => {
  assert.deepEqual(
    standaloneBoundaryFindings(
      "README.md",
      "NorthCinder is software you run. Advanced users may self-host their own NorthCinder engine.",
    ),
    [],
  );
});

test("ordinary public prose has no private-vocabulary finding", () => {
  assert.deepEqual(internalToolFindings("source.ts", "buyer-loyal deterministic shopping"), []);
});

test("ordinary public prose has no private-process finding", () => {
  assert.deepEqual(internalProcessFindings("source.ts", "release checks and product tests"), []);
});

test("rejects token and local-operator-path material without storing a token fixture in source", () => {
  const token = "gh" + "p_" + "a".repeat(36);
  const body = `${token}\n/mnt/c/Users/` + "Gamer/private.txt";
  assert.equal(sensitiveTextFindings("fixture.txt", body).length, 2);
});

test("allows empty examples and named test tokens but rejects an opaque assigned secret", () => {
  assert.deepEqual(sensitiveTextFindings(".env.example", "SERVICE_SECRET=\nPAYMENT_TOKEN=spt_test_fixture"), []);
  assert.deepEqual(sensitiveTextFindings("source.ts", "const PRIVATE_TOKEN = generateSessionToken();"), []);
  const assigned = "PRIVATE_TOKEN" + "=" + "opaqueProductionValue123456789";
  assert.deepEqual(sensitiveTextFindings("source.ts", assigned), [
    "source.ts: possible assigned secret",
  ]);
});

test("rejects private network addresses in public artifacts", () => {
  const privateAddress = [192, 168, 4, 22].join(".");
  assert.equal(sensitiveTextFindings("fixture.txt", `backend at ${privateAddress}`).length, 1);
  assert.deepEqual(sensitiveTextFindings("fixture.txt", "synthetic endpoint 192.0.2.22"), []);
});

test("release history may grow linearly from one sanitized noreply-authored root", () => {
  assert.deepEqual(commitMetadataFindings([
    {
      authorName: "NorthCinder maintainers",
      authorEmail: "jdshfhds@users.noreply.github.com",
      committerName: "NorthCinder maintainers",
      committerEmail: "jdshfhds@users.noreply.github.com",
      subject: "release: publish NorthCinder 0.1.2",
      body: "",
    },
    {
      authorName: "NorthCinder maintainers",
      authorEmail: "jdshfhds@users.noreply.github.com",
      committerName: "NorthCinder maintainers",
      committerEmail: "jdshfhds@users.noreply.github.com",
      subject: "docs: improve the public README",
      body: "",
    },
  ], { rootCount: 1, mergeCount: 0 }), []);
  assert.equal(commitMetadataFindings([
    {
      authorName: "Local Name",
      authorEmail: "person@example.com",
      committerName: "Local Name",
      committerEmail: "person@example.com",
      subject: "private release",
      body: "",
    },
  ], { rootCount: 2, mergeCount: 1 }).length, 6);
});
