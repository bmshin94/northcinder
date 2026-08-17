import { describe, expect, it } from "vitest";
import { createServiceClient } from "../src/service-client.js";

describe("remote bridge service client error boundary", () => {
  it("does not expose its configured upstream coordinate", async () => {
    const coordinate = "https://operator.private.example:8443/internal";
    const client = createServiceClient({
      serviceUrl: coordinate,
      clientKey: "test-service-key-0123456789",
      timeoutMs: 10,
      fetchImpl: async () => { throw new Error("offline"); },
    });

    const result = await client.search({ text: "shoes" });
    expect(result).toEqual({
      ok: false,
      error: { code: "service_unreachable", message: "configured NorthCinder engine unavailable" },
    });
    expect(JSON.stringify(result)).not.toContain(coordinate);
    expect(JSON.stringify(result)).not.toContain("operator.private.example");
  });

  it("does not expose an upstream HTTP error body", async () => {
    const detail = "database shard and operator account details";
    const client = createServiceClient({
      serviceUrl: "https://service.private.example",
      clientKey: "test-service-key-0123456789",
      fetchImpl: async () => new Response(JSON.stringify({ code: "internal", message: detail }), { status: 500 }),
    });

    const result = await client.search({ text: "shoes" });
    expect(result).toEqual({
      ok: false,
      error: { code: "service_error", message: "configured NorthCinder engine error (HTTP 500)" },
    });
    expect(JSON.stringify(result)).not.toContain(detail);
  });
});
