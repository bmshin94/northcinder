/**
 * Wiring for the northcinder-watch scheduler: adapts the client's EXISTING
 * budgeted paths into @northcinder/watches' minimal interfaces.
 *
 *   - OfferSource over the northcinder service client (the same fetchWithBudget
 *     path search_products uses — budgets and body caps for free), or over
 *     any StoreAdapter (used by the `--source reference` fixture mode).
 *   - notifierFor: maps a watch's channel to a concrete Notifier. The ntfy
 *     topic (a bearer secret) comes from the watch record or
 *     NORTHCINDER_NTFY_TOPIC; it is never logged and never appears in errors.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AdapterContext, SearchQuery, SourceStatus, StoreAdapter, StoreStatus, WatchChannel } from "@northcinder/protocol";
import {
  createFileNotifier,
  createNtfyNotifier,
  createStderrNotifier,
  createWebhookNotifier,
  type Notifier,
  type OfferSource,
  type WatchRunSummary,
} from "@northcinder/watches";
import type { NorthCinderServiceClient } from "./service-client.js";

function maximumCarriedDelay(statuses: Array<StoreStatus | SourceStatus>): number | undefined {
  const delays = statuses.flatMap((status) =>
    !status.ok && status.error.retryAfterMs !== undefined
      ? [status.error.retryAfterMs]
      : [],
  );
  return delays.length === 0 ? undefined : Math.max(...delays);
}

/** Re-fetch current offers through the normal client→service search path. */
export function createServiceOfferSource(service: NorthCinderServiceClient): OfferSource {
  return {
    async search(query: SearchQuery) {
      const result = await service.search(query);
      if (!result.ok) return { ok: false, error: result.error };
      const statuses = result.data.storeStatuses;
      const childStatuses = statuses.flatMap((status) => status.ok ? status.sourceStatuses ?? [] : []);
      const failures = [
        ...statuses.filter((status): status is Extract<StoreStatus, { ok: false }> => !status.ok),
        ...childStatuses.filter((status): status is Extract<SourceStatus, { ok: false }> => !status.ok),
      ];
      const everyAttemptFailed = statuses.length > 0 && statuses.every((status) =>
        !status.ok || (status.sourceStatuses !== undefined && status.sourceStatuses.length > 0 && status.sourceStatuses.every((source) => !source.ok)),
      );
      const retryAfterMs = maximumCarriedDelay(failures);
      if (everyAttemptFailed) {
        const allRateLimited = failures.length > 0 && failures.every((failure) => failure.error.code === "rate_limited");
        return {
          ok: false,
          error: {
            code: allRateLimited ? "rate_limited" : "source_unavailable",
            message: "all attempted watch sources failed",
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          },
        };
      }
      return {
        ok: true,
        offers: result.data.results.map((r) => r.offer),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    },
    async getOffer(store, offerId) {
      const result = await service.getOffer(store, offerId);
      return result.ok ? { ok: true, offer: result.data } : { ok: false, error: result.error };
    },
  };
}

/** Re-fetch directly from one StoreAdapter (fixture/reference mode). */
export function createAdapterOfferSource(adapter: StoreAdapter, timeoutMs = 10_000): OfferSource {
  return {
    async search(query: SearchQuery) {
      const ctx: AdapterContext = { timeoutMs };
      const result = await adapter.search(query, ctx);
      if (!result.ok) return { ok: false, error: {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.retryAfterMs !== undefined ? { retryAfterMs: result.error.retryAfterMs } : {}),
      } };
      const retryAfterMs = maximumCarriedDelay(result.sourceStatuses ?? []);
      return { ok: true, offers: result.offers, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    },
    async getOffer(store, offerId) {
      if (store !== adapter.manifest.id) return { ok: false, error: { code: "not_configured", message: "watch store adapter is not configured" } };
      const result = await adapter.getOffer(offerId, { timeoutMs });
      return result.ok
        ? { ok: true, offer: result.offer }
        : {
            ok: false,
            error: {
              code: result.error.code,
              message: result.error.message,
              ...(result.error.retryAfterMs !== undefined ? { retryAfterMs: result.error.retryAfterMs } : {}),
            },
          };
    },
  };
}

/**
 * Exit code for a `--once` tick: 1 when EVERY check failed outright
 * (source_error / notify_failed) — a scheduler that can't reach its source
 * or deliver anything must be visible to cron/launchd — and 0 otherwise
 * (partial failure is a normal, reported state; an empty tick is healthy).
 */
export function watchRunExitCode(summary: WatchRunSummary): 0 | 1 {
  if (summary.reports.length === 0) return 0;
  const failed = (outcome: string): boolean => outcome === "source_error" || outcome === "notify_failed";
  return summary.reports.every((r) => failed(r.outcome)) ? 1 : 0;
}

export interface NotifierWiringOptions {
  configDir: string;
  /** Default ntfy topic (NORTHCINDER_NTFY_TOPIC) for channels without their own. */
  ntfyTopic?: string;
  /** Default https://ntfy.sh; point at a self-hosted instance to keep pushes local. */
  ntfyBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** stderr sink override (tests). */
  stderrSink?: (s: string) => void;
}

/** A Notifier that reports a configuration gap instead of silently dropping. */
function misconfiguredNotifier(code: string, message: string): Notifier {
  return { id: "misconfigured", send: async () => ({ ok: false, error: { code, message } }) };
}

function isContainedPath(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function safeNotificationFile(configDir: string, configuredPath?: string): string | undefined {
  const base = resolve(configDir);
  const candidate = resolve(configuredPath ?? join(configDir, "notifications.jsonl"));
  if (!isContainedPath(base, candidate)) return undefined;

  try {
    const realBase = realpathSync(base);
    let ancestor = existsSync(candidate) ? candidate : dirname(candidate);
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) return undefined;
      ancestor = parent;
    }
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) return undefined;
    if (!isContainedPath(realBase, realpathSync(ancestor))) return undefined;
  } catch {
    return undefined;
  }
  return candidate;
}

export function createChannelNotifierFor(options: NotifierWiringOptions): (channel: WatchChannel) => Notifier {
  const http = {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  };
  return (channel) => {
    switch (channel.type) {
      case "ntfy": {
        const topic = channel.topic ?? options.ntfyTopic;
        if (topic === undefined) {
          // Leak discipline: names the MISSING setting, no channel values.
          return misconfiguredNotifier(
            "ntfy_topic_missing",
            "ntfy channel has no configured topic: export NORTHCINDER_NTFY_TOPIC for the northcinder-watch runner",
          );
        }
        return createNtfyNotifier({ topic, ...(options.ntfyBaseUrl !== undefined ? { baseUrl: options.ntfyBaseUrl } : {}), ...http });
      }
      case "stderr":
        return createStderrNotifier(options.stderrSink);
      case "file": {
        const path = safeNotificationFile(options.configDir, channel.path);
        return path === undefined
          ? misconfiguredNotifier(
              "unsafe_notification_file",
              "watch notification file must stay inside the buyer-local config directory",
            )
          : createFileNotifier(path);
      }
      case "webhook":
        return createWebhookNotifier({ url: channel.url, ...http });
    }
  };
}
