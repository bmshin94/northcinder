import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const json = (path) => JSON.parse(read(path));

test("NorthCinder is the canonical public and workspace identity", () => {
  const root = json("package.json");
  const launcher = json("northcinder/package.json");
  const client = json("client/package.json");
  const manifest = json("client/mcpb/manifest.json");

  assert.equal(root.name, "northcinder-monorepo");
  assert.equal(launcher.name, "northcinder");
  assert.deepEqual(launcher.bin, { northcinder: "bin/northcinder.js" });
  assert.equal(launcher.repository.url, "git+https://github.com/jdshfhds/northcinder.git");
  assert.equal(client.name, "@northcinder/client");
  assert.equal(manifest.name, "northcinder");
  assert.equal(manifest.display_name, "NorthCinder");
  assert.match(read("client/src/brand.ts"), /BRAND_NAME\s*=\s*"NorthCinder"/);
  assert.match(read("client/src/brand.ts"), /BRAND_SLUG\s*=\s*"northcinder"/);
});

test("NorthCinder owns new state while Brier remains a compatibility boundary", () => {
  const config = read("packages/protocol/src/config-dir.ts");
  const mandate = read("packages/checkout/src/mandate/canonical.ts");

  assert.match(config, /NORTHCINDER_/);
  assert.match(config, /BRIER_/);
  assert.match(config, /join\(canonicalBase, "northcinder"\)/);
  assert.match(config, /join\(canonicalBase, "brier"\)/);
  assert.match(mandate, /"northcinder\.purchase-mandate\.v1"/);
  assert.match(mandate, /"brier\.purchase-mandate\.v1"/);
});

test("public release provenance contains no former identity or rename narrative", () => {
  assert.doesNotMatch(read("CHANGELOG.md"), /\bbrier(?:-agent)?\b|\brenam(?:e|ed|ing)\b/i);
  const history = execFileSync("git", ["log", "--format=%an%n%cn%n%s%n%b", "HEAD"], {
    cwd: new URL("../../../", import.meta.url),
    encoding: "utf8",
  });
  assert.doesNotMatch(history, /\bbrier(?:-agent)?\b|\brenam(?:e|ed|ing)\b/i);
});
