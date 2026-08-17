import type { Money } from "@northcinder/protocol";

/**
 * ISO-4217 minor-unit exponents that differ from the default of 2.
 * Only currencies plausibly seen from the MVP stores are listed; anything
 * unlisted uses 2 (correct for USD/EUR/GBP/CAD/AUD/…).
 */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "XOF", "XAF", "BIF", "DJF", "GNF", "KMF", "MGA", "PYG", "RWF", "UGX", "VUV"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function currencyExponent(currency: string): number {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}

const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * Parse a decimal price STRING (possibly with currency symbols / thousands
 * separators, e.g. "$1,299.95", "110.0") into protocol Money — integer minor
 * units, never touching floats. Returns null when the string is not an
 * unambiguous non-negative decimal or carries more precision than the
 * currency can represent.
 */
export function parseDecimalToMinorUnits(raw: string, currency: string): Money | null {
  if (!CURRENCY_CODE.test(currency)) return null;
  const cleaned = raw.replace(/[^0-9.\-]/g, "");
  if (cleaned.length === 0 || cleaned.includes("-")) return null;
  const match = /^(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) return null;
  const whole = match[1] === "" ? "0" : match[1]!;
  const fracRaw = match[2] ?? "";
  const exp = currencyExponent(currency);
  // Trailing zeros beyond the exponent are fine ("110.0" JPY); real precision is not.
  const fracTrimmed = fracRaw.replace(/0+$/, "");
  if (fracTrimmed.length > exp) return null;
  const frac = fracTrimmed.padEnd(exp, "0");
  const amount = Number(whole + frac || "0");
  if (!Number.isSafeInteger(amount)) return null;
  return { amount, currency };
}

/**
 * Convert an (amount, divisor) scaled integer pair (Etsy Open API v3 money
 * shape) into protocol Money minor units. Returns null when the value is not
 * exactly representable in the currency's minor unit.
 */
export function scaledToMinorUnits(amount: number, divisor: number, currency: string): Money | null {
  if (!CURRENCY_CODE.test(currency)) return null;
  if (!Number.isSafeInteger(amount) || amount < 0) return null;
  if (!Number.isSafeInteger(divisor) || divisor <= 0) return null;
  const scale = 10 ** currencyExponent(currency);
  const numerator = amount * scale;
  if (numerator % divisor !== 0) return null;
  const minor = numerator / divisor;
  if (!Number.isSafeInteger(minor)) return null;
  return { amount: minor, currency };
}
