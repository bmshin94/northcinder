/**
 * The REAL Amazon driver: Playwright (playwright-core — no bundled browser
 * download) driving the USER'S OWN persistent browser profile (spec §3A).
 *
 * Honesty standard, implemented as construction, not policy:
 * - `AGENT_USER_AGENT` is set on the browser context, so EVERY request
 *   self-identifies as an agent (Amazon Agent Terms).
 * - Navigation is URL-based `page.goto` only. This module contains no
 *   keyboard/mouse/typing calls — nothing mimics human input.
 * - A CAPTCHA or block interstitial short-circuits to a structured status;
 *   there is no code path that interacts with a challenge.
 *
 * This module is exercised live (needs a real logged-in profile) — unit
 * tests cover the adapter's gates through the injectable AmazonDriver fake.
 */
import type { AmazonDriver, AmazonDriverContext, AmazonPage, RawAmazonItem } from "./driver.js";
import { AGENT_USER_AGENT } from "./user-agent.js";

const CAPTCHA_MARKERS = [
  "/errors/validatecaptcha",
  "type the characters you see in this image",
  "enter the characters you see below",
  "api-services-support@amazon.com",
];
const BLOCK_MARKERS = ["to discuss automated access to amazon data", "request could not be satisfied"];

export interface PlaywrightAmazonDriverConfig {
  /** The user's own persistent browser profile directory (REQUIRED — §3A). */
  sessionProfilePath: string;
  /** Marketplace host (default www.amazon.com; must stay within the manifest scope). */
  host?: string;
  /** Browser channel, e.g. "chrome" to use the user's installed Chrome. */
  channel?: string;
  headless?: boolean;
}

export async function createPlaywrightAmazonDriver(
  config: PlaywrightAmazonDriverConfig,
): Promise<AmazonDriver> {
  if (!config.sessionProfilePath) {
    throw new Error("Amazon driver requires the user's own session profile path (spec §3A)");
  }
  const host = config.host ?? "www.amazon.com";
  const { chromium } = await import("playwright-core");
  const context = await chromium.launchPersistentContext(config.sessionProfilePath, {
    userAgent: AGENT_USER_AGENT, // honest self-identification on every request
    headless: config.headless ?? false,
    ...(config.channel ? { channel: config.channel } : {}),
  });

  async function classifyPage(pageText: string): Promise<"captcha" | "blocked" | null> {
    const lower = pageText.toLowerCase();
    if (CAPTCHA_MARKERS.some((m) => lower.includes(m))) return "captcha";
    if (BLOCK_MARKERS.some((m) => lower.includes(m))) return "blocked";
    return null;
  }

  return {
    async searchResults(query: string, ctx: AmazonDriverContext): Promise<AmazonPage<RawAmazonItem[]>> {
      const page = await context.newPage();
      try {
        const response = await page.goto(`https://${host}/s?k=${encodeURIComponent(query)}`, {
          timeout: ctx.timeoutMs,
          waitUntil: "domcontentloaded",
        });
        const text = await page.content();
        const verdict = await classifyPage(text);
        if (verdict === "captcha") return { status: "captcha" };
        if (verdict === "blocked" || (response && response.status() >= 500)) {
          return { status: "blocked", ...(response ? { detail: `HTTP ${response.status()}` } : {}) };
        }
        const items = await page.$$eval('[data-component-type="s-search-result"]', (nodes, pageHost) =>
          nodes.slice(0, 20).flatMap((node) => {
            const asin = node.getAttribute("data-asin") ?? "";
            const titleEl = node.querySelector("h2 span");
            const priceEl = node.querySelector(".a-price .a-offscreen");
            const linkEl = node.querySelector("a.a-link-normal[href*='/dp/'], h2 a");
            const imgEl = node.querySelector("img.s-image");
            const sponsored =
              node.querySelector(".puis-sponsored-label-text") !== null ||
              /(^|\s)Sponsored(\s|$)/.test(node.textContent ?? "") === true &&
                node.querySelector("[aria-label='View Sponsored information or leave ad feedback']") !== null;
            if (!asin || !titleEl?.textContent || !priceEl?.textContent) return [];
            const href = linkEl?.getAttribute("href") ?? `/dp/${asin}`;
            return [
              {
                asin,
                title: titleEl.textContent.trim(),
                priceText: priceEl.textContent.trim(),
                url: href.startsWith("http") ? href : `https://${pageHost}${href}`,
                imageUrl: imgEl?.getAttribute("src") ?? undefined,
                sponsored,
              },
            ];
          }),
          host,
        );
        return { status: "ok", data: items as RawAmazonItem[] };
      } finally {
        await page.close().catch(() => {});
      }
    },

    async offerDetails(asin: string, ctx: AmazonDriverContext): Promise<AmazonPage<RawAmazonItem>> {
      const page = await context.newPage();
      try {
        const response = await page.goto(`https://${host}/dp/${asin}`, {
          timeout: ctx.timeoutMs,
          waitUntil: "domcontentloaded",
        });
        if (response && response.status() === 404) return { status: "not_found" };
        const text = await page.content();
        const verdict = await classifyPage(text);
        if (verdict === "captcha") return { status: "captcha" };
        if (verdict === "blocked" || (response && response.status() >= 500)) {
          return { status: "blocked", ...(response ? { detail: `HTTP ${response.status()}` } : {}) };
        }
        const item = await page.evaluate((currentAsin) => {
          const title = document.querySelector("#productTitle")?.textContent?.trim();
          const priceText = document
            .querySelector("#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, .a-price .a-offscreen")
            ?.textContent?.trim();
          const availabilityText = document.querySelector("#availability")?.textContent?.trim();
          const imageUrl = document.querySelector("#landingImage")?.getAttribute("src") ?? undefined;
          if (!title || !priceText) return null;
          return {
            asin: currentAsin,
            title,
            priceText,
            url: location.href.split("?")[0],
            imageUrl,
            availabilityText,
            sponsored: false, // a directly-loaded product page is not a paid placement
          };
        }, asin);
        if (!item) return { status: "not_found" };
        return { status: "ok", data: item as RawAmazonItem };
      } finally {
        await page.close().catch(() => {});
      }
    },

    async close() {
      await context.close().catch(() => {});
    },
  };
}
