/**
 * local UI acceptance suite — the localhost approval page + dashboard.
 *
 * SECURITY-CRITICAL: this server is the SECOND DOOR into the purchase
 * authorization gate. Every test here is a contract:
 *   - wrong/missing session token → rejected on reads AND mutations
 *   - no CORS grant of any kind
 *   - the approval page renders the SAME four-tuple + fingerprint the code
 *     channels showed, and approves via the SAME store.approve() gate
 *   - double-approve via both doors is impossible
 *   - the token / approval URL never reach MCP tool results
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rankOffers, type Offer, type SearchRankResponse } from "@northcinder/protocol";
import { loadOrCreateMandateKeypair } from "@northcinder/checkout";
import { createProfileStore } from "@northcinder/profile";
import { createWatchStore } from "@northcinder/watches";
import { createOrderGraphStore } from "@northcinder/orders";
import { createAuditLog } from "../src/audit-log.js";
import { BRAND_NAME } from "../src/brand.js";
import { createAuthorizationStore, type AuthorizationStore } from "../src/authorization.js";
import { composeApprovalPush, createLocalUiApp, generateSessionToken, startLocalUi } from "../src/local-ui.js";
import { createOrderStore } from "../src/order-store.js";
import { renderOrderTuple } from "../src/order-tuple.js";
import { createNorthCinderMcpServer } from "../src/server.js";
import type { NorthCinderServiceClient } from "../src/service-client.js";

const OFFER: Offer = {
  id: "offer-ui-1",
  product: {
    id: "p-ui-1",
    title: "Wool Runner Mizzle",
    url: "https://www.allbirds.com/products/wool-runner-mizzle",
    attributes: { size: "EU 43" },
  },
  price: { amount: 11500, currency: "USD" },
  merchant: { id: "www.allbirds.com", name: "Allbirds", domain: "www.allbirds.com", platform: "shopify" },
  availability: "in_stock",
  sourceStore: "shopify",
  sponsored: false,
};

const TOKEN = generateSessionToken();

interface Harness {
  app: ReturnType<typeof createLocalUiApp>;
  store: AuthorizationStore;
  configDir: string;
  auditPath: string;
  profile: ReturnType<typeof createProfileStore>;
  watches: ReturnType<typeof createWatchStore>;
  orders: ReturnType<typeof createOrderStore>;
}

function makeHarness(): Harness {
  const configDir = mkdtempSync(join(tmpdir(), "northcinder-ui-"));
  const keypair = loadOrCreateMandateKeypair({ configDir });
  const audit = createAuditLog(configDir);
  const store = createAuthorizationStore({ keypair, configDir, quiet: true });
  const profile = createProfileStore({ configDir });
  const watches = createWatchStore({ configDir });
  const orders = createOrderStore(configDir);
  const app = createLocalUiApp({ sessionToken: TOKEN, authorizations: store, audit, profile, watches, orders });
  return { app, store, configDir, auditPath: audit.path, profile, watches, orders };
}

function codeOnDisk(configDir: string, authorizationId: string): string {
  return readFileSync(join(configDir, "pending-authorizations", `${authorizationId}.code`), "utf8")
    .split("\n")[0]!
    .trim();
}

function auditLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function form(fields: Record<string, string>): { method: "POST"; headers: Record<string, string>; body: string } {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

// ---------------------------------------------------------------------------
describe("session-token gate — EVERY route, reads AND mutations", () => {
  const { app, store, configDir, profile } = makeHarness();
  const pending = store.request(OFFER, { intent: "token gate test" }).authorization;

  const reads = [`/dashboard`, `/dashboard?tab=audit`, `/approve/${pending.id}`, `/`];
  const mutations = [
    { path: `/approve/${pending.id}`, fields: { code: "XXXX-XXXX" } },
    { path: `/decline/${pending.id}`, fields: {} },
    { path: `/profile/add`, fields: { kind: "ethics", flag: "fair-trade" } },
    { path: `/profile/delete`, fields: { id: "pref_x" } },
    { path: `/watches/watch_x/cancel`, fields: {} },
  ];

  it("rejects READS with a missing or wrong token (401, uniform body)", async () => {
    for (const path of reads) {
      const missing = await app.request(path);
      expect(missing.status, `missing token on GET ${path}`).toBe(401);
      expect(await missing.text()).toBe("unauthorized");
      const sep = path.includes("?") ? "&" : "?";
      const wrong = await app.request(`${path}${sep}t=wrong-token`);
      expect(wrong.status, `wrong token on GET ${path}`).toBe(401);
    }
  });

  it("rejects MUTATIONS with a missing or wrong token — and the mutation does NOT happen", async () => {
    for (const m of mutations) {
      const missing = await app.request(m.path, form(m.fields));
      expect(missing.status, `missing token on POST ${m.path}`).toBe(401);
      const wrong = await app.request(`${m.path}?t=${TOKEN.slice(0, -2)}xx`, form(m.fields));
      expect(wrong.status, `wrong token on POST ${m.path}`).toBe(401);
    }
    // The gated decline/approve attempts above changed nothing:
    expect(store.get(pending.id)!.status).toBe("pending");
    expect(profile.list()).toHaveLength(0);
  });

  it("a token in the POST body cannot substitute for the URL token (no smuggling channel)", async () => {
    const res = await app.request(`/decline/${pending.id}`, form({ t: TOKEN }));
    expect(res.status).toBe(401);
    expect(store.get(pending.id)!.status).toBe("pending");
  });

  it("emits NO CORS headers — even for a cross-origin-looking request — and hardened local headers on every response", async () => {
    const res = await app.request(`/dashboard?t=${TOKEN}`, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(200);
    for (const h of [
      "access-control-allow-origin",
      "access-control-allow-methods",
      "access-control-allow-headers",
      "access-control-allow-credentials",
    ]) {
      expect(res.headers.get(h), h).toBeNull();
    }
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // Belt-and-suspenders for legacy browsers that don't honor CSP frame-ancestors.
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    // The 401 path is hardened too.
    const denied = await app.request(`/dashboard`, { headers: { origin: "https://evil.example" } });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(denied.headers.get("x-frame-options")).toBe("DENY");
  });
});

// ---------------------------------------------------------------------------
describe("mutation body-size limit — defense-in-depth against self-DoS", () => {
  it("rejects an oversized request body on every mutation route (still gated by the token check first)", async () => {
    const { app, store } = makeHarness();
    const pending = store.request(OFFER, { intent: "body limit test" }).authorization;
    const oversized = "x".repeat(200 * 1024); // well over the 64KB limit

    const routes = [
      `/profile/add`,
      `/approve/${pending.id}`,
      `/decline/${pending.id}`,
      `/watches/watch_x/cancel`,
    ];
    for (const path of routes) {
      const res = await app.request(`${path}?t=${TOKEN}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `code=${oversized}`,
      });
      expect(res.status, `oversized body on POST ${path}`).toBe(413);
    }

    // The token gate still runs before the body-limit check: a bad token on
    // an oversized body is still a uniform 401, not a 413.
    const gated = await app.request(`/profile/add?t=wrong-token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `flag=${oversized}`,
    });
    expect(gated.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe("approval page — the four-tuple, verbatim, plus the issuance fingerprint", () => {
  it("renders EVERY renderOrderTuple line unchanged, the fingerprint from the code file, the cap, and an equally prominent decline", async () => {
    const { app, store, configDir } = makeHarness();
    const { authorization } = store.request(OFFER, {
      intent: "Buy the Wool Runner Mizzle",
      maxAmount: { amount: 13000, currency: "USD" },
      paymentContext: "cart-permalink",
    });
    const codeFileBody = readFileSync(
      join(configDir, "pending-authorizations", `${authorization.id}.code`),
      "utf8",
    );
    const fingerprint = codeFileBody.match(/order-fingerprint ([0-9A-F]{4})/)![1]!;

    const res = await app.request(`/approve/${authorization.id}?t=${TOKEN}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    // The SAME renderer, verbatim — no second renderer to drift (esc() only
    // touches &<>"' — none appear in these fixture lines).
    for (const line of renderOrderTuple(authorization.offer, authorization.paymentContext)) {
      expect(html).toContain(line);
    }
    expect(html).toContain("Wool Runner Mizzle");
    expect(html).toContain("Allbirds (www.allbirds.com)");
    expect(html).toContain(`<span class="fingerprint">${fingerprint}</span>`);
    expect(html).toContain("130.00 USD"); // the hard cap
    expect(html).toContain("Buy the Wool Runner Mizzle"); // the intent
    // Approve and decline are both first-class buttons on the same page.
    expect(html).toContain("Approve — sign the mandate");
    expect(html).toContain("Decline — void this authorization");
    expect(html).toContain("Declining is always available");
    expect(html).toContain('<main class="card">');
    expect(html).toContain("<h1>Approve this purchase?</h1>");
    expect(html).toContain('aria-describedby="code-help fingerprint-help"');
    expect(html).toContain('autocomplete="off"');
    expect(html).not.toContain('autocomplete="one-time-code"');
    expect(html).toContain('<div class="code-field">');
    expect(html).toContain('form="approve-form"');
    expect(html).toContain('<div class="actions" aria-label="Authorization decision">');
    expect(html).toContain('.actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(html).toContain('@media (max-width: 480px)');
    expect(html).toContain('.actions { grid-template-columns: 1fr; }');
    expect(html.indexOf('id="code"')).toBeLessThan(html.indexOf('id="approve-form"'));
    expect(html.indexOf('id="approve-form"')).toBeLessThan(html.indexOf('class="decline"'));
    expect(html).toContain('@media (prefers-reduced-motion: reduce)');
    expect(html).toContain('min-height: 44px');
    // The page never shows the code (the human brings it FROM the trusted channel).
    expect(html).not.toContain(codeOnDisk(configDir, authorization.id));
  });

  it("a nonexistent authorization is a 404 page, and a decided one shows its status with no approve form", async () => {
    const { app, store, configDir } = makeHarness();
    const nope = await app.request(`/approve/auth_nope?t=${TOKEN}`);
    expect(nope.status).toBe(404);

    const { authorization } = store.request(OFFER, { intent: "already decided" });
    store.decline(authorization.id);
    const decided = await app.request(`/approve/${authorization.id}?t=${TOKEN}`);
    const html = await decided.text();
    expect(html).toContain("DENIED");
    expect(html).not.toContain("Approve — sign the mandate");
  });

  it("an expired authorization is a recovery state with no actionable approval form", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-ui-expired-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const audit = createAuditLog(configDir);
    const store = createAuthorizationStore({ keypair, configDir, quiet: true, ttlMs: -1 });
    const profile = createProfileStore({ configDir });
    const app = createLocalUiApp({ sessionToken: TOKEN, authorizations: store, audit, profile });
    const { authorization } = store.request(OFFER, { intent: "expired page" });

    const html = await (await app.request(`/approve/${authorization.id}?t=${TOKEN}`)).text();
    expect(html).toContain("Status: EXPIRED");
    expect(html).toContain("request a new purchase authorization");
    expect(html).not.toContain("Approve — sign the mandate");
    expect(html).not.toContain('name="code"');
  });

  it("no-rail case (checkout will be refused) is visually WARNED, not styled like a working purchase", async () => {
    const { app, store } = makeHarness();
    // No paymentContext given → store defaults to "none" (no automated
    // checkout rail configured for this merchant).
    const { authorization } = store.request(OFFER, { intent: "no rail configured" });
    expect(authorization.paymentContext).toBe("none");

    const res = await app.request(`/approve/${authorization.id}?t=${TOKEN}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    // The honest payment-context line is still there (four-tuple unchanged)…
    expect(html).toContain("no automated checkout rail is configured for this merchant — checkout will be refused");
    // …plus a caution band explaining that signing will NOT result in a purchase.
    expect(html).toContain("caution-band");
    expect(html).toContain("will NOT result in a purchase");
    // The confirm affordance is de-emphasized/relabeled, never the standard green CTA.
    expect(html).not.toContain("Approve — sign the mandate");
    expect(html).not.toContain(`<button class="approve" type="submit">`);
    expect(html).toContain("approve-muted");
    // Decline is still first-class and unaffected.
    expect(html).toContain("Decline — void this authorization");
    expect(html).toContain("Declining is always available");
  });
});

// ---------------------------------------------------------------------------
describe("the page door approves/declines through the SAME gate", () => {
  const auditFailureSentinel = "/home/alice/.config/northcinder/audit.jsonl apiKey=TOPSECRET";

  function failingAudit(configDir: string) {
    const audit = createAuditLog(configDir);
    return { ...audit, append(): never { throw new Error(auditFailureSentinel); } };
  }

  async function bodyWithoutAuditLeak(response: Response): Promise<string> {
    expect(response.status).toBe(500);
    const html = await response.text();
    expect(html).not.toContain("/home/alice");
    expect(html).not.toContain("TOPSECRET");
    expect(html).not.toContain(auditFailureSentinel);
    return html;
  }

  it("reports that a wrong-code attempt was consumed when its audit append fails", async () => {
    const base = makeHarness();
    const { authorization } = base.store.request(OFFER, { intent: "wrong-code audit failure" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = createLocalUiApp({
        sessionToken: TOKEN,
        authorizations: base.store,
        audit: failingAudit(base.configDir),
      });
      const html = await bodyWithoutAuditLeak(
        await app.request(`/approve/${authorization.id}?t=${TOKEN}`, form({ code: "WRONG-CODE" })),
      );
      expect(base.store.get(authorization.id)?.status).toBe("pending");
      expect(base.store.get(authorization.id)?.attemptsRemaining).toBe(2);
      expect(html).toContain("wrong confirmation code was rejected");
      expect(html).toContain("2 attempts remaining");
      expect(html).toContain("audit record could not be written");
      expect(html).toContain("attempt was already consumed");
      expect(html).toContain(`href="/approve/${authorization.id}?t=${TOKEN}"`);
      expect(html).toContain("Inspect authorization status");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not claim a wrong-code attempt for a non-code rejection whose audit append fails", async () => {
    const base = makeHarness();
    const { authorization } = base.store.request(OFFER, { intent: "already-final audit failure" });
    expect(base.store.decline(authorization.id).ok).toBe(true);
    const app = createLocalUiApp({
      sessionToken: TOKEN,
      authorizations: base.store,
      audit: failingAudit(base.configDir),
    });
    const html = await bodyWithoutAuditLeak(
      await app.request(`/approve/${authorization.id}?t=${TOKEN}`, form({ code: "NOT-USED" })),
    );
    expect(base.store.get(authorization.id)?.status).toBe("denied");
    expect(html).toContain("APPROVAL NOT GRANTED — AUDIT RECORD MISSING");
    expect(html).toContain("may already be final or unavailable");
    expect(html).toContain("Do not submit another code");
    expect(html).not.toContain("attempt was already consumed");
    expect(html).not.toContain("wrong confirmation code was rejected");
  });

  it("reports the live signed approval and prohibits retry when its audit append fails", async () => {
    const base = makeHarness();
    const { authorization } = base.store.request(OFFER, { intent: "approval audit failure" });
    const code = codeOnDisk(base.configDir, authorization.id);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = createLocalUiApp({
        sessionToken: TOKEN,
        authorizations: base.store,
        audit: failingAudit(base.configDir),
      });
      const html = await bodyWithoutAuditLeak(
        await app.request(`/approve/${authorization.id}?t=${TOKEN}`, form({ code })),
      );
      expect(base.store.get(authorization.id)?.status).toBe("approved");
      expect(base.store.get(authorization.id)?.mandate).toBeDefined();
      expect(html).toContain("APPROVED — AUDIT RECORD MISSING");
      expect(html).toContain("signed mandate is live");
      expect(html).toContain("approval audit record could not be written");
      expect(html).toContain("Do not submit this approval again");
      expect(html).toContain(`href="/approve/${authorization.id}?t=${TOKEN}"`);
      expect(html).toContain("Inspect final authorization status");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("reports the persisted decline and prohibits retry when its audit append fails", async () => {
    const base = makeHarness();
    const { authorization } = base.store.request(OFFER, { intent: "decline audit failure" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = createLocalUiApp({
        sessionToken: TOKEN,
        authorizations: base.store,
        audit: failingAudit(base.configDir),
      });
      const html = await bodyWithoutAuditLeak(
        await app.request(`/decline/${authorization.id}?t=${TOKEN}`, form({})),
      );
      expect(base.store.get(authorization.id)?.status).toBe("denied");
      expect(html).toContain("DECLINED — AUDIT RECORD MISSING");
      expect(html).toContain("decline is final");
      expect(html).toContain("decline audit record could not be written");
      expect(html).toContain("Do not submit this decline again");
      expect(html).toContain(`href="/approve/${authorization.id}?t=${TOKEN}"`);
      expect(html).toContain("Inspect final authorization status");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("POST /approve with the out-of-band code approves THE SAME authorization the code path would — mandate signed, audited as door=approval_page", async () => {
    const { app, store, configDir, auditPath } = makeHarness();
    const { authorization } = store.request(OFFER, { intent: "page approval" });
    const code = codeOnDisk(configDir, authorization.id);

    const res = await app.request(`/approve/${authorization.id}?t=${TOKEN}`, form({ code }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("APPROVED");
    expect(html).toContain("single-use mandate mandate_");

    const after = store.get(authorization.id)!;
    expect(after.status).toBe("approved");
    expect(after.mandate).toBeDefined();
    expect(after.mandate!.constraints.offerId).toBe(OFFER.id);

    const approvedLine = auditLines(auditPath).find((l) => l.type === "authorization_approved")!;
    expect(approvedLine.door).toBe("approval_page");
    expect(approvedLine.authorizationId).toBe(authorization.id);
    expect(approvedLine.mandateId).toMatch(/^mandate_/);
  });

  it("POST /approve with a wrong code burns an attempt through the same bounded counter and is audited as denied", async () => {
    const { app, store, configDir, auditPath } = makeHarness();
    const { authorization } = store.request(OFFER, { intent: "wrong code via page" });

    const res = await app.request(`/approve/${authorization.id}?t=${TOKEN}`, form({ code: "XXXX-XXXX" }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("wrong confirmation code");
    // The SAME attempt counter as the tool door — one shared gate.
    expect(store.get(authorization.id)!.attemptsRemaining).toBe(2);
    const deniedLine = auditLines(auditPath).find((l) => l.type === "authorization_denied")!;
    expect(deniedLine.door).toBe("approval_page");
    expect(deniedLine.reason).toBe("code_mismatch");
    // The real code still works afterwards.
    const code = codeOnDisk(configDir, authorization.id);
    const ok = await app.request(`/approve/${authorization.id}?t=${TOKEN}`, form({ code }));
    expect(ok.status).toBe(200);
  });

  it("POST /decline voids the pending authorization (audited, code dead afterwards)", async () => {
    const { app, store, configDir, auditPath } = makeHarness();
    const { authorization } = store.request(OFFER, { intent: "decline via page" });
    const code = codeOnDisk(configDir, authorization.id);

    const res = await app.request(`/decline/${authorization.id}?t=${TOKEN}`, form({}));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("DECLINED");
    expect(html).toContain("Nothing was purchased and nothing will be charged");

    expect(store.get(authorization.id)!.status).toBe("denied");
    // The voided authorization can never be approved — not even with the real code.
    const late = store.approve(authorization.id, code);
    expect(late.ok).toBe(false);
    const declinedLine = auditLines(auditPath).find((l) => l.type === "authorization_declined")!;
    expect(declinedLine.door).toBe("approval_page");
    expect(declinedLine.authorizationId).toBe(authorization.id);
  });

  it("double-approve via both doors is IMPOSSIBLE: page first → tool door refused; tool first → page door refused; exactly one mandate each", async () => {
    const { app, store, configDir, auditPath } = makeHarness();

    // Direction 1: approval PAGE first, tool door (store.approve) second.
    const a = store.request(OFFER, { intent: "both doors, page first" }).authorization;
    const codeA = codeOnDisk(configDir, a.id);
    const pageFirst = await app.request(`/approve/${a.id}?t=${TOKEN}`, form({ code: codeA }));
    expect(pageFirst.status).toBe(200);
    const mandateA = store.get(a.id)!.mandate!.id;
    const toolSecond = store.approve(a.id, codeA); // what approve_purchase calls
    expect(toolSecond.ok).toBe(false);
    if (!toolSecond.ok) expect(toolSecond.error.code).toBe("already_approved");
    expect(store.get(a.id)!.mandate!.id).toBe(mandateA); // no second mandate

    // Direction 2: TOOL door first, approval page second.
    const b = store.request(OFFER, { intent: "both doors, tool first" }).authorization;
    const codeB = codeOnDisk(configDir, b.id);
    const toolFirst = store.approve(b.id, codeB);
    expect(toolFirst.ok).toBe(true);
    const mandateB = store.get(b.id)!.mandate!.id;
    const pageSecond = await app.request(`/approve/${b.id}?t=${TOKEN}`, form({ code: codeB }));
    expect(pageSecond.status).toBe(400);
    expect(await pageSecond.text()).toContain("already approved");
    expect(store.get(b.id)!.mandate!.id).toBe(mandateB);

    // Exactly ONE authorization_approved audit line per authorization.
    const approvedLines = auditLines(auditPath).filter((l) => l.type === "authorization_approved");
    expect(approvedLines.filter((l) => l.authorizationId === a.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("dashboard — profile editor", () => {
  it("exposes dashboard landmarks, active navigation, table headers, labeled fields, and contextual controls", async () => {
    const { app, profile, configDir } = makeHarness();
    profile.add(
      { kind: "ethics", flag: "fair-trade" },
      { origin: "stated", source: "update_profile (user-stated via host agent)" },
    );

    const html = await (await app.request(`/dashboard?t=${TOKEN}&tab=profile`)).text();
    expect(html).toContain('<nav class="rail" aria-label="Dashboard sections">');
    expect(html).toContain('class="active" aria-current="page"');
    expect(html).toContain('<main class="main" id="main-content">');
    expect(html).toContain('<th scope="col">kind</th>');
    expect(html).toContain("<span>Category</span>");
    expect(html).toContain("<span>Maximum price</span>");
    expect(html).toContain("<span>Currency</span>");
    expect(html).toContain("<span>Brand</span>");
    expect(html).toContain("<span>Stance</span>");
    expect(html).toContain('aria-label="Delete ethics preference"');
    expect(html).toContain('aria-hidden="true" focusable="false"');
    expect(html).toContain('<td data-label="Kind">ethics</td>');
    expect(html).toContain('<td data-label="Action">');
    expect(html).toContain('@media (max-width: 520px)');
    expect(html).toContain('table.ledger tr:first-child { display: none; }');
    expect(html).toContain('.main { flex: 1; min-width: 0; width: 100%;');
    expect(html).not.toContain('max-width: 980px');
    expect(html).toContain("local state");
    expect(html).not.toContain(configDir);
  });

  it("renders stated and inferred entries in DISTINCT sections, exact content, each with a delete control", async () => {
    const { app, profile } = makeHarness();
    const stated = profile.add(
      { kind: "size", category: "sneakers", value: "EU 43" },
      { origin: "stated", source: "update_profile (user-stated via host agent)" },
    );
    const inferred = profile.add(
      { kind: "brand", brand: "Allbirds", stance: "allow" },
      { origin: "inferred", source: "record_feedback:more_like_this offer shopify:offer-ui-1" },
    );

    const res = await app.request(`/dashboard?t=${TOKEN}&tab=profile`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("STATED");
    expect(html).toContain("INFERRED");
    expect(html).toContain("category: sneakers, value: EU 43");
    expect(html).toContain("brand: Allbirds, stance: allow");
    expect(html).toContain("These were NOT stated by you");
    // Delete controls carry the exact entry ids.
    expect(html).toContain(`name="id" value="${stated.id}"`);
    expect(html).toContain(`name="id" value="${inferred.id}"`);
    // Attribution is shown — the arXiv:2602.01450 trust requirement.
    expect(html).toContain("record_feedback:more_like_this");
  });

  it("adds a STATED entry via the form (attributed to the dashboard) and deletes any entry by id — including inferred ones", async () => {
    const { app, profile, auditPath } = makeHarness();
    const add = await app.request(
      `/profile/add?t=${TOKEN}`,
      form({ kind: "budget", category: "sneakers", amount: "120.00", currency: "usd" }),
    );
    expect(add.status).toBe(303);
    const entries = profile.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "budget",
      category: "sneakers",
      maxPrice: { amount: 12000, currency: "USD" },
      origin: "stated",
      source: "dashboard (user-edited)",
    });
    const writeLine = auditLines(auditPath).find((l) => l.type === "profile_write")!;
    expect(writeLine.door).toBe("dashboard");

    const inferred = profile.add(
      { kind: "brand", brand: "SomeBrand", stance: "deny" },
      { origin: "inferred", source: "record_feedback:not_interested offer x:y" },
    );
    const del = await app.request(`/profile/delete?t=${TOKEN}`, form({ id: inferred.id }));
    expect(del.status).toBe(303);
    expect(profile.list().some((e) => e.id === inferred.id)).toBe(false);
    const deleteLine = auditLines(auditPath).find((l) => l.type === "profile_delete")!;
    expect(deleteLine.door).toBe("dashboard");
    // Attribution metadata only — the deleted VALUE is not retained in the audit line.
    expect(JSON.stringify(deleteLine)).not.toContain("SomeBrand");
  });

  it("rejects an invalid add (bad money) with a 400 and writes nothing", async () => {
    const { app, profile } = makeHarness();
    const res = await app.request(
      `/profile/add?t=${TOKEN}`,
      form({ kind: "budget", category: "sneakers", amount: "not-a-number", currency: "USD" }),
    );
    expect(res.status).toBe(400);
    expect(profile.list()).toHaveLength(0);
  });

  it("HTML-escapes stored values — a hostile profile value cannot inject markup", async () => {
    const { app, profile } = makeHarness();
    profile.add(
      { kind: "ethics", flag: `<script>alert(1)</script>` },
      { origin: "stated", source: "update_profile (user-stated via host agent)" },
    );
    const html = await (await app.request(`/dashboard?t=${TOKEN}&tab=profile`)).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

// ---------------------------------------------------------------------------
describe("dashboard — watches, audit browser, orders", () => {
  it("lists watches with exact content (state, name, target, channel TYPE only) and cancels via POST", async () => {
    const { app, watches, auditPath } = makeHarness();
    const watch = watches.create({
      name: "Mizzle under 90",
      target: { kind: "offer", offer: OFFER },
      targetPrice: { amount: 9000, currency: "USD" },
      channel: { type: "ntfy", topic: "super-secret-topic-xyz12345" },
    });

    const html = await (await app.request(`/dashboard?t=${TOKEN}&tab=watches`)).text();
    expect(html).toContain("ACTIVE");
    expect(html).toContain("Mizzle under 90");
    expect(html).toContain("Wool Runner Mizzle at Allbirds");
    expect(html).toContain("≤ 90.00 USD");
    expect(html).toContain('<td data-label="Channel">ntfy</td>'); // the channel TYPE…
    expect(html).not.toContain("super-secret-topic-xyz12345"); // …NEVER the bearer-secret topic
    expect(html).toContain("they never buy");

    const cancel = await app.request(`/watches/${watch.id}/cancel?t=${TOKEN}`, form({}));
    expect(cancel.status).toBe(303);
    expect(watches.get(watch.id)!.state).toBe("cancelled");
    const line = auditLines(auditPath).find((l) => l.type === "watch_cancelled")!;
    expect(line.door).toBe("dashboard");
    const after = await (await app.request(`/dashboard?t=${TOKEN}&tab=watches`)).text();
    expect(after).toContain("CANCELLED");
    expect(after).not.toContain(`/watches/${watch.id}/cancel`); // no cancel control on a voided watch
  });

  it("audit browser is paged (newest first) and read-only — page 2 reachable, file untouched", async () => {
    const { app, auditPath, configDir } = makeHarness();
    const audit = createAuditLog(configDir);
    for (let i = 1; i <= 55; i += 1) audit.append({ type: "search", seq: i, searchId: `search_${i}` });
    const before = readFileSync(auditPath, "utf8");

    const page1 = await (await app.request(`/dashboard?t=${TOKEN}&tab=audit`)).text();
    expect(page1).toContain("search_55"); // newest first
    expect(page1).toContain("page 1 of 2 (55 entries, newest first)");
    expect(page1).not.toContain("search_3&quot;"); // oldest entries are on page 2

    const page2 = await (await app.request(`/dashboard?t=${TOKEN}&tab=audit&page=2`)).text();
    expect(page2).toContain("search_1");
    expect(page2).toContain("page 2 of 2");
    expect(readFileSync(auditPath, "utf8")).toBe(before); // read-only browser
  });

  it("orders tab renders persisted order records with exact content", async () => {
    const { app, orders } = makeHarness();
    orders.append({
      orderId: "order_dash_1",
      createdAt: "2026-07-04T12:00:00.000Z",
      offerId: OFFER.id,
      merchantId: OFFER.merchant.id,
      railId: "acp",
      status: "completed",
      mandateId: "mandate_dash_1",
      mandate: {} as never,
      evidence: { rail: "acp", orderId: "ord_m_1", totalCharged: { amount: 11500, currency: "USD" } } as never,
    });
    const html = await (await app.request(`/dashboard?t=${TOKEN}&tab=orders`)).text();
    expect(html).toContain("order_dash_1");
    expect(html).toContain("completed");
    expect(html).toContain("acp");
    expect(html).toContain("www.allbirds.com");
    expect(html).toContain("mandate_dash_1");
    expect(html).toContain("2026-07-04T12:00:00.000Z");
  });

  it("orders tab renders a MERGED email-derived order (shipment status + return deadline), every field escaped", async () => {
    const { configDir } = makeHarness();
    const orderGraph = createOrderGraphStore(configDir);
    // A hostile merchantName injected directly (bypassing the email regex
    // path entirely) — proves the DASHBOARD escapes it, not just the parser.
    orderGraph.importOrder({ merchantName: "<script>alert(1)</script>", orderDate: "2026-01-01T00:00:00.000Z" });
    const raw = [
      'From: "Aurora Outfitters" <no-reply@shop-aurora.myshopify.com>',
      "Subject: Order confirmation #1021 for Buyer Example",
      "Date: Wed, 1 Jul 2026 10:15:00 -0700",
      "Message-ID: <shopify-1021-confirmation@shop-aurora.myshopify.com>",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "Order #1021",
      "Placed on July 1, 2026",
      "",
      "1 x Cedar Trail Jacket - $128.00",
      "",
      "Total: $128.00",
      "",
    ].join("\n");
    orderGraph.ingestEml(raw, "drop_dir");
    orderGraph.ingestEml(
      [
        'From: "Aurora Outfitters" <shipment-tracking@shop-aurora.myshopify.com>',
        "Subject: Your order has shipped",
        "Date: Thu, 2 Jul 2026 14:00:00 -0700",
        "Message-ID: <shopify-1021-shipped@shop-aurora.myshopify.com>",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "Order #1021 (tracking 1Z999AA10123456784) has shipped via UPS.",
        "",
      ].join("\n"),
      "drop_dir",
    );
    orderGraph.ingestEml(
      [
        'From: "Aurora Outfitters" <no-reply@shop-aurora.myshopify.com>',
        "Subject: Your return window for order #1021",
        "Date: Sun, 5 Jul 2026 15:30:00 -0700",
        "Message-ID: <shopify-1021-return-window@shop-aurora.myshopify.com>",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "Order #1021 -- you can return items until August 4, 2026 (30 days from delivery on July 5, 2026).",
        "",
      ].join("\n"),
      "drop_dir",
    );

    const appWithGraph = createLocalUiApp({
      sessionToken: TOKEN,
      authorizations: createAuthorizationStore({
        keypair: loadOrCreateMandateKeypair({ configDir }),
        configDir,
        quiet: true,
      }),
      audit: createAuditLog(configDir),
      orderGraph,
    });

    const html = await (await appWithGraph.request(`/dashboard?t=${TOKEN}&tab=orders`)).text();
    expect(html).toContain("Orders from email");
    expect(html).toContain("1021");
    // The malicious merchant name (from a plain import_order, no email
    // regex involved) is HTML-escaped, never raw markup.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // Shipment status and return deadline are both surfaced.
    expect(html).toContain("UPS in_transit");
    expect(html).toContain("2026-08-04");
  });

  it("orders tab renders a branded error (no raw 500) when the order store throws on a malformed legacy record", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-ui-orders-throw-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const audit = createAuditLog(configDir);
    const store = createAuthorizationStore({ keypair, configDir, quiet: true });
    const brokenOrders = {
      append() {
        throw new Error("should not be called");
      },
      list(): never {
        // Simulates the real failure mode: a malformed legacy OrderRecord.mandate
        // (packages/orders/src/store.ts:153-164) blowing up the reader — a plain
        // TypeError, not a filesystem error, so no path is ever in play here.
        throw new TypeError("Cannot read properties of undefined (reading 'constraints')");
      },
    };
    const app = createLocalUiApp({ sessionToken: TOKEN, authorizations: store, audit, orders: brokenOrders });

    const res = await app.request(`/dashboard?t=${TOKEN}&tab=orders`);
    // Branded, handled response — never Hono's bare unbranded 500.
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="error"');
    expect(html).not.toBe("Internal Server Error");
    expect(html).toContain(BRAND_NAME);
  });

  it("never exposes dependency exception text and gives same-tab recovery for every dashboard read boundary", async () => {
    const sentinel = "/home/alice/.config/northcinder/private.json apiKey=TOPSECRET";
    const base = makeHarness();
    const orderGraph = createOrderGraphStore(base.configDir);
    const cases = [
      {
        tab: "profile",
        marker: "Profile data could not be read safely",
        deps: { profile: { ...base.profile, list(): never { throw new Error(sentinel); } } },
      },
      {
        tab: "watches",
        marker: "Watch data could not be read safely",
        deps: { watches: { ...base.watches, list(): never { throw new Error(sentinel); } } },
      },
      {
        tab: "orders",
        marker: "Order data could not be read safely",
        deps: { orders: { ...base.orders, list(): never { throw new Error(sentinel); } } },
      },
      {
        tab: "orders",
        marker: "Order data could not be read safely",
        deps: { orderGraph: { ...orderGraph, listOrders(): never { throw new Error(sentinel); } } },
      },
      {
        tab: "audit",
        marker: "Audit data could not be read safely",
        deps: { readAuditPage: (): never => { throw new Error(sentinel); } },
      },
    ] as const;

    for (const item of cases) {
      const app = createLocalUiApp({
        sessionToken: TOKEN,
        authorizations: base.store,
        audit: createAuditLog(base.configDir),
        ...item.deps,
      } as never);
      const html = await (await app.request(`/dashboard?t=${TOKEN}&tab=${item.tab}`)).text();
      expect(html, item.tab).toContain(item.marker);
      expect(html, item.tab).toContain(`href="/dashboard?t=${TOKEN}&amp;tab=${item.tab}"`);
      expect(html, item.tab).toContain("rerun the source initializer");
      expect(html, item.tab).not.toContain("/home/alice");
      expect(html, item.tab).not.toContain("TOPSECRET");
      expect(html, item.tab).not.toContain(sentinel);
    }
  });

  it("never exposes dependency exception text and gives same-tab recovery for every dashboard write boundary", async () => {
    const sentinel = "/home/alice/.config/northcinder/private.json apiKey=TOPSECRET";
    const assertSafe = async (response: Response, tab: "profile" | "watches", marker: string) => {
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain(marker);
      expect(html).toContain(`href="/dashboard?t=${TOKEN}&amp;tab=${tab}"`);
      expect(html).toContain("rerun the source initializer");
      expect(html).not.toContain("/home/alice");
      expect(html).not.toContain("TOPSECRET");
    };

    {
      const base = makeHarness();
      const app = createLocalUiApp({
        sessionToken: TOKEN,
        authorizations: base.store,
        audit: createAuditLog(base.configDir),
        profile: { ...base.profile, add(): never { throw new Error(sentinel); } },
      });
      await assertSafe(
        await app.request(`/profile/add?t=${TOKEN}`, form({ kind: "ethics", flag: "fair-trade" })),
        "profile",
        "Profile change could not be saved safely",
      );
    }
    {
      const base = makeHarness();
      const app = createLocalUiApp({
        sessionToken: TOKEN,
        authorizations: base.store,
        audit: createAuditLog(base.configDir),
        profile: { ...base.profile, remove(): never { throw new Error(sentinel); } },
      });
      await assertSafe(
        await app.request(`/profile/delete?t=${TOKEN}`, form({ id: "pref_fixture" })),
        "profile",
        "Profile change could not be saved safely",
      );
    }
    {
      const base = makeHarness();
      const app = createLocalUiApp({
        sessionToken: TOKEN,
        authorizations: base.store,
        audit: createAuditLog(base.configDir),
        watches: { ...base.watches, cancel(): never { throw new Error(sentinel); } },
      });
      await assertSafe(
        await app.request(`/watches/watch_fixture/cancel?t=${TOKEN}`, form({})),
        "watches",
        "Watch change could not be saved safely",
      );
    }
  });

  it("warns that state may have changed when a post-mutation audit write fails, without leaking the exception", async () => {
    const sentinel = "/home/alice/.config/northcinder/audit.jsonl apiKey=TOPSECRET";
    const failingAudit = (configDir: string) => {
      const audit = createAuditLog(configDir);
      return { ...audit, append(): never { throw new Error(sentinel); } };
    };
    const assertUncertain = async (response: Response, tab: "profile" | "watches", label: "Profile" | "Watches") => {
      expect(response.status).toBe(500);
      const html = await response.text();
      expect(html).toContain("may have changed, but its audit record could not be written");
      expect(html).toContain(`href="/dashboard?t=${TOKEN}&amp;tab=${tab}"`);
      expect(html).toContain(`Refresh ${label} before trying again`);
      expect(html).not.toContain("/home/alice");
      expect(html).not.toContain("TOPSECRET");
    };

    {
      const base = makeHarness();
      const app = createLocalUiApp({ sessionToken: TOKEN, authorizations: base.store, audit: failingAudit(base.configDir), profile: base.profile });
      await assertUncertain(
        await app.request(`/profile/add?t=${TOKEN}`, form({ kind: "ethics", flag: "fair-trade" })),
        "profile",
        "Profile",
      );
      expect(base.profile.list()).toHaveLength(1);
    }
    {
      const base = makeHarness();
      const entry = base.profile.add({ kind: "ethics", flag: "fair-trade" }, { origin: "stated", source: "fixture" });
      const app = createLocalUiApp({ sessionToken: TOKEN, authorizations: base.store, audit: failingAudit(base.configDir), profile: base.profile });
      await assertUncertain(
        await app.request(`/profile/delete?t=${TOKEN}`, form({ id: entry.id })),
        "profile",
        "Profile",
      );
      expect(base.profile.list()).toHaveLength(0);
    }
    {
      const base = makeHarness();
      const watch = base.watches.create({
        name: "Fixture watch",
        target: { kind: "offer", offer: OFFER },
        targetPrice: { amount: 9000, currency: "USD" },
        channel: { type: "ntfy", topic: "fixture-topic" },
      });
      const app = createLocalUiApp({ sessionToken: TOKEN, authorizations: base.store, audit: failingAudit(base.configDir), watches: base.watches });
      await assertUncertain(
        await app.request(`/watches/${watch.id}/cancel?t=${TOKEN}`, form({})),
        "watches",
        "Watches",
      );
      expect(base.watches.get(watch.id)?.state).toBe("cancelled");
    }
  });

  it("empty states are honest, and all four tabs answer 200", async () => {
    const { app } = makeHarness();
    for (const [tab, marker] of [
      ["profile", "STATED"],
      ["watches", "No price watches yet"],
      ["audit", "the audit trail is empty"],
      ["orders", "No orders yet"],
    ] as const) {
      const res = await app.request(`/dashboard?t=${TOKEN}&tab=${tab}`);
      expect(res.status, tab).toBe(200);
      expect(await res.text()).toContain(marker);
    }
  });
});

// ---------------------------------------------------------------------------
describe("leak contract over the REAL MCP boundary (extends the approval leak tests)", () => {
  it("tool results contain NEITHER the session token NOR the approval URL — while both ride the out-of-band code file", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "northcinder-ui-leak-"));
    const keypair = loadOrCreateMandateKeypair({ configDir });
    const audit = createAuditLog(configDir);
    const sessionToken = generateSessionToken();
    const uiOrigin = "http://127.0.0.1:49999";
    const store = createAuthorizationStore({
      keypair,
      configDir,
      quiet: true,
      approvalUrl: (id) => `${uiOrigin}/approve/${id}?t=${sessionToken}`,
    });
    const service: NorthCinderServiceClient = {
      async search(query) {
        const trustSignals = {
          [OFFER.merchant.id]: {
            merchantId: OFFER.merchant.id,
            level: "unknown" as const,
            evidence: [{ source: "seed-list", detail: "merchant not in the seed trust list" }],
          },
        };
        return {
          ok: true,
          data: {
            trustSignals,
            results: rankOffers([OFFER], query, { trust: trustSignals }),
            storeStatuses: [{ store: "shopify", ok: true, offerCount: 1, durationMs: 5 }],
          } as SearchRankResponse,
        };
      },
      async trust() {
        throw new Error("unused");
      },
    };
    const server = createNorthCinderMcpServer({ service, authorizations: store, checkout: { completeCheckout: async () => { throw new Error("unused"); } }, audit });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "leak-test-host", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

    await mcp.callTool({ name: "search_products", arguments: { text: "sneaker" } });
    const requested = await mcp.callTool({
      name: "request_purchase_authorization",
      arguments: { offerId: OFFER.id, intent: "leak check" },
    });
    expect(requested.isError ?? false).toBe(false);
    const { authorizationId } = requested.structuredContent as { authorizationId: string };

    // Out-of-band channel: the code file DOES carry the URL + token…
    const codeFileBody = readFileSync(join(configDir, "pending-authorizations", `${authorizationId}.code`), "utf8");
    expect(codeFileBody).toContain(`${uiOrigin}/approve/${authorizationId}?t=${sessionToken}`);

    // …and the AGENT-VISIBLE tool result carries none of it.
    const wire = JSON.stringify(requested);
    expect(wire).not.toContain(sessionToken);
    expect(wire).not.toContain(uiOrigin);
    expect(wire).not.toContain("/approve/");
    expect(wire).not.toContain("?t=");
  });
});

// ---------------------------------------------------------------------------
describe("startLocalUi + approval push composition", () => {
  it("binds to 127.0.0.1 on an ephemeral port and serves the token-gated dashboard over real HTTP", async () => {
    const harness = makeHarness();
    const ui = await startLocalUi(
      {
        sessionToken: TOKEN,
        authorizations: harness.store,
        audit: createAuditLog(harness.configDir),
        profile: harness.profile,
        watches: harness.watches,
        orders: harness.orders,
      },
      { port: 0 },
    );
    try {
      expect(ui.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const denied = await fetch(`${ui.origin}/dashboard`);
      expect(denied.status).toBe(401);
      const ok = await fetch(`${ui.origin}/dashboard?t=${TOKEN}`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain("loopback-only");
    } finally {
      ui.close();
    }
  });

  it("composeApprovalPush carries the approval URL + fingerprint and NEVER claims to carry the code", () => {
    const push = composeApprovalPush({
      authorizationId: "auth_push_1",
      fingerprint: "AB12",
      intent: "Buy the Wool Runner Mizzle",
      expiresAt: "2026-07-04T13:00:00.000Z",
      approvalUrl: "http://127.0.0.1:5555/approve/auth_push_1?t=tok",
    });
    expect(push.title).toContain("purchase approval requested");
    expect(push.body).toContain("Order fingerprint AB12");
    expect(push.body).toContain("http://127.0.0.1:5555/approve/auth_push_1?t=tok");
    expect(push.clickUrl).toBe("http://127.0.0.1:5555/approve/auth_push_1?t=tok");
    expect(push.body).toContain("never in this push");
  });
});
