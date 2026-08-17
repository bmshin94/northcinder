import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");

test("root builds finish dependency workspaces before generating the dependency-free launcher", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(
    pkg.scripts.build,
    "pnpm --filter '!northcinder' --filter '!northcinder-monorepo' -r build && pnpm --filter northcinder build",
  );
  assert.equal(
    pkg.scripts["release:build"],
    "corepack pnpm --filter '!northcinder' --filter '!northcinder-monorepo' -r build && corepack pnpm --filter northcinder build",
  );
});

test("release typecheck is an explicit root gate and loads DOM fetch declarations", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const base = JSON.parse(readFileSync(resolve(root, "tsconfig.base.json"), "utf8"));

  assert.equal(typeof pkg.scripts["release:typecheck"], "string");
  assert.match(pkg.scripts["release:typecheck"], /skipLibCheck false/);
  assert.match(pkg.scripts["release:typecheck"], /@northcinder\/remote/);
  assert.match(pkg.scripts["release:typecheck"], /astro-check\.mjs/);
  assert.deepEqual(base.compilerOptions.lib, ["ES2022", "DOM", "DOM.Iterable"]);
  const remote = JSON.parse(readFileSync(resolve(root, "remote/tsconfig.json"), "utf8"));
  assert.notEqual(remote.compilerOptions.exactOptionalPropertyTypes, false, "remote keeps the workspace exactOptionalPropertyTypes contract");
  const workspace = readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /@modelcontextprotocol\/sdk@1\.30\.0/);
  const site = JSON.parse(readFileSync(resolve(root, "site/package.json"), "utf8"));
  assert.match(site.devDependencies["@astrojs/check"], /^\^0\.9\.10$/);
  const astroGate = readFileSync(resolve(root, "scripts/release/astro-check.mjs"), "utf8");
  assert.match(astroGate, /Result \\\(\\d\+ files\\\):/);
});
