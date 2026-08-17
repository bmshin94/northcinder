/**
 * Client configuration (documented in the README "BYO agent" section):
 *
 *   NORTHCINDER_SERVICE_URL          base URL of the buyer-run NorthCinder engine (required)
 *   NORTHCINDER_CLIENT_KEY           buyer-generated Bearer key for the engine (required)
 *   NORTHCINDER_CONFIG_DIR           local state dir (default $XDG_CONFIG_HOME/northcinder
 *                               or ~/.config/northcinder): mandate key, nonce ledger,
 *                               audit log, pending authorization codes
 *   NORTHCINDER_ACP_MERCHANTS        optional JSON: { "<merchant.id>": {"baseUrl": "...",
 *                               "apiKey": "..."} } — merchants reachable over the
 *                               ACP checkout rail
 *   NORTHCINDER_ACP_PAYMENT_TOKEN    optional opaque DELEGATED payment token (e.g. a
 *                               Stripe Shared Payment Token). Never a card number —
 *                               no card field exists anywhere in this codebase.
 *   NORTHCINDER_SEARCH_TIMEOUT_MS    search HTTP budget (default 20000)
 *   NORTHCINDER_CHECKOUT_TIMEOUT_MS  checkout rail budget (default 15000)
 *   NORTHCINDER_UI                   local dashboard + approval page on 127.0.0.1
 *                               (default enabled; "0"/"false" disables)
 *   NORTHCINDER_UI_PORT              fixed UI port (default 0 = ephemeral per boot)
 *   NORTHCINDER_UI_NTFY_TOPIC        optional ntfy topic for approval pushes — a
 *                               BEARER SECRET (whoever knows it receives your
 *                               tokenized approval URLs)
 *   NORTHCINDER_UI_NTFY_URL          ntfy base URL (default https://ntfy.sh)
 *   NORTHCINDER_ORDERS_MAIL_DROP_DIR local .eml drop directory for order-graph
 *                               ingest; disabled unless
 *                               NORTHCINDER_ORDERS_ALLOW_LOCAL_UNAUTHENTICATED=1
 *                               explicitly enables this local/manual bypass
 *   NORTHCINDER_ORDERS_RETURN_REMINDER_DAYS
 *                               days before a return-window deadline the
 *                               reminder fires (default 3)
 *   NORTHCINDER_ORDERS_IMAP_HOST/USER/PASSWORD/TOKEN/PORT/MAILBOX/TLS
 *                               optional read-only IMAP poll source for
 *                               order emails (see @northcinder/orders); absent →
 *                               the IMAP path is not_configured, never faked
 */
import { z } from "zod";
import { join } from "node:path";
import { canonicalizeProductEnv, resolveConfigDir } from "@northcinder/protocol";
import type { AcpMerchantEndpoint } from "@northcinder/checkout";
import { BRAND_NAME } from "./brand.js";

const AcpMerchantsSchema = z.record(
  z.string().min(1),
  z.object({ baseUrl: z.url(), apiKey: z.string().min(1) }),
);

function isRawPanLike(value: string): boolean {
  return /(?:^|\D)(?:\d[ -]?){12,18}\d(?!\d)/.test(value);
}

export interface ClientUiConfig {
  /** Serve the local dashboard + approval page (127.0.0.1, session-token gated). */
  enabled: boolean;
  /** 0 = ephemeral per boot; a fixed port gives stable bookmarkable URLs. */
  port: number;
  /** Approval-push channel (optional). The topic is a bearer secret. */
  ntfy?: { topic: string; baseUrl?: string };
}

export interface ClientConfig {
  serviceUrl: string;
  clientKey: string;
  configDir: string;
  acpMerchants: Record<string, AcpMerchantEndpoint>;
  acpPaymentToken?: string;
  searchTimeoutMs: number;
  checkoutTimeoutMs: number;
  ui: ClientUiConfig;
  /** Present only for the explicit local/manual unauthenticated bypass. */
  ordersMailDropDir?: string;
  ordersReturnReminderDays: number;
}

/** Canonical values win; legacy product keys are accepted only for this window. */
export function canonicalizeClientEnv(env: Record<string, string | undefined>, warn: (message: string) => void = console.warn): Record<string, string | undefined> {
  return canonicalizeProductEnv(env, warn);
}

