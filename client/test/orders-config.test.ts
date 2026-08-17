import { describe, expect, it } from "vitest";
import { loadOrdersConfig } from "../src/orders-config.js";

const BASE = {
  NORTHCINDER_CONFIG_DIR: "/tmp/northcinder-orders-config-test",
  HOME: "/tmp/northcinder-orders-config-test-home",
};

describe("orders config — a narrower loader for the northcinder-orders bin", () => {
  it("loads successfully with NO service URL/key set — the orders bin never calls the service", () => {
    expect(() => loadOrdersConfig(BASE)).not.toThrow();
    const config = loadOrdersConfig(BASE);
    expect(config.configDir).toBe("/tmp/northcinder-orders-config-test");
    expect(config.ordersMailDropDir).toBeUndefined();
    expect(config.ordersReturnReminderDays).toBe(3);
  });

  it("honors NORTHCINDER_ORDERS_MAIL_DROP_DIR and its 0/false disable flag", () => {
    expect(loadOrdersConfig({ ...BASE, NORTHCINDER_ORDERS_MAIL_DROP_DIR: "/custom/drop", NORTHCINDER_ORDERS_ALLOW_LOCAL_UNAUTHENTICATED: "1" }).ordersMailDropDir).toBe(
      "/custom/drop",
    );
    expect(loadOrdersConfig({ ...BASE, NORTHCINDER_ORDERS_ALLOW_LOCAL_UNAUTHENTICATED: "1" }).ordersMailDropDir).toBe("/tmp/northcinder-orders-config-test/mail-drop");
    expect(loadOrdersConfig({ ...BASE, NORTHCINDER_ORDERS_MAIL_DROP_DIR: "0" }).ordersMailDropDir).toBeUndefined();
    expect(loadOrdersConfig({ ...BASE, NORTHCINDER_ORDERS_MAIL_DROP_DIR: "false" }).ordersMailDropDir).toBeUndefined();
  });

  it("honors NORTHCINDER_ORDERS_RETURN_REMINDER_DAYS and rejects a non-positive value", () => {
    expect(loadOrdersConfig({ ...BASE, NORTHCINDER_ORDERS_RETURN_REMINDER_DAYS: "5" }).ordersReturnReminderDays).toBe(5);
    expect(() => loadOrdersConfig({ ...BASE, NORTHCINDER_ORDERS_RETURN_REMINDER_DAYS: "-1" })).toThrow(
      /NORTHCINDER_ORDERS_RETURN_REMINDER_DAYS/,
    );
  });

  it("never requires NORTHCINDER_SERVICE_URL or NORTHCINDER_CLIENT_KEY", () => {
    const env = { NORTHCINDER_CONFIG_DIR: "/tmp/northcinder-orders-config-test", HOME: "/tmp/northcinder-orders-config-test-home" };
    expect("NORTHCINDER_SERVICE_URL" in env).toBe(false);
    expect("NORTHCINDER_CLIENT_KEY" in env).toBe(false);
    expect(() => loadOrdersConfig(env)).not.toThrow();
  });
});
