import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..");
mkdirSync(resolve(packageDir, "bin"), { recursive: true });
const outfile = resolve(packageDir, "bin/northcinder.js");
// Use the workspace's already-installed esbuild binary.  It keeps the packed
// launcher dependency-free; only maintainers building the tarball need it.
const result = spawnSync(resolve(packageDir, "../node_modules/.pnpm/node_modules/.bin/esbuild"), [
  resolve(packageDir, "src/launcher.ts"), "--bundle", "--platform=node", "--format=esm", "--target=node20",
  `--outfile=${outfile}`, "--banner:js=#!/usr/bin/env node",
  "--external:playwright-core", "--external:chromium-bidi/*",
], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
// Some bundled dependency template literals contain whitespace-only source
// lines. Keep the checked-in launcher reproducible and `git diff --check`
// clean without changing the generated JavaScript's behavior.
writeFileSync(outfile, readFileSync(outfile, "utf8").replace(/[ \t]+$/gm, ""));
