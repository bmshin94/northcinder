/**
 * Remote MCP bridge entrypoint. Env:
 *   PORT                     — listen port (default 8791)
 *   NORTHCINDER_REMOTE_API_KEYS   — per-client keys for THIS bridge, "clientId:key[,clientId:key…]" (required)
 *   NORTHCINDER_SERVICE_URL       — base URL of the NorthCinder engine this deployer runs (required)
 *   NORTHCINDER_SERVICE_KEY       — deployer-generated Bearer key for that engine (required)
 *   NORTHCINDER_REMOTE_RATE_CAPACITY   — token bucket capacity per client key (default 30)
 *   NORTHCINDER_REMOTE_RATE_REFILL_PER_SEC — tokens refilled per second per client key (default 0.5, i.e. 30/min)
 *
 * This is a THIN proxy: every tool call re-verifies the neutrality ranking
 * itself (verifySearchRanking over the configured engine's inputs) rather than
 * trusting the upstream engine, exactly like the stdio client does. This
 * process has no repository-owner endpoint or control connection.
 */
import { createRemoteHttpServer } from "./http-server.js";
import { parseRemoteApiKeys } from "./auth.js";
import { createTokenBucketLimiter } from "./rate-limiter.js";
import { createServiceClient } from "./service-client.js";
import { canonicalizeProductEnv } from "@northcinder/protocol";
import { parseRemoteServiceUrl, remoteClientKeyLogLine, remoteUpstreamLogLine } from "./service-url.js";

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === "") {
    throw new Error(`${name} is required — refusing to boot an unconfigured remote MCP bridge`);
  }
  return v;
}

const env = canonicalizeProductEnv(process.env);
const port = Number(env["PORT"] ?? 8791);
const apiKeys = parseRemoteApiKeys(env["NORTHCINDER_REMOTE_API_KEYS"]);
const serviceUrl = parseRemoteServiceUrl(requireEnv(env, "NORTHCINDER_SERVICE_URL"));
const serviceKey = requireEnv(env, "NORTHCINDER_SERVICE_KEY");
const rateCapacity = Number(env["NORTHCINDER_REMOTE_RATE_CAPACITY"] ?? 30);
const rateRefillPerSec = Number(env["NORTHCINDER_REMOTE_RATE_REFILL_PER_SEC"] ?? 0.5);

const httpServer = createRemoteHttpServer({
  apiKeys,
  rateLimiter: createTokenBucketLimiter({ capacity: rateCapacity, refillPerSec: rateRefillPerSec }),
  service: createServiceClient({ serviceUrl, clientKey: serviceKey }),
});

httpServer.listen(port, () => {
  // `PORT=0` is the supported verification/development mode. Log the bound
  // ephemeral port, not the requested sentinel, so a supervising process can
  // use this line as a real readiness event.
  const address = httpServer.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  console.log(`[northcinder-remote] listening on http://0.0.0.0:${boundPort} (MCP endpoint: /mcp, health: /health)`);
  console.log(remoteUpstreamLogLine(serviceUrl));
  console.log(remoteClientKeyLogLine(apiKeys.length));
});
