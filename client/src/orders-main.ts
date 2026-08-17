#!/usr/bin/env node
/**
 * northcinder-orders — the order-graph scheduler. Mirrors the
 * `northcinder-watch` bin exactly (same two modes, same exit-code law, same
 * cron/launchd pattern — see @northcinder/orders/README.md for the snippets).
 *
 *   northcinder-orders --once                 one tick, then exit (cron-able)
 *   northcinder-orders [--interval <secs>]    long-running loop (default 900s /
 *                                        NORTHCINDER_ORDERS_INTERVAL_S)
 *
 * Before this bin existed, `runReturnWindowReminders`/`pollImap` were
 * implemented + tested in @northcinder/orders but NEVER CALLED on an interval by
 * the running app — dead code. Every tick: (1) ingest the local .eml drop
 * dir, (2) poll IMAP if configured (structured `not_configured` skip if
 * not — never a fake success), (3) run return-window reminders.
 *
 * Env: the same NORTHCINDER_CONFIG_DIR / NORTHCINDER_ORDERS_MAIL_DROP_DIR /
 * NORTHCINDER_ORDERS_RETURN_REMINDER_DAYS / NORTHCINDER_ORDERS_IMAP_* as northcinder-mcp,
 * plus NORTHCINDER_NTFY_TOPIC / NORTHCINDER_NTFY_BASE_URL (the SAME ntfy settings
 * northcinder-watch uses — one push channel for the whole app) and
 * NORTHCINDER_ORDERS_INTERVAL_S.
 */
import {
  createOrderGraphStore,
  createNtfyReturnReminderTransport,
  createStderrReturnReminderTransport,
  type ReturnReminderTransport,
} from "@northcinder/orders";
import { createAuditLog } from "./audit-log.js";
import { BRAND_NAME, BRAND_SLUG } from "./brand.js";
import { loadOrdersConfig } from "./orders-config.js";
import { createOrderStore } from "./order-store.js";
import { canonicalizeProductEnv } from "@northcinder/protocol";
import { ordersTickExitCode, runOrdersLoop, runOrdersTick, type OrdersTickSummary } from "./orders-runner.js";

interface CliArgs {
  once: boolean;
  intervalMs: number;
}

function parseCliArgs(argv: string[], env: Record<string, string | undefined>): CliArgs {
  let once = false;
  let intervalS = Number(env.NORTHCINDER_ORDERS_INTERVAL_S ?? "900");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") once = true;
    else if (arg === "--interval") {
      intervalS = Number(argv[i + 1]);
      i += 1;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)} (usage: ${BRAND_SLUG}-orders [--once] [--interval <seconds>])`);
    }
  }
  if (!Number.isFinite(intervalS) || intervalS <= 0) throw new Error("--interval / NORTHCINDER_ORDERS_INTERVAL_S must be a positive number of seconds");
  return { once, intervalMs: Math.round(intervalS * 1000) };
}

function reportSummary(summary: OrdersTickSummary): void {
  process.stderr.write(
    `[${BRAND_SLUG}-orders] ${summary.checkedAt}: drop-dir scanned ${summary.dropDir.scanned}, imap ${summary.imap.ok ? `ingested ${summary.imap.ingested}` : summary.imap.error.code}, reminders checked ${summary.reminders.length}\n`,
  );
  for (const r of summary.reminders) {
    process.stderr.write(`[${BRAND_SLUG}-orders]   return-window reminder: ${r.outcome}\n`);
  }
}

async function main(): Promise<void> {
  const env = canonicalizeProductEnv(process.env);
  const args = parseCliArgs(process.argv.slice(2), env);
  // A narrower loader than northcinder-mcp's full loadClientConfig():
  // this bin only ingests order emails and sends reminders — it never calls
  // the service — so NORTHCINDER_SERVICE_URL/NORTHCINDER_CLIENT_KEY are not required.
  // Same NORTHCINDER_CONFIG_DIR resolution rule, so it shares the same order
  // graph file, drop dir, and reminder settings as northcinder-mcp.
  const config = loadOrdersConfig(env);
  const store = createOrderGraphStore(config.configDir);
  const checkoutOrders = createOrderStore(config.configDir);
  const audit = createAuditLog(config.configDir);

  const ntfyTopic = env.NORTHCINDER_NTFY_TOPIC;
  const reminderTransport: ReturnReminderTransport = ntfyTopic
    ? createNtfyReturnReminderTransport({ topic: ntfyTopic, ...(env.NORTHCINDER_NTFY_BASE_URL ? { baseUrl: env.NORTHCINDER_NTFY_BASE_URL } : {}) })
    : createStderrReturnReminderTransport();

  const deps = {
    store,
    imapEnv: env,
    ...(config.ordersMailDropDir !== undefined ? { dropDir: config.ordersMailDropDir } : {}),
    orderFor: (orderId: string) => store.getOrder(orderId, checkoutOrders.list())?.order,
    reminderTransport,
    reminderDays: config.ordersReturnReminderDays,
  };

  const audited = (summary: OrdersTickSummary): void => {
    audit.append({
      type: "orders_tick",
      dropDirScanned: summary.dropDir.scanned,
      imapOutcome: summary.imap.ok ? "ok" : summary.imap.error.code,
      ...(summary.imap.ok ? { imapIngested: summary.imap.ingested } : {}),
      reminders: summary.reminders.map((r) => ({ orderId: r.orderId, outcome: r.outcome })),
    });
    reportSummary(summary);
  };

  process.stderr.write(
    `[${BRAND_SLUG}-orders] buyer-local order state configured | drop-dir ingest: ${config.ordersMailDropDir ? "enabled (local unauthenticated bypass)" : "disabled"} | reminders: ${ntfyTopic ? "ntfy" : "stderr"} | mode: ${args.once ? "once" : `loop every ${args.intervalMs / 1000}s`}\n`,
  );
  if (args.once) {
    const summary = await runOrdersTick(deps);
    audited(summary);
    // A fully-failed tick must be VISIBLE to cron/launchd (see README).
    process.exitCode = ordersTickExitCode(summary);
    return;
  }
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  await runOrdersLoop(deps, { intervalMs: args.intervalMs, signal: controller.signal, onTick: audited });
  process.stderr.write(`[${BRAND_SLUG}-orders] stopped\n`);
}

main().catch(() => {
  process.stderr.write(`[${BRAND_NAME}-orders] fatal: startup failed; check buyer-local configuration\n`);
  process.exit(1);
});
