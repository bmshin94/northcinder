#!/usr/bin/env node
/**
 * Builds northcinder.mcpb as a self-contained MCPB bundle:
 * mcpb/manifest.json at the archive root + a SINGLE esbuild-bundled,
 * dependency-free server entry point. Previously this packaged
 * compiled `dist/` as-is, which still `require`s workspace packages
 * (`@northcinder/*`) and third-party deps out of `node_modules` at runtime, so
 * the archive was not actually installable without a vendored `node_modules`). Requires
 * `pnpm --filter @northcinder/client build` to have run first (dist/main.js must
 * exist) — this script bundles THAT compiled output, it does not compile
 * TypeScript itself.
 *
 * The plain (unbundled) `dist/` build is untouched and still used for the
 * npm/npx path (`northcinder`/`northcinder-mcp`/... bins) — only the .mcpb packaging
 * uses the bundle.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { createZip } from "./zip-lite.mjs";

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export function collectDistFiles(distDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(distDir);
  return files;
}

/**
 * esbuild-bundles `dist/main.js` (the northcinder-mcp stdio server entry) into a
 * single self-contained `dist/main.bundle.js` — every workspace package
 * (`@northcinder/*`) and third-party dependency (the MCP SDK, zod, hono, ...)
 * inlined; only Node.js built-ins stay external (esbuild's default for
 * `platform: "node"`). Returns the output path.
 */
export function bundleMainEntry(clientDir = CLIENT_DIR) {
  const entry = join(clientDir, "dist", "main.js");
  if (!statSync(entry, { throwIfNoEntry: false })) {
    throw new Error(`${entry} not found — run \`pnpm --filter @northcinder/client build\` first`);
  }
  const outfile = join(clientDir, "dist", "main.bundle.js");
  buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    legalComments: "none",
    logLevel: "silent",
  });
  return outfile;
}

export function buildMcpbEntries(clientDir = CLIENT_DIR) {
  const manifestPath = join(clientDir, "mcpb", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const distDir = join(clientDir, "dist");
  if (!statSync(distDir, { throwIfNoEntry: false })) {
    throw new Error(`dist/ not found at ${distDir} — run \`pnpm --filter @northcinder/client build\` first`);
  }
  const bundlePath = bundleMainEntry(clientDir);
  const entries = [
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") },
    { name: `server/${relative(distDir, bundlePath).split("\\").join("/")}`, data: readFileSync(bundlePath) },
  ];
  return { manifest, entries };
}

export function buildMcpb(clientDir = CLIENT_DIR, outPath = join(clientDir, "northcinder.mcpb")) {
  const { entries } = buildMcpbEntries(clientDir);
  const zipBuf = createZip(entries);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, zipBuf);
  return outPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outPath = buildMcpb();
  process.stdout.write(`Wrote ${outPath}\n`);
}
