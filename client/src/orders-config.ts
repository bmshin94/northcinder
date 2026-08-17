/**
 * A narrower config loader for the `northcinder-orders` bin: `orders-main.ts` used
 * to call `loadClientConfig()`, which hard-
 * requires NORTHCINDER_SERVICE_URL + NORTHCINDER_CLIENT_KEY even though this bin only
 * ingests order emails (drop dir / IMAP) and sends return-window reminders
 * — it never calls the service. This loader reads only what that work
 * actually needs:
 *
 *   NORTHCINDER_CONFIG_DIR                   local state dir (same resolution
 *                                        rule as the full client config)
 *   NORTHCINDER_ORDERS_MAIL_DROP_DIR         local .eml drop directory (default
 *                                        <configDir>/mail-drop); "0"/"false"
 *                                        disables drop-dir ingest entirely
 *   NORTHCINDER_ORDERS_RETURN_REMINDER_DAYS  days before a return-window deadline
 *                                        the reminder fires (default 3)
 *
 * IMAP (NORTHCINDER_ORDERS_IMAP_*) and ntfy (NORTHCINDER_NTFY_*) settings are read
 * directly from `process.env` by `@northcinder/orders`' `pollImap`/
 * `createNtfyReturnReminderTransport` — they were never routed through
 * `loadClientConfig` either, so this loader doesn't need to touch them.
 */
import { join } from "node:path";
import { resolveConfigDir } from "@northcinder/protocol";

export interface OrdersConfig {
  configDir: string;
  /** Absent when NORTHCINDER_ORDERS_MAIL_DROP_DIR is explicitly disabled ("0"/"false"). */
  ordersMailDropDir?: string;
  ordersReturnReminderDays: number;
}

export function loadOrdersConfig(env: Record<string, string | undefined> = process.env): OrdersConfig {
  const configDir = resolveConfigDir(env);

  const localBypass = (env.NORTHCINDER_ORDERS_ALLOW_LOCAL_UNAUTHENTICATED ?? "").trim() === "1";
  const dropDirFlag = (env.NORTHCINDER_ORDERS_MAIL_DROP_DIR ?? "").trim().toLowerCase();
  const ordersMailDropDir = localBypass && !["0", "false", "off", "no"].includes(dropDirFlag)
    ? (env.NORTHCINDER_ORDERS_MAIL_DROP_DIR ?? join(configDir, "mail-drop"))
    : undefined;

  const reminderDaysRaw = env.NORTHCINDER_ORDERS_RETURN_REMINDER_DAYS;
  let ordersReturnReminderDays = 3;
  if (reminderDaysRaw !== undefined && reminderDaysRaw !== "") {
    const n = Number(reminderDaysRaw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error("NORTHCINDER_ORDERS_RETURN_REMINDER_DAYS must be a positive integer (days)");
    }
    ordersReturnReminderDays = n;
  }

  return {
    configDir,
    ...(ordersMailDropDir !== undefined ? { ordersMailDropDir } : {}),
    ordersReturnReminderDays,
  };
}
