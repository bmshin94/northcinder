/**
 * Invariant #4, compile-time half: checkout is UNREACHABLE without a mandate
 * BY CONSTRUCTION. Rails demand a `VerifiedMandate`, whose brand symbol is
 * module-private to the verifier — a raw `PurchaseMandate` (or a hand-built
 * lookalike object) is a TYPE ERROR at a rail boundary. This file is
 * typechecked by `vitest --typecheck`; if any @ts-expect-error line stops
 * erroring, the build goes RED.
 */
import { describe, expectTypeOf, it } from "vitest";
import type { Offer, PurchaseMandate } from "@northcinder/protocol";
import type { CheckoutRail, RailContext, VerifiedMandate } from "../src/index.js";

declare const rail: CheckoutRail;
declare const offer: Offer;
declare const mandate: PurchaseMandate;
declare const ctx: RailContext;

describe("invariant #4 — mandate hard gate holds at compile time", () => {
  it("a raw PurchaseMandate cannot be passed where a VerifiedMandate is required", () => {
    // @ts-expect-error — rails only accept a VerifiedMandate produced by the verifier
    void rail.execute(offer, mandate, ctx);
  });

  it("checkout cannot be invoked with no mandate at all", () => {
    // @ts-expect-error — the verified-mandate parameter is mandatory
    void rail.execute(offer, ctx);
  });

  it("the brand cannot be forged with a structural lookalike object", () => {
    // @ts-expect-error — the brand symbol is not exported; object literals cannot produce it
    const forged: VerifiedMandate = { mandate, verifiedAt: "2026-07-04T00:00:00.000Z" };
    void forged;
  });

  it("VerifiedMandate and PurchaseMandate are distinct types", () => {
    expectTypeOf<VerifiedMandate>().not.toEqualTypeOf<PurchaseMandate>();
    expectTypeOf<PurchaseMandate>().not.toExtend<VerifiedMandate>();
  });
});