export function loadClientConfig(env: Record<string, string | undefined> = process.env): ClientConfig {
  env = canonicalizeClientEnv(env);
  const rawPaymentKey = Object.entries(env).find(
    ([name, value]) =>
      value !== undefined &&
      value !== "" &&
      /^NORTHCINDER_(?:CARD(?:_?NUMBER)?|PAN|CVV|CVC|SECURITY_?CODE)$/i.test(name),
  )?.[0];
  if (rawPaymentKey !== undefined) {
    throw new Error(`${rawPaymentKey} is raw card configuration and is forbidden; configure only an opaque delegated payment token`);
  }
  const serviceUrl = env.NORTHCINDER_SERVICE_URL;
  if (!serviceUrl || !z.url().safeParse(serviceUrl).success) {
    throw new Error(`NORTHCINDER_SERVICE_URL is required and must be a URL (the buyer-run ${BRAND_NAME} engine endpoint)`);
  }
  const clientKey = env.NORTHCINDER_CLIENT_KEY;
  if (!clientKey || clientKey.length < 16) {
    throw new Error("NORTHCINDER_CLIENT_KEY is required (a buyer-generated per-client engine key, ≥16 chars)");
  }

  let acpMerchants: Record<string, AcpMerchantEndpoint> = {};
  if (env.NORTHCINDER_ACP_MERCHANTS) {
    let raw: unknown;
    try {
      raw = JSON.parse(env.NORTHCINDER_ACP_MERCHANTS);
    } catch {
      throw new Error("NORTHCINDER_ACP_MERCHANTS must be valid JSON ({merchantId: {baseUrl, apiKey}})");
    }
    const parsed = AcpMerchantsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`NORTHCINDER_ACP_MERCHANTS is malformed: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
    acpMerchants = parsed.data;
  }

  const acpPaymentToken = env.NORTHCINDER_ACP_PAYMENT_TOKEN;
  if (
    acpPaymentToken !== undefined &&
    acpPaymentToken !== "" &&
    isRawPanLike(acpPaymentToken)
  ) {
    throw new Error("NORTHCINDER_ACP_PAYMENT_TOKEN must be an opaque delegated token, never raw card data");
  }

  const num = (name: string, fallback: number): number => {
    const v = env[name];
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer (ms)`);
    return n;
  };

  // Local UI (local UI): enabled unless explicitly turned off. Port 0 = ephemeral.
  const uiFlag = (env.NORTHCINDER_UI ?? "1").trim().toLowerCase();
  const uiEnabled = !["0", "false", "off", "no"].includes(uiFlag);
  const uiPortRaw = env.NORTHCINDER_UI_PORT;
  let uiPort = 0;
  if (uiPortRaw !== undefined && uiPortRaw !== "") {
    const n = Number(uiPortRaw);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      throw new Error("NORTHCINDER_UI_PORT must be an integer port (0 = ephemeral)");
    }
    uiPort = n;
  }
  const ntfyTopic = env.NORTHCINDER_UI_NTFY_TOPIC;
  const ui: ClientUiConfig = {
    enabled: uiEnabled,
    port: uiPort,
    ...(ntfyTopic !== undefined && ntfyTopic !== ""
      ? { ntfy: { topic: ntfyTopic, ...(env.NORTHCINDER_UI_NTFY_URL ? { baseUrl: env.NORTHCINDER_UI_NTFY_URL } : {}) } }
      : {}),
  };

  const configDir = resolveConfigDir(env);
  const localBypass = (env.NORTHCINDER_ORDERS_ALLOW_LOCAL_UNAUTHENTICATED ?? "").trim() === "1";
  const dropDirFlag = (env.NORTHCINDER_ORDERS_MAIL_DROP_DIR ?? "").trim().toLowerCase();
  const ordersMailDropDir = localBypass && !["0", "false", "off", "no"].includes(dropDirFlag)
    ? (env.NORTHCINDER_ORDERS_MAIL_DROP_DIR ?? join(configDir, "mail-drop"))
    : undefined;

  return {
    serviceUrl: serviceUrl.replace(/\/$/, ""),
    clientKey,
    configDir,
    acpMerchants,
    ...(acpPaymentToken ? { acpPaymentToken } : {}),
    searchTimeoutMs: num("NORTHCINDER_SEARCH_TIMEOUT_MS", 20_000),
    checkoutTimeoutMs: num("NORTHCINDER_CHECKOUT_TIMEOUT_MS", 15_000),
    ui,
    ...(ordersMailDropDir !== undefined ? { ordersMailDropDir } : {}),
    ordersReturnReminderDays: num("NORTHCINDER_ORDERS_RETURN_REMINDER_DAYS", 3),
  };
}
