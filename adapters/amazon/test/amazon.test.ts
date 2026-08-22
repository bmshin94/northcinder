import { describe, expect, it } from "vitest";
import { OfferSchema } from "@northcinder/protocol";
import { runConformanceSuite } from "@northcinder/protocol/conformance";
import {
  AGENT_USER_AGENT,
  createAmazonAdapter,
  type AmazonDriver,
  type RawAmazonItem,
} from "../src/index.js";

const KNOWN_ASIN = "B0EMPT0R01";

const FIXTURE_ITEMS: RawAmazonItem[] = [
  {
    asin: KNOWN_ASIN,
    title: "Anker 735 Charger (GaNPrime 65W) USB C Wall Charger",
    priceText: "$39.99",
    currency: "USD",
    url: "https://www.amazon.com/dp/B0EMPT0R01",
    imageUrl: "https://m.media-amazon.com/images/I/fixture735.jpg",
    availabilityText: "In Stock",
    sponsored: false,
  },
  {
    asin: "B0EMPT0R02",
    title: "UGREEN Nexode 65W USB C Charger Block",
    priceText: "$1,299.00",
    currency: "USD",
    url: "https://www.amazon.com/dp/B0EMPT0R02",
    sponsored: true,
  },
];

/** Fake driver: records every method invoked (via Proxy) and each call. */
function createFakeDriver(overrides: Partial<AmazonDriver> = {}) {
  const methodsInvoked = new Set<string>();
  const calls: Array<{ method: string; arg: string }> = [];
  const base: AmazonDriver = {
    async searchResults() {
      return { status: "ok", data: FIXTURE_ITEMS };
    },
    async offerDetails(asin) {
      const item = FIXTURE_ITEMS.find((i) => i.asin === asin);
      return item ? { status: "ok", data: item } : { status: "not_found" };
    },
  };
  const target: AmazonDriver = { ...base, ...overrides };
  const driver = new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "string") methodsInvoked.add(prop);
      const value = Reflect.get(t, prop, receiver);
      if (typeof value === "function" && typeof prop === "string") {
        return (...args: unknown[]) => {
          // Record EVERY driver interaction (including overridden methods) so
          // the "no further calls after CAPTCHA" assertion is airtight.
          if (prop !== "close") calls.push({ method: prop, arg: String(args[0]) });
          return (value as (...a: unknown[]) => unknown).apply(t, args);
        };
      }
      return value;
    },
  });
  return { driver, methodsInvoked, calls };
}

function fixtureAdapter() {
  return createAmazonAdapter({
    sessionProfilePath: "/tmp/northcinder-fake-session-profile",
    driver: createFakeDriver().driver,
    env: {},
  });
}

// --- Conformance (offline, fake-driver-backed) ------------------------------
runConformanceSuite(() => fixtureAdapter(), {
  searchQuery: { text: "usb c charger" },
  knownOfferId: KNOWN_ASIN,
});

