#!/usr/bin/env node
/**
 * Run both dependency-audit scopes even when advisories make either pnpm
 * command exit nonzero. Output is one machine-readable combined report and
 * exit nonzero when the default high/critical release policy is exceeded.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);

export function summarizeAudit(report, scope) {
  const counts = report?.metadata?.vulnerabilities;
  if (!counts || !["info", "low", "moderate", "high", "critical"].every((key) => Number.isInteger(counts[key]))) {
    return { scope, counts: null, passesPolicy: false, parseError: "audit did not emit a vulnerability summary" };
  }
  return {
    scope,
    counts: { info: counts.info, low: counts.low, moderate: counts.moderate, high: counts.high, critical: counts.critical, total: counts.info + counts.low + counts.moderate + counts.high + counts.critical },
    passesPolicy: counts.high === 0 && counts.critical === 0,
  };
}

function run(scope, args) {
  const child = spawnSync("corepack", ["pnpm", "audit", "--json", ...args], { cwd: root, encoding: "utf8" });
  let parsed;
  try { parsed = JSON.parse(child.stdout); } catch { parsed = undefined; }
  return { ...summarizeAudit(parsed, scope), commandExit: child.status ?? 1 };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const audits = [run("full", []), run("prod", ["--prod"])];
  process.stdout.write(`${JSON.stringify({ policy: "fail_on_high_or_critical", audits }, null, 2)}\n`);
  if (audits.some((audit) => !audit.passesPolicy || audit.parseError !== undefined)) process.exitCode = 1;
}
