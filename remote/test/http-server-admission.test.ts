import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createRemoteHttpServer } from "../src/http-server.js";
import { createTokenBucketLimiter } from "../src/rate-limiter.js";
import type { NorthCinderServiceClient } from "../src/service-client.js";

const CLIENT_ID = "admission";
const VALID_KEY = "a".repeat(20);

function fakeService(): NorthCinderServiceClient {
  return {
    async search() { throw new Error("not reached"); },
    async trust() { throw new Error("not reached"); },
  };
}

async function withServer<T>(fn: (baseUrl: string, port: number) => Promise<T>): Promise<T> {
  const server = createRemoteHttpServer({
    apiKeys: [{ clientId: CLIENT_ID, key: VALID_KEY }],
    rateLimiter: createTokenBucketLimiter({ capacity: 100, refillPerSec: 100 }),
    service: fakeService(),
    bodyReadTimeoutMs: 40,
    maxInFlightPerClient: 1,
    maxInFlight: 2,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try { return await fn(`http://127.0.0.1:${port}`, port); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function slowSocket(port: number): Promise<{ socket: ReturnType<typeof connect>; response: Promise<string> }> {
  const socket = connect(port, "127.0.0.1");
  let text = "";
  socket.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
  const response = new Promise<string>((resolve, reject) => {
    socket.on("error", (err: NodeJS.ErrnoException) => {
      // The server deliberately destroys an incomplete request only after its
      // structured timeout response finishes. A concurrent drip write can
      // therefore observe ECONNRESET even though the full 408 was received.
      if (err.code === "ECONNRESET" && text.includes("HTTP/1.1 408")) resolve(text);
      else reject(err);
    });
    socket.on("close", () => resolve(text));
  });
  return new Promise((resolve) => socket.once("connect", () => {
    socket.write(
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${VALID_KEY}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: keep-alive\r\n\r\n{`,
    );
    resolve({ socket, response });
  }));
}

describe("remote MCP body deadline and admission", () => {
  it("times out a partial authenticated body with a structured generic response and frees admission", async () => {
    await withServer(async (baseUrl, port) => {
      const slow = await slowSocket(port);
      const text = await slow.response;
      expect(text).toContain("408");
      expect(text).toContain("request_timeout");
      expect(text).not.toContain(VALID_KEY);
      expect(text).not.toContain("127.0.0.1");

      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
      const next = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${VALID_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(next.status).not.toBe(429);
    });
  });

  it("rejects a second authenticated partial body while the per-client admission slot is occupied", async () => {
    await withServer(async (_baseUrl, port) => {
      const first = await slowSocket(port);
      const second = await slowSocket(port);
      const text = await second.response;
      expect(text).toContain("429");
      expect(text).toContain("concurrent_requests_limited");
      first.socket.destroy();
    });
  });

  it("uses an absolute deadline: a drip-fed body cannot extend the authenticated handler lifetime", async () => {
    await withServer(async (_baseUrl, port) => {
      const slow = await slowSocket(port);
      const interval = setInterval(() => slow.socket.write("x"), 10);
      const text = await slow.response;
      clearInterval(interval);
      expect(text).toContain("408");
      expect(text).toContain("request_timeout");
    });
  });
});
