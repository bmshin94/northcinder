/**
 * IMAP poll path is env-gated (acceptance criterion): missing credentials
 * yield a structured `not_configured` result — NEVER a fake success.
 */
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOrderGraphStore } from "../src/store.js";
import { loadImapConfigFromEnv, pollImap, type ImapTransport } from "../src/ingest/imap.js";

function tmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "northcinder-orders-imap-"));
}

function providerAuthenticated(uid: string, raw: string) {
  return {
    messages: [{ uid, raw }],
    providerAuthentication: [{ uid, rawSha256: createHash("sha256").update(raw).digest("hex"), status: "pass" as const }],
  };
}

describe("IMAP poll — env-gated, never a fake success", () => {
  it("loadImapConfigFromEnv returns undefined when host/user/secret are absent", () => {
    expect(loadImapConfigFromEnv({})).toBeUndefined();
    expect(loadImapConfigFromEnv({ NORTHCINDER_ORDERS_IMAP_HOST: "imap.example.com" })).toBeUndefined();
    expect(
      loadImapConfigFromEnv({ NORTHCINDER_ORDERS_IMAP_HOST: "imap.example.com", NORTHCINDER_ORDERS_IMAP_USER: "jordan" }),
    ).toBeUndefined();
  });

  it("loadImapConfigFromEnv accepts a password OR a token", () => {
    const withPassword = loadImapConfigFromEnv({
      NORTHCINDER_ORDERS_IMAP_HOST: "imap.example.com",
      NORTHCINDER_ORDERS_IMAP_USER: "jordan",
      NORTHCINDER_ORDERS_IMAP_PASSWORD: "hunter2",
    });
    expect(withPassword).toEqual({
      host: "imap.example.com",
      user: "jordan",
      password: "hunter2",
      port: 993,
      mailbox: "INBOX",
      tls: true,
      timeoutMs: 20_000,
      maxMessages: 100,
      maxMessageBytes: 1_048_576,
      maxTotalBytes: 10_485_760,
      maxResponseBytes: 12_582_912,
    });
    const withToken = loadImapConfigFromEnv({
      NORTHCINDER_ORDERS_IMAP_HOST: "imap.example.com",
      NORTHCINDER_ORDERS_IMAP_USER: "jordan",
      NORTHCINDER_ORDERS_IMAP_TOKEN: "oauth-token-xyz",
    });
    expect(withToken?.password).toBe("oauth-token-xyz");
  });

  it("pollImap returns structured not_configured (never a fake success) when NORTHCINDER_ORDERS_IMAP_* is unset", async () => {
    const store = createOrderGraphStore(tmpConfigDir());
    const result = await pollImap(store, { env: {} });
    expect(result).toEqual({
      ok: false,
      error: { code: "not_configured", message: "IMAP is not configured (set NORTHCINDER_ORDERS_IMAP_HOST/USER/PASSWORD)" },
    });
  });

  it("pollImap ingests only a message whose separately trusted provider metadata is bound to its UID and bytes", async () => {
    const store = createOrderGraphStore(tmpConfigDir());
    const raw = [
      'From: "Aurora Outfitters" <no-reply@shop-aurora.myshopify.com>',
      "Subject: Order confirmation #9001 for Buyer Example",
      "Date: Wed, 1 Jul 2026 10:15:00 -0700",
      "Message-ID: <shopify-9001@shop-aurora.myshopify.com>",
      "Authentication-Results: mx.example; dkim=pass header.d=shop-aurora.myshopify.com",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "Order #9001",
      "Placed on July 1, 2026",
      "Total: $10.00",
      "",
    ].join("\n");
    const transport: ImapTransport = { fetchUnseen: async () => providerAuthenticated("9001", raw) };
    const result = await pollImap(store, {
      env: { NORTHCINDER_ORDERS_IMAP_HOST: "imap.example.com", NORTHCINDER_ORDERS_IMAP_USER: "jordan", NORTHCINDER_ORDERS_IMAP_PASSWORD: "hunter2" },
      transport,
    });
    expect(result).toEqual({ ok: true, ingested: 1 });
    expect(store.listOrders().map((o) => o.orderNumber)).toEqual(["9001"]);
  });

  it("refuses unauthenticated unattended IMAP mail before it can reach trusted order state", async () => {
    const store = createOrderGraphStore(tmpConfigDir());
    const raw = ["From: <no-reply@example.com>", "Subject: Order #9002", "Message-ID: <unauth@example.com>", "", "Order #9002"].join("\n");
    const result = await pollImap(store, { env: { NORTHCINDER_ORDERS_IMAP_HOST: "imap.example.com", NORTHCINDER_ORDERS_IMAP_USER: "jordan", NORTHCINDER_ORDERS_IMAP_PASSWORD: "hunter2" }, transport: { fetchUnseen: async () => ({ messages: [{ uid: "9002", raw }] }) } });
    expect(result).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(store.listOrders()).toEqual([]);
  });

  it("does not ingest a matching forged Authentication-Results header without separate trusted provider metadata", async () => {
    const store = createOrderGraphStore(tmpConfigDir());
    const raw = ["Authentication-Results: configured; dkim=pass header.d=shop-aurora.myshopify.com", "From: <no-reply@example.com>", "Subject: Order #9003", "Message-ID: <forged@example.com>", "", "Order #9003"].join("\n");
    const result = await pollImap(store, { env: { NORTHCINDER_ORDERS_IMAP_HOST: "imap.example.com", NORTHCINDER_ORDERS_IMAP_USER: "jordan", NORTHCINDER_ORDERS_IMAP_PASSWORD: "hunter2" }, transport: { fetchUnseen: async () => ({ messages: [{ uid: "9003", raw }] }) } });
    expect(result).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(store.listOrders()).toEqual([]);
  });

  it("rejects an over-limit IMAP batch before it ingests any message", async () => {
    const store = createOrderGraphStore(tmpConfigDir());
    const raw = ["From: <no-reply@example.com>", "Subject: Order #9004", "Message-ID: <limit@example.com>", "", "Order #9004"].join("\n");
    const messages = Array.from({ length: 101 }, (_, index) => ({ uid: String(index + 1), raw }));
    const result = await pollImap(store, {
      env: { NORTHCINDER_ORDERS_IMAP_HOST: "imap.example.com", NORTHCINDER_ORDERS_IMAP_USER: "jordan", NORTHCINDER_ORDERS_IMAP_PASSWORD: "hunter2" },
      transport: { fetchUnseen: async () => ({ messages }) },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "message_limit_exceeded" } });
    expect(store.listOrders()).toEqual([]);
  });

  it("rejects over-limit per-message and aggregate raw bytes before partial ingest", async () => {
    const env = { NORTHCINDER_ORDERS_IMAP_HOST: "imap.example.com", NORTHCINDER_ORDERS_IMAP_USER: "jordan", NORTHCINDER_ORDERS_IMAP_PASSWORD: "hunter2" };
    const overMessageLimit = await pollImap(createOrderGraphStore(tmpConfigDir()), {
      env,
      transport: { fetchUnseen: async () => ({ messages: [{ uid: "large", raw: "x".repeat(1_048_577) }] }) },
    });
    expect(overMessageLimit).toMatchObject({ ok: false, error: { code: "message_limit_exceeded" } });

    const store = createOrderGraphStore(tmpConfigDir());
    const raw = "x".repeat(1_048_576);
    const overTotalLimit = await pollImap(store, {
      env,
      transport: { fetchUnseen: async () => ({ messages: Array.from({ length: 11 }, (_, index) => ({ uid: String(index), raw })) }) },
    });
    expect(overTotalLimit).toMatchObject({ ok: false, error: { code: "message_limit_exceeded" } });
    expect(store.listOrders()).toEqual([]);
  });

  it("actively aborts a hung IMAP transport when its timeout expires", async () => {
    const store = createOrderGraphStore(tmpConfigDir());
    let observedAbort = false;
    const result = await pollImap(store, {
      env: {
        NORTHCINDER_ORDERS_IMAP_HOST: "imap.example.com",
        NORTHCINDER_ORDERS_IMAP_USER: "jordan",
        NORTHCINDER_ORDERS_IMAP_PASSWORD: "hunter2",
        NORTHCINDER_ORDERS_IMAP_TIMEOUT_MS: "5",
      },
      transport: {
        fetchUnseen: async (_config, signal) => new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            reject(new Error("transport observed abort"));
          }, { once: true });
        }),
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(observedAbort).toBe(true);
  });

  it("pollImap never echoes host/user/password in a transport failure's error text (leak discipline)", async () => {
    const store = createOrderGraphStore(tmpConfigDir());
    const transport: ImapTransport = {
      fetchUnseen: async () => {
        throw Object.assign(new Error("ECONNREFUSED imap.example.com:993 user=jordan pass=hunter2"), { code: "ECONNREFUSED" });
      },
    };
    const result = await pollImap(store, {
      env: { NORTHCINDER_ORDERS_IMAP_HOST: "imap.example.com", NORTHCINDER_ORDERS_IMAP_USER: "jordan", NORTHCINDER_ORDERS_IMAP_PASSWORD: "hunter2" },
      transport,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).not.toContain("hunter2");
    expect(result.error.message).not.toContain("jordan");
    expect(result.error.code).toBe("connection_failed");
  });

});
