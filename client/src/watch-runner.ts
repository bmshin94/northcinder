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
import { join } from "node:path";
import type { AdapterContext, SearchQuery, StoreAdapter, WatchChannel } from "@northcinder/protocol";
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

/** Re-fetch current offers through the normal client→service search path. */
export function createServiceOfferSource(service: NorthCinderServiceClient): OfferSource {
  return {
    async search(query: SearchQuery) {
      const result = await service.search(query);
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, offers: result.data.results.map((r) => r.offer) };
    },
  };
}

/** Re-fetch directly from one StoreAdapter (fixture/reference mode). */
export function createAdapterOfferSource(adapter: StoreAdapter, timeoutMs = 10_000): OfferSource {
  return {
    async search(query: SearchQuery) {
      const ctx: AdapterContext = { timeoutMs };
      const result = await adapter.search(query, ctx);
      if (!result.ok) return { ok: false, error: { code: result.error.code, message: result.error.message } };
      return { ok: true, offers: result.offers };
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
            "ntfy channel has no topic: set one on the watch or export NORTHCINDER_NTFY_TOPIC for the northcinder-watch runner",
          );
        }
        return createNtfyNotifier({ topic, ...(options.ntfyBaseUrl !== undefined ? { baseUrl: options.ntfyBaseUrl } : {}), ...http });
      }
      case "stderr":
        return createStderrNotifier(options.stderrSink);
      case "file":
        return createFileNotifier(channel.path ?? join(options.configDir, "notifications.jsonl"));
      case "webhook":
        return createWebhookNotifier({ url: channel.url, ...http });
    }
  };
}
