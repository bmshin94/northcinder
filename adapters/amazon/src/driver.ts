/**
 * The Amazon driver contract — deliberately NARROW (spec §3A honesty by
 * construction): the only capabilities are "load a search results page" and
 * "load a product page", both read-only navigations. There is intentionally
 * NO type/click/keystroke/mouse surface here, so the adapter is physically
 * unable to mimic human input or interact with a CAPTCHA.
 */
export interface RawAmazonItem {
  /** Amazon Standard Identification Number (10 chars, alphanumeric). */
  asin: string;
  title: string;
  /** Price as shown on the page, e.g. "$39.99" — parsed float-free upstream. */
  priceText: string;
  /** ISO-4217 code; defaults to USD for amazon.com. */
  currency?: string;
  url: string;
  imageUrl?: string;
  availabilityText?: string;
  /** True when the page marks the placement "Sponsored" — must survive mapping. */
  sponsored: boolean;
}

export type AmazonPage<T> =
  | { status: "ok"; data: T }
  /** A CAPTCHA interstitial was detected. The agent stops — it never solves. */
  | { status: "captcha" }
  /** Amazon served a block/robot page (e.g. 503 automated-access). */
  | { status: "blocked"; detail?: string }
  | { status: "not_found" };

export interface AmazonDriverContext {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AmazonDriver {
  /** Load https://<host>/s?k=<query> (URL navigation — no keystroke simulation). */
  searchResults(query: string, ctx: AmazonDriverContext): Promise<AmazonPage<RawAmazonItem[]>>;
  /** Load https://<host>/dp/<asin>. */
  offerDetails(asin: string, ctx: AmazonDriverContext): Promise<AmazonPage<RawAmazonItem>>;
  close?(): Promise<void>;
}
