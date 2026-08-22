import { SearchRankResponseSchema } from "@northcinder/protocol";
import { describe, expect, it } from "vitest";
import * as serviceRuntime from "../src/runtime.js";

const { startLocalEngine } = serviceRuntime;

function parseRequiredApiKeys(raw: string | undefined) {
  const parser = (serviceRuntime as { parseRequiredApiKeys?: (value: string | undefined) => unknown }).parseRequiredApiKeys;
  if (parser === undefined) throw new Error("parseRequiredApiKeys is not implemented");
  return parser(raw);
}

describe("launcher-owned local engine runtime", () => {
  it("binds an ephemeral IPv4 loopback socket, serves keyless search, and closes it", async () => {
    const runtime = await startLocalEngine({ NORTHCINDER_TRUST_ENGINE: "0" });
    const origin = new URL(runtime.origin);

    expect(origin.hostname).toBe("127.0.0.1");
    expect(origin.port).not.toBe("");
    expect(origin.port).not.toBe("8790");

    const health = await fetch(`${runtime.origin}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      ok: true,
      service: "northcinder",
      version: "0.2.1",
      discoverySources: [
        { store: "amazon", status: "not_configured" },
        { store: "ebay", status: "not_configured" },
        { store: "etsy", status: "not_configured" },
        { store: "shopify", status: "not_configured" },
        { store: "woocommerce", status: "not_configured" },
      ],
    });

    const response = await fetch(`${runtime.origin}/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: { text: "running shoes" } }),
    });
    expect(response.status).toBe(200);
    const body = SearchRankResponseSchema.parse(await response.json());
    expect(body.registeredStores).toEqual(runtime.registeredStores);
    expect(body.storeStatuses).toHaveLength(runtime.registeredStores.length);
    expect(body.storeStatuses.every((status) => status.ok === false && status.error.code === "not_configured")).toBe(true);

    await runtime.close();
    await runtime.close();
    await expect(fetch(`${runtime.origin}/health`)).rejects.toThrow();
  });
});

describe("required API key parsing", () => {
  it("does not execute the explicit service command when main is imported", async () => {
    await expect(import("../src/main.js")).resolves.toBeDefined();
  });

  it("refuses a missing key configuration", () => {
    expect(() => parseRequiredApiKeys(undefined)).toThrow(/NORTHCINDER_API_KEYS is required/);
  });

  it("refuses a key shorter than sixteen characters", () => {
    expect(() => parseRequiredApiKeys("client:too-short")).toThrow(/entry malformed/);
  });

  it("refuses an entry without a client/key separator", () => {
    expect(() => parseRequiredApiKeys("client-without-key")).toThrow(/entry malformed/);
  });

  it("parses trimmed client/key pairs for the authenticated service command", () => {
    expect(parseRequiredApiKeys(" alpha:1234567890abcdef , beta:fedcba0987654321 ")).toEqual([
      { clientId: "alpha", key: "1234567890abcdef" },
      { clientId: "beta", key: "fedcba0987654321" },
    ]);
  });
});
