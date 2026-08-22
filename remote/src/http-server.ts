/**
 * Node HTTP wiring for the remote bridge remote MCP bridge: Streamable HTTP transport
 * (stateless — a fresh McpServer + transport per request, per the MCP SDK's
 * own stateless-server pattern) behind per-client Bearer auth and a per-key
 * token bucket rate limiter.
 *
 * Routes:
 *   GET  /health  — liveness probe, no auth (any Node host's LB/orchestrator
 *                   needs this reachable before a client key even exists).
 *   POST /mcp     — the MCP Streamable HTTP endpoint. Auth + rate limit run
 *                   BEFORE the request ever reaches the MCP transport, and
 *                   the request body is read (and size-capped, see
 *                   MAX_MCP_BODY_BYTES) AFTER those, since auth only reads
 *                   the Authorization header and must keep short-circuiting
 *                   before any body parsing happens.
 *   GET/DELETE /mcp — 405: this variant is stateless (no session to stream
 *                   notifications into or terminate).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticate, type RemoteApiClientKey } from "./auth.js";
import { createNorthCinderRemoteMcpServer } from "./mcp-server.js";
import type { TokenBucketLimiter } from "./rate-limiter.js";
import type { NorthCinderServiceClient } from "./service-client.js";

export interface RemoteHttpServerDeps {
  apiKeys: RemoteApiClientKey[];
  rateLimiter: TokenBucketLimiter;
  service: NorthCinderServiceClient;
  /** Testable bounded body-read deadline; default is 15 seconds. */
  bodyReadTimeoutMs?: number;
  /** Testable per-authenticated-client admission ceiling; default is 8. */
  maxInFlightPerClient?: number;
  /** Testable process-wide admission ceiling; default is 64. */
  maxInFlight?: number;
}

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";

/**
 * Hard cap on a POST /mcp request body. This is a PUBLIC endpoint — a leaked
 * client key (or a misbehaving host) could otherwise push an unbounded body
 * at the process. 1 MiB comfortably covers real MCP JSON-RPC tool-call
 * payloads (search criteria, a full `merchant` object) with headroom, while
 * bounding worst-case memory/CPU spent buffering+parsing per request.
 */
const MAX_MCP_BODY_BYTES = 1_048_576;

type BodyReadResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: "too_large" }
  | { ok: false; reason: "invalid_json" }
  | { ok: false; reason: "timeout" };

/**
 * Read and JSON-parse the request body ourselves, enforcing MAX_MCP_BODY_BYTES,
 * then hand the already-parsed value to the MCP transport as `parsedBody`
 * (the SDK's documented pattern for body-parser-style integrations) instead
 * of letting the transport read the raw stream unbounded.
 */
function readJsonBodyWithCap(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<BodyReadResult> {
  const declaredLength = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    req.resume(); // drain without buffering so the socket can be reused/closed cleanly
    return Promise.resolve({ ok: false, reason: "too_large" });
  }
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let total = 0;
    const finish = (result: BodyReadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        finish({ ok: false, reason: "too_large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") {
        finish({ ok: true, body: undefined });
        return;
      }
      try {
        finish({ ok: true, body: JSON.parse(text) });
      } catch {
        finish({ ok: false, reason: "invalid_json" });
      }
    });
    req.on("error", () => {
      finish({ ok: false, reason: "invalid_json" });
    });
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(text);
}

function jsonRpcError(status: number, code: string, message: string, extraHeaders?: Record<string, string>) {
  return {
    status,
    body: { jsonrpc: "2.0", error: { code: -32000, data: { code, message } }, id: null },
    extraHeaders,
  };
}

