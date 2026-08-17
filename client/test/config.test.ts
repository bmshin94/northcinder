import { describe, expect, it } from "vitest";
import { canonicalizeClientEnv, loadClientConfig } from "../src/config.js";

const BASE = {
  NORTHCINDER_SERVICE_URL: "http://127.0.0.1:8790",
  NORTHCINDER_CLIENT_KEY: "config-test-key-0123456789",
  NORTHCINDER_CONFIG_DIR: "/tmp/northcinder-config-test",
  HOME: "/tmp/northcinder-config-test-home",
};

describe("client config — local UI local UI settings", () => {
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
