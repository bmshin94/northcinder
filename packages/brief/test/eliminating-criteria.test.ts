import { describe, expect, it } from "vitest";
import { RANK_ELIMINATION_CODES, type Offer, type RankedResult } from "@northcinder/protocol";
import { eliminatingCriteria } from "../src/compose.js";

const OFFER: Offer = {
  id: "o1",
  product: { id: "p1", title: "Wool Runner", url: "https://shop.example/p1", attributes: {} },
  price: { amount: 15000, currency: "USD" },
  merchant: { id: "shop.example", name: "Shop", domain: "shop.example" },
  availability: "in_stock",
  sourceStore: "ebay",
  sponsored: false,
};

function ranked(reasons: RankedResult["reasons"]): RankedResult {
  return { offer: OFFER, score: 10, reasons };
}

describe("eliminatingCriteria — keys off rank.ts's structured reason code, not detail prose", () => {
  it("detects an over-budget elimination via code even when detail's wording no longer says 'exceeds budget'", () => {
    const result = ranked([
      { criterion: "price", detail: "totally different wording, no longer mentions the old phrase", code: RANK_ELIMINATION_CODES.OVER_BUDGET },
    ]);
    expect(eliminatingCriteria(result)).toEqual([
      "over budget: totally different wording, no longer mentions the old phrase",
    ]);
  });

  it("does NOT eliminate a price reason that merely happens to contain old prose but carries no code", () => {
    const result = ranked([{ criterion: "price", detail: "lowest price: 9800 USD, exceeds budget of nothing (not a real elimination)" }]);
    expect(eliminatingCriteria(result)).toEqual([]);
  });

  it("detects spec_missing / delivery_missed / out_of_stock via code alone", () => {
    expect(
      eliminatingCriteria(ranked([{ criterion: "spec_match", detail: "custom wording", code: RANK_ELIMINATION_CODES.SPEC_MISSING }])),
    ).toEqual(["missing must-have attributes: custom wording"]);
    expect(
      eliminatingCriteria(ranked([{ criterion: "delivery", detail: "custom wording", code: RANK_ELIMINATION_CODES.DELIVERY_MISSED }])),
    ).toEqual(["misses delivery deadline: custom wording"]);
    expect(
      eliminatingCriteria(ranked([{ criterion: "availability", detail: "custom wording", code: RANK_ELIMINATION_CODES.OUT_OF_STOCK }])),
    ).toEqual(["out of stock"]);
  });
});
