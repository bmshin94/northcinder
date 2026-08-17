#!/usr/bin/env node
/** Fail closed: Astro's missing-checker prompt can exit 0 in closed stdin. */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const result = spawnSync("corepack", ["pnpm", "--filter", "@northcinder/site", "exec", "astro", "check"], {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);
if (result.status !== 0) process.exit(result.status ?? 1);
if (!/Result \(\d+ files\):/.test(output)) {
  process.stderr.write("Astro check did not emit its diagnostic completion marker; refusing false green.\n");
  process.exit(1);
}
