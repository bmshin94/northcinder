/**
 * Per-client API key auth for the remote MCP bridge — the same Bearer-key
 * scheme as the buyer-run engine (service/src/http/app.ts, service/src/main.ts):
 * "clientId:key[,clientId:key…]" env format, constant-time key comparison.
 * Deliberately re-implemented here (not imported from @northcinder/service) so the
 * remote bridge stays independently self-hostable with no code dependency on
 * the engine package — see remote/README.md for the placement rationale.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export interface RemoteApiClientKey {
  clientId: string;
  key: string;
}

export function parseRemoteApiKeys(env: string | undefined): RemoteApiClientKey[] {
  if (env === undefined || env.trim() === "") {
    throw new Error(
      "NORTHCINDER_REMOTE_API_KEYS is required (format: clientId:key[,clientId:key…]) — refusing to boot an open remote bridge",
    );
  }
  return env.split(",").map((pair) => {
    const sep = pair.indexOf(":");
    const clientId = sep === -1 ? "" : pair.slice(0, sep).trim();
    const key = sep === -1 ? "" : pair.slice(sep + 1).trim();
    if (clientId === "" || key.length < 16) {
      throw new Error("NORTHCINDER_REMOTE_API_KEYS entry malformed (need clientId:key with key ≥16 chars)");
    }
    return { clientId, key };
  });
}

/** Constant-time key comparison via digest equality (no length leak). */
function keyMatches(presented: string, configured: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(configured).digest();
  return timingSafeEqual(a, b);
}

export type AuthResult = { ok: true; clientId: string } | { ok: false; message: string };

/**
 * Validate an `Authorization` header value against the configured keys.
 * Never echoes the presented key back in the failure message (leak
 * discipline — the same admission standard applies here too).
 */
export function authenticate(authorizationHeader: string | undefined, keys: RemoteApiClientKey[]): AuthResult {
  const header = authorizationHeader ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (presented.length === 0) {
    return { ok: false, message: "missing or invalid API key (Authorization: Bearer <key>)" };
  }
  const client = keys.find((k) => keyMatches(presented, k.key));
  if (!client) {
    return { ok: false, message: "missing or invalid API key (Authorization: Bearer <key>)" };
  }
  return { ok: true, clientId: client.clientId };
}