describe("amazon adapter — §3A honesty gates", () => {
  it("HONEST USER-AGENT: identifies as an automated agent without inventing a public coordinate", () => {
    expect(AGENT_USER_AGENT).toContain("NorthCinderAgent/0.2");
    expect(AGENT_USER_AGENT).not.toContain("NorthCinderAgent/0.1");
    expect(AGENT_USER_AGENT).toMatch(/northcinder/i);
    expect(AGENT_USER_AGENT).toMatch(/agent/i);
    expect(AGENT_USER_AGENT).toContain("automated shopping agent");
    expect(AGENT_USER_AGENT).not.toMatch(/https?:\/\/|github\.com\/northcinder/i);
    // No human-browser mimicry tokens (Amazon Agent Terms: self-identify, don't spoof).
    expect(AGENT_USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari|Gecko|WebKit/i);
  });

  it("REFUSES to run without an explicit user-session profile path — even with a driver injected", async () => {
    const fake = createFakeDriver();
    const adapter = createAmazonAdapter({ driver: fake.driver, env: {} });
    const search = await adapter.search({ text: "anything" }, { timeoutMs: 500 });
    expect(search.ok).toBe(false);
    if (search.ok) return;
    expect(search.error.code).toBe("not_configured");
    expect(search.error.retryable).toBe(false);
    expect(search.error.message).toMatch(/session profile|AMAZON_SESSION_PROFILE/);
    expect(search.error.message).toMatch(/own/); // user's OWN session, spec §3A
    const offer = await adapter.getOffer(KNOWN_ASIN, { timeoutMs: 500 });
    expect(offer.ok).toBe(false);
    if (!offer.ok) expect(offer.error.code).toBe("not_configured");
    expect(fake.calls).toEqual([]); // the gate holds before any page is touched
  });

  it("CAPTCHA detected → graceful stop: structured blocked, no solving, no further driver calls", async () => {
    const fake = createFakeDriver({
      async searchResults() {
        return { status: "captcha" };
      },
    });
    const adapter = createAmazonAdapter({
      sessionProfilePath: "/tmp/northcinder-fake-session-profile",
      driver: fake.driver,
      env: {},
    });
    const result = await adapter.search({ text: "usb c charger" }, { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("blocked");
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toMatch(/CAPTCHA/i);
    expect(result.error.message).toMatch(/not.*(solve|circumvent|attempt)/i);
    // Exactly one page interaction happened, then a full stop.
    expect(fake.calls).toEqual([{ method: "searchResults", arg: "usb c charger" }]);
  });

  it("block page → structured blocked (degrades gracefully; the fan-out continues store-less upstream)", async () => {
    const fake = createFakeDriver({
      async searchResults() {
        return { status: "blocked", detail: "503 automated access page" };
      },
    });
    const adapter = createAmazonAdapter({
      sessionProfilePath: "/tmp/p",
      driver: fake.driver,
      env: {},
    });
    const result = await adapter.search({ text: "x" }, { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("blocked");
    expect(result.error.retryable).toBe(false);
  });

  it("NO HUMAN-INPUT MIMICRY by construction: the adapter only ever navigates/reads (searchResults/offerDetails)", async () => {
    const fake = createFakeDriver();
    const adapter = createAmazonAdapter({
      sessionProfilePath: "/tmp/p",
      driver: fake.driver,
      env: {},
    });
    await adapter.search({ text: "usb c charger" }, { timeoutMs: 1000 });
    await adapter.getOffer(KNOWN_ASIN, { timeoutMs: 1000 });
    await adapter.getOffer("B000BOGUS99", { timeoutMs: 1000 });
    const allowed = new Set(["searchResults", "offerDetails", "close", "then"]);
    for (const method of fake.methodsInvoked) {
      expect(allowed.has(method), `adapter touched driver.${method} — only navigation/read APIs are permitted`).toBe(true);
    }
  });
});

describe("amazon adapter — mapping & structure", () => {
  it("maps raw items to schema-valid offers, PRESERVING the sponsored flag from the page", async () => {
    const adapter = fixtureAdapter();
    const result = await adapter.search({ text: "usb c charger" }, { timeoutMs: 1000 });
    if (!result.ok) throw new Error(`search failed: ${result.error.message}`);
    expect(result.offers).toHaveLength(2);
    const [anker, ugreen] = result.offers;
    expect(anker!.id).toBe(KNOWN_ASIN);
    expect(anker!.price).toEqual({ amount: 3999, currency: "USD" });
    expect(anker!.availability).toBe("in_stock");
    expect(anker!.sponsored).toBe(false);
    expect(anker!.merchant.platform).toBe("amazon");
    expect(anker!.merchant.domain).toBe("www.amazon.com");
    expect(anker!.sourceStore).toBe("amazon");
    // A sponsored placement on the page stays labeled — never laundered to organic.
    expect(ugreen!.sponsored).toBe(true);
    expect(ugreen!.price).toEqual({ amount: 129900, currency: "USD" });
    for (const offer of result.offers) expect(OfferSchema.safeParse(offer).success).toBe(true);
  });

  it("getOffer with a malformed ASIN returns not_found WITHOUT touching the browser", async () => {
    const fake = createFakeDriver();
    const adapter = createAmazonAdapter({ sessionProfilePath: "/tmp/p", driver: fake.driver, env: {} });
    const result = await adapter.getOffer("__northcinder-conformance-nonexistent-offer__", { timeoutMs: 500 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
    expect(fake.calls).toEqual([]);
  });

  it("a hanging driver degrades to a structured timeout inside the budget", async () => {
    const fake = createFakeDriver({
      searchResults: () => new Promise(() => {}),
    });
    const adapter = createAmazonAdapter({ sessionProfilePath: "/tmp/p", driver: fake.driver, env: {} });
    const started = Date.now();
    const result = await adapter.search({ text: "x" }, { timeoutMs: 150 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("timeout");
  });

  it("manifest declares the user-session posture: amazon host only, userSession true, no checkout (stays in the user's hands)", () => {
    const adapter = fixtureAdapter();
    expect(adapter.manifest.id).toBe("amazon");
    expect(adapter.manifest.permissions.allowedHosts).toEqual(["www.amazon.com"]);
    expect(adapter.manifest.permissions.userSession).toBe(true);
    expect(adapter.manifest.capabilities.checkout).toBe(false);
    expect(adapter.checkout).toBeUndefined();
  });

  it("close() disposes the underlying driver's persistent context", async () => {
    let closeCalls = 0;
    const fake = createFakeDriver({
      async close() {
        closeCalls += 1;
      },
    });
    const adapter = createAmazonAdapter({ sessionProfilePath: "/tmp/p", driver: fake.driver, env: {} });
    await adapter.search({ text: "usb c charger" }, { timeoutMs: 1000 });
    await adapter.close();
    expect(closeCalls).toBe(1);
  });

  it("close() is a safe no-op when the injected driver declares no close()", async () => {
    const fake = createFakeDriver(); // base fake has no close()
    const adapter = createAmazonAdapter({ sessionProfilePath: "/tmp/p", driver: fake.driver, env: {} });
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it("a timed-out driver call's abandoned promise never surfaces as an unhandled rejection", async () => {
    let rejectLate!: (err: Error) => void;
    const fake = createFakeDriver({
      searchResults: () =>
        new Promise((_resolve, reject) => {
          rejectLate = reject;
        }),
    });
    const adapter = createAmazonAdapter({ sessionProfilePath: "/tmp/p", driver: fake.driver, env: {} });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = await adapter.search({ text: "x" }, { timeoutMs: 50 });
      expect(result.ok).toBe(false);
      // Now let the abandoned driver call reject — best-effort: the adapter
      // must have already attached a handler so this never becomes an
      // unhandled rejection.
      rejectLate(new Error("late navigation failure after timeout"));
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("reads the session profile path from AMAZON_SESSION_PROFILE", async () => {
    const fake = createFakeDriver();
    const adapter = createAmazonAdapter({
      driver: fake.driver,
      env: { AMAZON_SESSION_PROFILE: "/tmp/northcinder-user-profile" },
    });
    const result = await adapter.search({ text: "usb c charger" }, { timeoutMs: 1000 });
    expect(result.ok).toBe(true);
  });
});
