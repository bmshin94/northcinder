#!/usr/bin/env node
/**
 * northcinder-watch — the price-watch scheduler (watch). Two modes, no daemon
 * manager required (cron/launchd snippets in packages/watches/README.md):
 *
 *   northcinder-watch --once                 one tick over all active watches, then exit (cron-able)
 *   northcinder-watch [--interval <secs>]    long-running interval loop (default 900s / NORTHCINDER_WATCH_INTERVAL_S)
 *   northcinder-watch --once --source reference   fixture mode: checks against the in-memory
 *                                             reference adapter instead of the live service
 *                                             (demo/verification; no network, no credentials)
 *
 * LAW: this scheduler NOTIFIES — this runnable loads no checkout code (its
 * whole runtime import graph is checkout-free, enforced by the architectural
 * test in packages/watches/test/no-checkout-path.test.ts) and cannot buy.
 * Every check outcome is appended to the local audit log (channel details,
 * e.g. ntfy topics, are never written there).
 *
 * Exit code: `--once` exits 1 when EVERY check failed (source_error /
 * notify_failed), so cron/launchd see a fully-failed tick; partial failure
 * is a normal, reported state and exits 0.
 *
 * Env: NORTHCINDER_SERVICE_URL / NORTHCINDER_CLIENT_KEY (live mode), NORTHCINDER_CONFIG_DIR,
 * NORTHCINDER_NTFY_TOPIC (default topic — treat it as a bearer secret),
 * NORTHCINDER_NTFY_BASE_URL (default https://ntfy.sh), NORTHCINDER_WATCH_INTERVAL_S.
 */
import { canonicalizeProductEnv, createReferenceAdapter, resolveConfigDir } from "@northcinder/protocol";
import { BRAND_NAME, BRAND_SLUG } from "./brand.js";
import { createWatchStore, runWatchesLoop, runWatchesOnce, type WatchRunSummary } from "@northcinder/watches";
import { createAuditLog } from "./audit-log.js";
import { loadClientConfig } from "./config.js";
import { createServiceClient } from "./service-client.js";
import { createAdapterOfferSource, createChannelNotifierFor, createServiceOfferSource, watchRunExitCode } from "./watch-runner.js";

interface CliArgs {
  once: boolean;
  intervalMs: number;
  source: "service" | "reference";
}

function parseCliArgs(argv: string[], env: Record<string, string | undefined>): CliArgs {
  let once = false;
  let source: CliArgs["source"] = "service";
  let intervalS = Number(env.NORTHCINDER_WATCH_INTERVAL_S ?? "900");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") once = true;
    else if (arg === "--interval") {
      intervalS = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--source") {
      const value = argv[i + 1];
      if (value !== "reference" && value !== "service") throw new Error(`--source must be "service" or "reference", got ${JSON.stringify(value)}`);
      source = value;
      i += 1;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)} (usage: ${BRAND_SLUG}-watch [--once] [--interval <seconds>] [--source service|reference])`);
    }
  }
  if (!Number.isFinite(intervalS) || intervalS <= 0) throw new Error("--interval / NORTHCINDER_WATCH_INTERVAL_S must be a positive number of seconds");
  return { once, intervalMs: Math.round(intervalS * 1000), source };
}

function reportSummary(summary: WatchRunSummary): void {
  process.stderr.write(`[${BRAND_SLUG}-watch] ${summary.checkedAt}: checked ${summary.total} active watch(es)\n`);
  for (const r of summary.reports) {
    const price = r.currentPrice ? ` @ ${(r.currentPrice.amount / 100).toFixed(2)} ${r.currentPrice.currency}` : "";
    const error = r.error ? ` (${r.error.code})` : "";
    process.stderr.write(`[${BRAND_SLUG}-watch]   ${r.watchId}: ${r.outcome}${price}${error}\n`);
  }
}

async function main(): Promise<void> {
  const env = canonicalizeProductEnv(process.env);
  const args = parseCliArgs(process.argv.slice(2), env);

  // Fixture mode needs no service credentials; live mode uses the standard
  // client config (same budgeted service path as search_products).
  const configDir = args.source === "reference" ? resolveConfigDir(env) : loadClientConfig(env).configDir;
  const source =
    args.source === "reference"
      ? createAdapterOfferSource(createReferenceAdapter())
      : createServiceOfferSource(
          (() => {
            const config = loadClientConfig(env);
            return createServiceClient({
              serviceUrl: config.serviceUrl,
              ...(config.clientKey !== undefined ? { clientKey: config.clientKey } : {}),
              timeoutMs: config.searchTimeoutMs,
            });
          })(),
        );

  const store = createWatchStore({ configDir });
  const audit = createAuditLog(configDir);
  const notifierFor = createChannelNotifierFor({
    configDir,
    ...(env.NORTHCINDER_NTFY_TOPIC ? { ntfyTopic: env.NORTHCINDER_NTFY_TOPIC } : {}),
    ...(env.NORTHCINDER_NTFY_BASE_URL ? { ntfyBaseUrl: env.NORTHCINDER_NTFY_BASE_URL } : {}),
  });
  const deps = { store, source, notifierFor };

  const audited = (summary: WatchRunSummary): void => {
    for (const r of summary.reports) {
      // Audit line carries the check outcome only — never channel details.
      audit.append({
        type: "watch_check",
        watchId: r.watchId,
        outcome: r.outcome,
        ...(r.currentPrice !== undefined ? { currentPrice: r.currentPrice } : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
      });
    }
    reportSummary(summary);
  };

  process.stderr.write(`[${BRAND_SLUG}-watch] buyer-local watch state configured | source: ${args.source} | mode: ${args.once ? "once" : `loop every ${args.intervalMs / 1000}s`}\n`);
  if (args.once) {
    const summary = await runWatchesOnce(deps);
    audited(summary);
    // A fully-failed tick must be VISIBLE to cron/launchd (see README).
    process.exitCode = watchRunExitCode(summary);
    return;
  }
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  await runWatchesLoop(deps, { intervalMs: args.intervalMs, signal: controller.signal, onTick: audited });
  process.stderr.write(`[${BRAND_SLUG}-watch] stopped\n`);
}

main().catch(() => {
  process.stderr.write(`[${BRAND_SLUG}-watch] fatal: startup failed; check buyer-local configuration\n`);
  process.exit(1);
});
