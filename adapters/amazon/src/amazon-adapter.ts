import { z } from "zod";
import {
  OfferSchema,
  storeError,
  type AdapterContext,
  type AdapterManifest,
  type AdapterOfferResult,
  type AdapterSearchResult,
  type Offer,
  type StoreAdapter,
  type StoreError,
} from "@northcinder/protocol";
import { parseDecimalToMinorUnits } from "@northcinder/adapter-kit";
import type { AmazonDriver, AmazonPage, RawAmazonItem } from "./driver.js";

/**
 * The Amazon adapter's public surface extends StoreAdapter with `close()`:
 * the real driver holds a PERSISTENT Playwright browser context (spec §3A —
 * the user's own logged-in profile), which must be explicitly disposed by
 * whoever owns the adapter's lifecycle (not by the orchestrator, which has
 * no notion of adapter teardown).
 */
export interface AmazonStoreAdapter extends StoreAdapter {
  /** Disposes the underlying driver's persistent browser context, if any (best-effort, never throws). */
  close(): Promise<void>;
}

export const AMAZON_STORE_ID = "amazon";
const AMAZON_HOST = "www.amazon.com";
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

export interface AmazonAdapterConfig {
  /**
   * Path to the USER'S OWN browser session profile (spec §3A hard gate: the
   * agent acts only inside the user's own logged-in session). Without it the
   * adapter refuses to run. Fallback env: AMAZON_SESSION_PROFILE.
   */
  sessionProfilePath?: string;
  /** Injectable driver (fakes in tests). Default: the Playwright driver. */
  driver?: AmazonDriver;
  /** Environment source (defaults to process.env; pass {} to isolate tests). */
  env?: Record<string, string | undefined>;
}

function mapItem(item: RawAmazonItem): Offer | null {
  const price = parseDecimalToMinorUnits(item.priceText, item.currency ?? "USD");
  if (!price || !ASIN_PATTERN.test(item.asin)) return null;
  const availabilityText = (item.availabilityText ?? "").toLowerCase();
  const availability: Offer["availability"] = availabilityText.includes("in stock")
    ? "in_stock"
    : availabilityText.includes("unavailable") || availabilityText.includes("out of stock")
      ? "out_of_stock"
      : "unknown";

  const offer: Offer = {
    id: item.asin,
    product: {
      id: item.asin,
      title: item.title,
      url: item.url,
      ...(item.imageUrl && z.url().safeParse(item.imageUrl).success ? { imageUrl: item.imageUrl } : {}),
      attributes: {},
    },
    price,
    merchant: { id: "amazon", name: "Amazon", domain: AMAZON_HOST, platform: "amazon" },
    availability,
    sourceStore: AMAZON_STORE_ID,
    // The page's own "Sponsored" badge flows through UNCHANGED (spec §4:
    // sponsored placements are always labeled, never laundered to organic).
    sponsored: item.sponsored,
  };
  return OfferSchema.safeParse(offer).success ? offer : null;
}

function pageErrorToStoreError(page: Exclude<AmazonPage<never>, { status: "ok" }>): StoreError {
  switch (page.status) {
    case "captcha":
      return storeError(
        AMAZON_STORE_ID,
        "blocked",
        "Amazon presented a CAPTCHA — per the Amazon Agent Terms this agent will not attempt to solve or circumvent it; stopping and degrading gracefully (search continues without Amazon)",
        { retryable: false },
      );
    case "blocked":
      return storeError(
        AMAZON_STORE_ID,
        "blocked",
        `Amazon blocked automated access${page.detail ? ` (${page.detail})` : ""} — backing off as told; search continues without Amazon`,
        { retryable: false },
      );
    case "not_found":
      return storeError(AMAZON_STORE_ID, "not_found", "Amazon product page not found", { retryable: false });
  }
}

