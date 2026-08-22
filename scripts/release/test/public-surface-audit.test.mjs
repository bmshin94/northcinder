import assert from "node:assert/strict";
import test from "node:test";
import {
  commitMetadataFindings,
  forbiddenPathFindings,
  internalProcessFindings,
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

test("allows the reviewed research-eval grader while rejecting another unknown client script", () => {
  assert.deepEqual(forbiddenPathFindings(["client/scripts/grade-research-skill-evals.mjs"]), []);
  assert.deepEqual(forbiddenPathFindings(["client/scripts/unreviewed-eval-helper.mjs"]), [
    "client/scripts/unreviewed-eval-helper.mjs: internal-only or unreviewed public path is tracked",
  ]);
});

test("rejects hidden tracked artifacts outside the explicit public exceptions", () => {
  assert.deepEqual(forbiddenPathFindings(["adapters/.gitkeep", "client/.private-state", ".github/workflows/private.yml"]), [
    "client/.private-state: internal-only or unreviewed public path is tracked",
    ".github/workflows/private.yml: internal-only or unreviewed public path is tracked",
  ]);
});

test("allows only the reviewed GitHub files", () => {
  const reviewed = [
    ".github/FUNDING.yml",
    ".github/ISSUE_TEMPLATE/bug-report.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/ISSUE_TEMPLATE/feature-proposal.yml",
    ".github/pull_request_template.md",
  ];
  assert.deepEqual(forbiddenPathFindings(reviewed), []);
  assert.deepEqual(forbiddenPathFindings([...reviewed, ".github/workflows/unreviewed.yml"]), [
    ".github/workflows/unreviewed.yml: internal-only or unreviewed public path is tracked",
  ]);
});

test("rejects an obsolete public-coordinate disclaimer", () => {
  const body = "The public repository coordinates do not exist.";
  assert.equal(publicCopyFindings("README.md", body).length, 1);
});

test("uses path-specific semantic checks for the public install and checkout contracts", () => {
  assert.deepEqual(publicCopyFindings("site/src/pages/install.astro", "The initializer creates the local client key."), [
    "site/src/pages/install.astro: obsolete local-install credential copy",
  ]);
  assert.deepEqual(publicCopyFindings("site/src/pages/install.astro", "The buyer runs a self-hosted engine with a buyer-generated key."), []);
  assert.deepEqual(publicCopyFindings("site/src/pages/checkout-safety.astro", "The exact number of units is authorized."), [
    "site/src/pages/checkout-safety.astro: unsupported variable-quantity copy",
  ]);
  assert.deepEqual(publicCopyFindings("README.md", "A self-hosted engine uses a buyer-generated key."), []);
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

test("rejects generic internal process prose while allowing test-only labels", () => {
  for (const body of [
    "Slice 4 adds evidence.",
    "Batch 6 verification",
    "The weak-agent tier passed an internal sample.",
    "This review wave closes the finding.",
    "The invariant #4 architectural test enforces the determinism law.",
  ]) {
    assert.equal(internalProcessFindings("README.md", body).length, 1, body);
  }
  assert.deepEqual(internalProcessFindings("packages/checkout/test/example.ts", "Slice 4 internal sample"), []);
  assert.deepEqual(internalProcessFindings("README.md", "release checks and product tests"), []);
});

test("rejects release-handoff prose in package copy and slice labels in shipped source", () => {
  assert.equal(
    internalProcessFindings("northcinder/README.md", "In this handoff NorthCinder does not operate your browser.").length,
    1,
  );
  assert.equal(
    internalProcessFindings("packages/brief/src/compose.ts", "/** Optional Slice 4 evidence. */").length,
    1,
  );
});

test("rejects token and generic local-operator-path material without a path dictionary", () => {
  const token = "gh" + "p_" + "a".repeat(36);
  const localRoot = "/home/private-operator";
  const body = `${token}\n${localRoot}/private.txt`;
  assert.equal(sensitiveTextFindings("fixture.txt", body).length, 2);
});

test("allows only exact synthetic operator roots in their dedicated negative tests", () => {
  assert.deepEqual(sensitiveTextFindings("client/test/local-ui.test.ts", "/home/alice/.config/northcinder/private.json"), []);
  assert.deepEqual(sensitiveTextFindings("packages/checkout/test/keystore.test.ts", "/home/u/.config/northcinder"), []);
  assert.deepEqual(sensitiveTextFindings("scripts/release/test/public-surface-audit.test.mjs", "/mnt/c/Users/synthetic-operator/private.txt"), []);
  assert.equal(sensitiveTextFindings("README.md", "/home/alice/.config/northcinder/private.json").length, 1);
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
      authorEmail: "150383880+cinderline@users.noreply.github.com",
      committerName: "NorthCinder maintainers",
      committerEmail: "150383880+cinderline@users.noreply.github.com",
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