export function createRemoteHttpServer(deps: RemoteHttpServerDeps): Server {
  const bodyReadTimeoutMs = deps.bodyReadTimeoutMs ?? 15_000;
  const maxInFlightPerClient = deps.maxInFlightPerClient ?? 8;
  const maxInFlight = deps.maxInFlight ?? 64;
  const inFlightByClient = new Map<string, number>();
  let inFlight = 0;
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === HEALTH_PATH && req.method === "GET") {
      writeJson(res, 200, { ok: true, service: "northcinder-remote", version: "0.2.0" });
      return;
    }

    if (url.pathname !== MCP_PATH) {
      writeJson(res, 404, { error: { code: "not_found", message: `no route: ${req.method} ${url.pathname}` } });
      return;
    }

    if (req.method !== "POST") {
      const err = jsonRpcError(405, "method_not_allowed", "this stateless bridge only supports POST /mcp");
      writeJson(res, err.status, err.body);
      return;
    }

    // --- auth: BEFORE the request ever reaches the MCP transport ---
    const auth = authenticate(req.headers.authorization, deps.apiKeys);
    if (!auth.ok) {
      const err = jsonRpcError(401, "unauthorized", auth.message);
      writeJson(res, err.status, err.body);
      return;
    }

    // --- per-key token bucket rate limit ---
    const consumed = deps.rateLimiter.tryConsume(auth.clientId);
    if (!consumed.ok) {
      const err = jsonRpcError(
        429,
        "rate_limited",
        `rate limit exceeded for client ${auth.clientId}; retry after ${consumed.retryAfterMs}ms`,
        { "retry-after": String(Math.ceil(consumed.retryAfterMs / 1000)) },
      );
      writeJson(res, err.status, err.body, err.extraHeaders);
      return;
    }

    // Admission covers body reads too: otherwise an authenticated slow sender can
    // retain arbitrary suspended handlers after paying only one rate-limit token.
    const clientInFlight = inFlightByClient.get(auth.clientId) ?? 0;
    if (inFlight >= maxInFlight || clientInFlight >= maxInFlightPerClient) {
      const err = jsonRpcError(429, "concurrent_requests_limited", "too many concurrent requests; retry shortly", { "retry-after": "1", connection: "close" });
      writeJson(res, err.status, err.body, err.extraHeaders);
      // This request may have declared more bytes than it supplied. Do not
      // leave its parser/socket around after refusing admission.
      res.once("finish", () => req.destroy());
      return;
    }
    inFlight += 1;
    inFlightByClient.set(auth.clientId, clientInFlight + 1);
    const release = () => {
      inFlight -= 1;
      const remaining = (inFlightByClient.get(auth.clientId) ?? 1) - 1;
      if (remaining <= 0) inFlightByClient.delete(auth.clientId);
      else inFlightByClient.set(auth.clientId, remaining);
    };

    try {
      // --- read + size-cap the body BEFORE it ever reaches the MCP transport ---
      const bodyResult = await readJsonBodyWithCap(req, MAX_MCP_BODY_BYTES, bodyReadTimeoutMs);
    if (!bodyResult.ok) {
      if (bodyResult.reason === "too_large") {
        const err = jsonRpcError(413, "payload_too_large", `request body exceeds the ${MAX_MCP_BODY_BYTES}-byte limit`);
        writeJson(res, err.status, err.body);
      } else if (bodyResult.reason === "timeout") {
        // End a valid structured response before tearing down the incomplete input.
        // `Connection: close` prevents a slow sender from retaining this socket.
        const err = jsonRpcError(408, "request_timeout", "request body timed out", { connection: "close" });
        writeJson(res, err.status, err.body, err.extraHeaders);
        res.once("finish", () => req.destroy());
      } else {
        const err = jsonRpcError(400, "invalid_json", "request body is not valid JSON");
        writeJson(res, err.status, err.body);
      }
      return;
    }

    // --- stateless MCP handling: fresh server + transport per request ---
    const server = createNorthCinderRemoteMcpServer({ service: deps.service });
    try {
      // Stateless mode: omitting sessionIdGenerator (rather than assigning it
      // `undefined` explicitly, which `exactOptionalPropertyTypes` rejects)
      // has the identical runtime effect — the property reads as undefined
      // either way, which is what disables session-ID validation.
      const transport = new StreamableHTTPServerTransport({});
      await server.connect(transport);
      await transport.handleRequest(req, res, bodyResult.body);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch {
      console.error("[northcinder-remote] unhandled MCP request error");
      if (!res.headersSent) {
        writeJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "internal server error" }, id: null });
      }
      void server.close();
    }
    } finally {
      release();
    }
  });
}
