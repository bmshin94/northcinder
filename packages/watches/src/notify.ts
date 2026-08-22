/**
 * Notifier abstraction (watch; reused by local UI approval pushes and order graph return-window
 * reminders — the interface is deliberately minimal: id + send).
 *
 * LAW: notifications INFORM. The composed content deep-links the user to the
 * product page so THEY can start a normal, human-approved purchase
 * authorization — there is no purchase action of any kind in here.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isIP } from "node:net";
import { fetchWithBudget } from "@northcinder/adapter-kit";
import type { Money } from "@northcinder/protocol";
import { BRAND_NAME } from "./brand.js";

/** Everything a notification carries — composed by CODE, never a model. */
export interface WatchNotification {
  watchId: string;
  watchName: string;
  currentPrice: Money;
  targetPrice: Money;
  merchantName: string;
  merchantId: string;
  productTitle: string;
  /** Deep link to the product page — the user starts a NORMAL authorization there. */
  url: string;
  /** watchId + priceBucket — the at-least-once dedupe key. */
  dedupeKey: string;
  at: string;
}

export type NotifyResult = { ok: true } | { ok: false; error: { code: string; message: string } };

export interface Notifier {
  readonly id: string;
  send(notification: WatchNotification): Promise<NotifyResult>;
}

function formatMoney(m: Money): string {
  return `${(m.amount / 100).toFixed(2)} ${m.currency}`;
}

/** Deterministic, code-composed notification text (shared by every notifier). */
export function formatNotification(n: WatchNotification): { title: string; body: string } {
  const title = `${BRAND_NAME} price watch: "${n.watchName}" hit its target`;
  const body = [
    `${n.productTitle} is now ${formatMoney(n.currentPrice)} (target: ${formatMoney(n.targetPrice)}) at ${n.merchantName}.`,
    `Open it here to buy it YOURSELF: ${n.url}`,
    `${BRAND_NAME} never buys for you from a watch — purchases always require your explicit, per-purchase approval.`,
  ].join("\n");
  return { title, body };
}

export interface NtfyNotifierOptions {
  /** The ntfy topic — a BEARER SECRET; never logged, never echoed in errors. */
  topic: string;
  /** Defaults to the public https://ntfy.sh instance. */
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** One arbitrary ntfy message (local UI approval pushes reuse this directly). */
export interface NtfyMessage {
  title: string;
  body: string;
  /** The notification's click-through URL (ntfy `click` action). */
  clickUrl?: string;
  /** ntfy tags header (emoji shortcodes), e.g. "moneybag". */
  tags?: string;
  priority?: "min" | "low" | "default" | "high" | "urgent";
}

/**
 * Low-level ntfy publish (https://docs.ntfy.sh): plain POST of the message to
 * the topic. Shared by the watch notifier and the local UI approval push — one
 * publish path, one leak discipline (error text names the FAILURE, never the
 * topic).
 */
export async function publishNtfy(options: NtfyNotifierOptions, message: NtfyMessage): Promise<NotifyResult> {
  const base = (options.baseUrl ?? "https://ntfy.sh").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const result = await fetchWithBudget(
    `${base}/${encodeURIComponent(options.topic)}`,
    {
      method: "POST",
      headers: {
        title: message.title,
        ...(message.clickUrl !== undefined ? { click: message.clickUrl } : {}),
        ...(message.tags !== undefined ? { tags: message.tags } : {}),
        priority: message.priority ?? "high",
      },
      body: message.body,
    },
    { timeoutMs, ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) },
  );
  if (!result.ok) {
    return { ok: false, error: { code: "ntfy_unreachable", message: `ntfy publish failed (${result.kind})` } };
  }
  if (result.status >= 400) {
    return { ok: false, error: { code: "ntfy_http_error", message: `ntfy publish failed (HTTP ${result.status})` } };
  }
  return { ok: true };
}

/** Push via ntfy: the watch-notification composition over publishNtfy. */
export function createNtfyNotifier(options: NtfyNotifierOptions): Notifier {
  return {
    id: "ntfy",
    async send(notification) {
      const { title, body } = formatNotification(notification);
      return publishNtfy(options, { title, body, clickUrl: notification.url, tags: "moneybag", priority: "high" });
    },
  };
}

/** Console notifier: writes the composed message to stderr (or a given sink). */
export function createStderrNotifier(write?: (s: string) => void): Notifier {
  const sink = write ?? ((s: string) => process.stderr.write(s));
  return {
    id: "stderr",
    async send(notification) {
      const { title, body } = formatNotification(notification);
      sink(`\n[northcinder-watch] ${title}\n${body}\n`);
      return { ok: true };
    },
  };
}

/** File notifier: appends one JSONL line per notification (0600, append-only). */
export function createFileNotifier(path: string): Notifier {
  return {
    id: "file",
    async send(notification) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const existed = existsSync(path);
        appendFileSync(path, `${JSON.stringify(notification)}\n`, { mode: 0o600 });
        if (!existed) chmodSync(path, 0o600); // appendFileSync's mode is umask-filtered
        return { ok: true };
      } catch {
        return {
          ok: false,
          error: { code: "file_write_failed", message: "notification file write failed" },
        };
      }
    },
  };
}

export interface WebhookNotifierOptions {
  url: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function safeWebhookUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
    if (hostname === "localhost" || hostname.endsWith(".localhost") || isIP(hostname) !== 0) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** Webhook notifier: POSTs {title, body, notification} as JSON to the URL. */
export function createWebhookNotifier(options: WebhookNotifierOptions): Notifier {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const url = safeWebhookUrl(options.url);
  return {
    id: "webhook",
    async send(notification) {
      if (url === undefined) {
        return { ok: false, error: { code: "webhook_url_unsafe", message: "webhook destination is not permitted" } };
      }
      const { title, body } = formatNotification(notification);
      const result = await fetchWithBudget(
        url.toString(),
        {
          method: "POST",
          redirect: "manual",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, body, notification }),
        },
        { timeoutMs, ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}) },
      );
      if (!result.ok) {
        return { ok: false, error: { code: "webhook_unreachable", message: `webhook delivery failed (${result.kind})` } };
      }
      if (result.status >= 300 && result.status < 400) {
        return { ok: false, error: { code: "webhook_redirect_forbidden", message: "webhook redirects are not permitted" } };
      }
      if (result.status >= 400) {
        return { ok: false, error: { code: "webhook_http_error", message: `webhook delivery failed (HTTP ${result.status})` } };
      }
      return { ok: true };
    },
  };
}