/** Race a driver call against the ctx budget — a hung page never hangs the search. */
async function withBudget<T>(run: () => Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const call = run();
  // Best-effort: if the timeout wins the race, `call` is abandoned (the
  // caller never awaits it again) but may still settle later — attach a
  // no-op rejection handler now so a late rejection from a timed-out driver
  // call never surfaces as an unhandled rejection.
  call.catch(() => {});
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export function createAmazonAdapter(config: AmazonAdapterConfig = {}): AmazonStoreAdapter {
  const env = config.env ?? process.env;
  const sessionProfilePath = config.sessionProfilePath ?? env.AMAZON_SESSION_PROFILE;

  const manifest: AdapterManifest = {
    id: AMAZON_STORE_ID,
    name: "Amazon (user-session edge, spec §3A)",
    version: "0.1.0",
    description:
      "Session-only Amazon adapter: Playwright in the user's own logged-in browser profile. Honest agent User-Agent, no CAPTCHA interaction, no human-input mimicry. Search + read-offer only; checkout stays in the user's hands.",
    permissions: { allowedHosts: [AMAZON_HOST], userSession: true },
    capabilities: { checkout: false },
  };

  const notConfigured = (): { ok: false; error: StoreError } => ({
    ok: false,
    error: storeError(
      AMAZON_STORE_ID,
      "not_configured",
      "Amazon adapter refuses to run without an explicit user-session profile path: it acts only inside the user's own logged-in browser session (spec §3A). Set AMAZON_SESSION_PROFILE or pass sessionProfilePath.",
      { retryable: false },
    ),
  });

  const timeoutError = (): StoreError =>
    storeError(AMAZON_STORE_ID, "timeout", "Amazon page did not settle within the call budget");

  let realDriver: AmazonDriver | undefined;
  async function getDriver(): Promise<{ ok: true; driver: AmazonDriver } | { ok: false; error: StoreError }> {
    if (config.driver) return { ok: true, driver: config.driver };
    if (realDriver) return { ok: true, driver: realDriver };
    try {
      const { createPlaywrightAmazonDriver } = await import("./playwright-driver.js");
      realDriver = await createPlaywrightAmazonDriver({ sessionProfilePath: sessionProfilePath! });
      return { ok: true, driver: realDriver };
    } catch (error) {
      return {
        ok: false,
        error: storeError(
          AMAZON_STORE_ID,
          "unavailable",
          `Amazon Playwright driver could not start: ${error instanceof Error ? error.message : String(error)}. ` +
            "Amazon is disabled for this run; install the launcher's optional playwright-core runtime and restart, or remove AMAZON_SESSION_PROFILE to keep Amazon explicitly not configured.",
          { retryable: false },
        ),
      };
    }
  }

  return {
    manifest,

    async search(query, ctx): Promise<AdapterSearchResult> {
      // §3A HARD GATE: no user session profile → refuse before touching anything.
      if (!sessionProfilePath) return notConfigured();
      const acquired = await getDriver();
      if (!acquired.ok) return acquired;
      const page = await withBudget(
        () =>
          acquired.driver.searchResults(query.text, {
            timeoutMs: ctx.timeoutMs,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
        ctx.timeoutMs,
      );
      if (page === "timeout") return { ok: false, error: timeoutError() };
      if (page.status !== "ok") return { ok: false, error: pageErrorToStoreError(page) };
      const offers: Offer[] = [];
      for (const raw of page.data) {
        const offer = mapItem(raw);
        if (offer) offers.push(offer);
      }
      return { ok: true, offers: query.maxResults !== undefined ? offers.slice(0, query.maxResults) : offers };
    },

    async getOffer(offerId, ctx): Promise<AdapterOfferResult> {
      if (!sessionProfilePath) return notConfigured();
      if (!ASIN_PATTERN.test(offerId)) {
        return {
          ok: false,
          error: storeError(AMAZON_STORE_ID, "not_found", `not an Amazon ASIN: ${JSON.stringify(offerId)}`, { retryable: false }),
        };
      }
      const acquired = await getDriver();
      if (!acquired.ok) return acquired;
      const page = await withBudget(
        () =>
          acquired.driver.offerDetails(offerId, {
            timeoutMs: ctx.timeoutMs,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
        ctx.timeoutMs,
      );
      if (page === "timeout") return { ok: false, error: timeoutError() };
      if (page.status !== "ok") return { ok: false, error: pageErrorToStoreError(page) };
      const offer = mapItem(page.data);
      if (!offer) {
        return {
          ok: false,
          error: storeError(AMAZON_STORE_ID, "invalid_response", "Amazon product page did not map to a valid offer", { retryable: false }),
        };
      }
      return { ok: true, offer };
    },

    async close(): Promise<void> {
      // Dispose whichever driver is actually active — the lazily-created
      // real Playwright driver, or an explicitly injected one (fakes in
      // tests, or a caller-supplied driver) — best-effort, never throws.
      const active = config.driver ?? realDriver;
      if (active?.close) await active.close().catch(() => {});
    },
  };
}
