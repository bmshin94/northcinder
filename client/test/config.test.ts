import { describe, expect, it } from "vitest";
import { canonicalizeClientEnv, loadClientConfig } from "../src/config.js";

const BASE = {
  NORTHCINDER_SERVICE_URL: "http://127.0.0.1:8790",
  NORTHCINDER_CLIENT_KEY: "config-test-key-0123456789",
  NORTHCINDER_CONFIG_DIR: "/tmp/northcinder-config-test",
  HOME: "/tmp/northcinder-config-test-home",
};

describe("client config — local UI local UI settings", () => {
  it("accepts explicit local loopback configuration without a client key", () => {
    const config = loadClientConfig({
      ...BASE,
      NORTHCINDER_MODE: "local",
      NORTHCINDER_CLIENT_KEY: undefined,
    });

    expect(config.mode).toBe("local");
    expect(config.serviceUrl).toBe("http://127.0.0.1:8790");
    expect(config.clientKey).toBeUndefined();
  });

  it("requires a sufficiently long client key for explicit self-hosted mode", () => {
    expect(() => loadClientConfig({
      ...BASE,
      NORTHCINDER_MODE: "self-hosted",
      NORTHCINDER_CLIENT_KEY: undefined,
    })).toThrow(/NORTHCINDER_CLIENT_KEY/);
    expect(() => loadClientConfig({
      ...BASE,
      NORTHCINDER_MODE: "self-hosted",
      NORTHCINDER_CLIENT_KEY: "short",
    })).toThrow(/NORTHCINDER_CLIENT_KEY/);
  });

  it("requires HTTPS for bearer-authenticated engines except explicit loopback HTTP", () => {
    expect(() => loadClientConfig({
      ...BASE,
      NORTHCINDER_MODE: "self-hosted",
      NORTHCINDER_SERVICE_URL: "http://engine.example",
    })).toThrow(/HTTPS|loopback/i);
    expect(() => loadClientConfig({
      ...BASE,
      NORTHCINDER_MODE: "self-hosted",
      NORTHCINDER_SERVICE_URL: "http://127.evil.example",
    })).toThrow(/HTTPS|loopback/i);
    expect(() => loadClientConfig({
      ...BASE,
      NORTHCINDER_MODE: "self-hosted",
      NORTHCINDER_SERVICE_URL: "http://localhost:8790",
    })).not.toThrow();
    expect(() => loadClientConfig({
      ...BASE,
      NORTHCINDER_MODE: "self-hosted",
      NORTHCINDER_SERVICE_URL: "https://engine.example/base",
    })).not.toThrow();
    for (const serviceUrl of [
      "https://user:secret@engine.example",
      "https://engine.example?other=1",
      "https://engine.example#other",
    ]) {
      expect(() => loadClientConfig({
        ...BASE,
        NORTHCINDER_MODE: "self-hosted",
        NORTHCINDER_SERVICE_URL: serviceUrl,
      })).toThrow(/URL|credentials|query|fragment/i);
    }
  });

  it("requires every ACP entry to name its merchant domain and use a secure base URL", () => {
    const withMerchants = (value: unknown) => loadClientConfig({
      ...BASE,
      NORTHCINDER_ACP_MERCHANTS: JSON.stringify(value),
    });
    expect(() => withMerchants({
      "merchant.example": {
        baseUrl: "https://checkout.merchant.example/acp",
        merchantDomain: "merchant.example",
        apiKey: "secret",
      },
    })).not.toThrow();
    expect(() => withMerchants({
      "merchant.example": { baseUrl: "https://checkout.merchant.example", apiKey: "secret" },
    })).toThrow(/merchantDomain|malformed/i);
    expect(() => withMerchants({
      "merchant.example": {
        baseUrl: "https://checkout.merchant.example",
        merchantDomain: "*.example.com",
        apiKey: "secret",
      },
    })).toThrow(/merchantDomain|malformed/i);
    for (const baseUrl of [
      "http://checkout.merchant.example",
      "https://user:secret@checkout.merchant.example",
      "https://checkout.merchant.example?other=1",
      "https://checkout.merchant.example#other",
    ]) {
      expect(() => withMerchants({
        "merchant.example": { baseUrl, merchantDomain: "merchant.example", apiKey: "secret" },
      })).toThrow(/malformed|HTTPS|credentials|query|fragment/i);
    }
  });

  it("accepts a compatibility key for explicit local mode", () => {
    const config = loadClientConfig({ ...BASE, NORTHCINDER_MODE: "local" });
    expect(config.clientKey).toBe("config-test-key-0123456789");
  });

  it("requires an explicit valid mode unless legacy URL and key inputs select self-hosted", () => {
    expect(loadClientConfig(BASE).mode).toBe("self-hosted");
    expect(() => loadClientConfig({ ...BASE, NORTHCINDER_CLIENT_KEY: undefined })).toThrow(/NORTHCINDER_MODE/);
    expect(() => loadClientConfig({ ...BASE, NORTHCINDER_MODE: "remote" })).toThrow(/NORTHCINDER_MODE/);
    expect(() => loadClientConfig({ ...BASE, NORTHCINDER_MODE: "local", NORTHCINDER_SERVICE_URL: "https://engine.example" })).toThrow(/loopback/);
  });

  it("uses canonical values ahead of legacy aliases and redacts its one warning", () => {
    const messages: string[] = [];
    const env = canonicalizeClientEnv({
      EMPTOR_CLIENT_KEY: "oldest-secret-value",
      THENAGAIN_CLIENT_KEY: "earlier-secret-value",
      BRIER_CLIENT_KEY: "previous-secret-value",
      NORTHCINDER_CLIENT_KEY: "canonical-value",
    }, (m) => messages.push(m));
    expect(env.NORTHCINDER_CLIENT_KEY).toBe("canonical-value");
    expect(messages.join("\n")).not.toContain("oldest-secret-value");
    expect(messages.join("\n")).not.toContain("previous-secret-value");
  });

  it("prefers the immediately previous alias over older aliases", () => {
    const env = canonicalizeClientEnv({
      EMPTOR_CLIENT_KEY: "oldest-value",
      THENAGAIN_CLIENT_KEY: "earlier-value",
      BRIER_CLIENT_KEY: "previous-value",
    }, () => {});
    expect(env.NORTHCINDER_CLIENT_KEY).toBe("previous-value");
  });
  it("defaults: UI enabled on an ephemeral port, no ntfy push channel", () => {
    const config = loadClientConfig(BASE);
    expect(config.ui).toEqual({ enabled: true, port: 0 });
  });

  it("keeps unauthenticated local mail-drop ingestion disabled unless explicitly opted in", () => {
    expect(loadClientConfig(BASE).ordersMailDropDir).toBeUndefined();
    expect(loadClientConfig({ ...BASE, NORTHCINDER_ORDERS_MAIL_DROP_DIR: "/custom/drop" }).ordersMailDropDir).toBeUndefined();
    expect(loadClientConfig({ ...BASE, NORTHCINDER_ORDERS_ALLOW_LOCAL_UNAUTHENTICATED: "1" }).ordersMailDropDir).toBe("/tmp/northcinder-config-test/mail-drop");
  });

  it("NORTHCINDER_UI=0/false disables the UI; a fixed port and ntfy settings are honored", () => {
    expect(loadClientConfig({ ...BASE, NORTHCINDER_UI: "0" }).ui.enabled).toBe(false);
    expect(loadClientConfig({ ...BASE, NORTHCINDER_UI: "false" }).ui.enabled).toBe(false);
    expect(loadClientConfig({ ...BASE, NORTHCINDER_UI: "1" }).ui.enabled).toBe(true);

    const config = loadClientConfig({
      ...BASE,
      NORTHCINDER_UI_PORT: "8791",
      NORTHCINDER_UI_NTFY_TOPIC: "long-random-topic-abcdef",
      NORTHCINDER_UI_NTFY_URL: "https://ntfy.example.com",
    });
    expect(config.ui).toEqual({
      enabled: true,
      port: 8791,
      ntfy: { topic: "long-random-topic-abcdef", baseUrl: "https://ntfy.example.com" },
    });
  });

  it("rejects a malformed NORTHCINDER_UI_PORT", () => {
    expect(() => loadClientConfig({ ...BASE, NORTHCINDER_UI_PORT: "not-a-port" })).toThrow(/NORTHCINDER_UI_PORT/);
    expect(() => loadClientConfig({ ...BASE, NORTHCINDER_UI_PORT: "70000" })).toThrow(/NORTHCINDER_UI_PORT/);
  });

  it("rejects raw PAN/CVV configuration instead of treating it as an opaque delegated token", () => {
    expect(() => loadClientConfig({ ...BASE, NORTHCINDER_ACP_PAYMENT_TOKEN: "4242424242424242" })).toThrow(/raw card|opaque delegated/i);
    expect(() => loadClientConfig({ ...BASE, NORTHCINDER_CARD_NUMBER: "4242424242424242" })).toThrow(/raw card/i);
    expect(() => loadClientConfig({ ...BASE, NORTHCINDER_CVV: "123" })).toThrow(/raw card/i);
    expect(() => loadClientConfig({ ...BASE, BRIER_CVV: "123" })).toThrow(/raw card/i);
    expect(() => loadClientConfig({ ...BASE, THENAGAIN_CVV: "123" })).toThrow(/raw card/i);
    expect(() => loadClientConfig({ ...BASE, EMPTOR_CVV: "123" })).toThrow(/raw card/i);
    expect(() => loadClientConfig({ ...BASE, NORTHCINDER_ACP_PAYMENT_TOKEN: "pan=4242424242424242" })).toThrow(/raw card|opaque delegated/i);
    expect(() => loadClientConfig({ ...BASE, NORTHCINDER_ACP_PAYMENT_TOKEN: "spt_live_opaque_9f8e" })).not.toThrow();
  });
});
