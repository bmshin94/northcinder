import { describe, expect, it } from "vitest";
import { parseDecimalToMinorUnits, scaledToMinorUnits } from "../src/index.js";

describe("parseDecimalToMinorUnits (float-free money parsing)", () => {
  it("parses plain decimal strings into integer minor units", () => {
    expect(parseDecimalToMinorUnits("110.0", "USD")).toEqual({ amount: 11000, currency: "USD" });
    expect(parseDecimalToMinorUnits("29.99", "USD")).toEqual({ amount: 2999, currency: "USD" });
    expect(parseDecimalToMinorUnits("10.5", "EUR")).toEqual({ amount: 1050, currency: "EUR" });
    expect(parseDecimalToMinorUnits("0.99", "GBP")).toEqual({ amount: 99, currency: "GBP" });
  });

  it("parses integers and currency-symbol/comma noise", () => {
    expect(parseDecimalToMinorUnits("110", "USD")).toEqual({ amount: 11000, currency: "USD" });
    expect(parseDecimalToMinorUnits("$1,299.95", "USD")).toEqual({ amount: 129995, currency: "USD" });
    expect(parseDecimalToMinorUnits("€45.00", "EUR")).toEqual({ amount: 4500, currency: "EUR" });
  });

  it("handles zero-decimal currencies", () => {
    expect(parseDecimalToMinorUnits("1200", "JPY")).toEqual({ amount: 1200, currency: "JPY" });
    expect(parseDecimalToMinorUnits("1200.0", "JPY")).toEqual({ amount: 1200, currency: "JPY" });
  });

  it("rejects garbage, negatives, and over-precise values", () => {
    expect(parseDecimalToMinorUnits("abc", "USD")).toBeNull();
    expect(parseDecimalToMinorUnits("", "USD")).toBeNull();
    expect(parseDecimalToMinorUnits("-5.00", "USD")).toBeNull();
    expect(parseDecimalToMinorUnits("1.999", "USD")).toBeNull();
    expect(parseDecimalToMinorUnits("12.50", "usd")).toBeNull();
  });
});

describe("scaledToMinorUnits (Etsy-style amount+divisor)", () => {
  it("converts amount/divisor pairs to minor units", () => {
    expect(scaledToMinorUnits(1250, 100, "USD")).toEqual({ amount: 1250, currency: "USD" });
    expect(scaledToMinorUnits(125, 10, "USD")).toEqual({ amount: 1250, currency: "USD" });
    expect(scaledToMinorUnits(1200, 1, "JPY")).toEqual({ amount: 1200, currency: "JPY" });
  });

  it("rejects non-integral results and invalid input", () => {
    expect(scaledToMinorUnits(125, 1000, "USD")).toBeNull(); // 0.125 USD is not representable
    expect(scaledToMinorUnits(-1, 100, "USD")).toBeNull();
    expect(scaledToMinorUnits(100, 0, "USD")).toBeNull();
    expect(scaledToMinorUnits(1.5, 100, "USD")).toBeNull();
  });
});
