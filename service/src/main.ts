import { serve } from "@hono/node-server";
import { buildAdaptersFromEnv } from "./adapters-from-env.js";
import { createApp, type ApiClientKey } from "./http/app.js";
import { createOrchestrator } from "./orchestrator/orchestrator.js";
import { buildTrustProviderFromEnv } from "./trust/from-env.js";
import { canonicalizeProductEnv } from "@northcinder/protocol";

/**
 * Service entrypoint. Env:
 *   PORT             — listen port (default 8790)
 *   NORTHCINDER_API_KEYS  — per-client keys, "clientId:key[,clientId:key…]" (required)
 *   plus the per-store adapter config documented in ./adapters-from-env.ts
 *   (SHOPIFY_MCP_SHOPS, SHOPIFY_GLOBAL_CATALOG_API_KEY, EBAY_CLIENT_ID/SECRET,
 *   ETSY_API_KEY, AMAZON_SESSION_PROFILE, NORTHCINDER_DEMO_SPONSORED_ADAPTER)
 *   and the trust-engine config documented in ./trust/from-env.ts
 *   (NORTHCINDER_TRUST_ENGINE, NORTHCINDER_TRUST_SEED_PATH, NORTHCINDER_TRUST_CORPUS_DIR,
 *   NORTHCINDER_TRUST_BUDGET_MS, NORTHCINDER_TRANCO_LIST_PATH/_ID,
 *   NORTHCINDER_PHISHTANK_DUMP_PATH, NORTHCINDER_TRUST_CT, ABUSECH_AUTH_KEY).
 *
 * All four real store adapters are always registered; unconfigured stores
 * degrade to structured `not_configured` statuses per search.
 */
function parseApiKeys(env: string | undefined): ApiClientKey[] {
  if (env === undefined || env.trim() === "") {
    throw new Error(
      "NORTHCINDER_API_KEYS is required (format: clientId:key[,clientId:key…]) — refusing to boot an open service",
    );
  }
  return env.split(",").map((pair) => {
    const sep = pair.indexOf(":");
    const clientId = sep === -1 ? "" : pair.slice(0, sep).trim();
    const key = sep === -1 ? "" : pair.slice(sep + 1).trim();
    if (clientId === "" || key.length < 16) {
      throw new Error(`NORTHCINDER_API_KEYS entry malformed (need clientId:key with key ≥16 chars)`);
    }
    return { clientId, key };
  });
}

const env = canonicalizeProductEnv(process.env);
const port = Number(env["PORT"] ?? 8790);
const adapters = buildAdaptersFromEnv(env);
const app = createApp({
  orchestrator: createOrchestrator(adapters),
  // Verifiable-signals trust engine by default (RDAP age, Tranco rank, curated
  // deny sources, best-effort CT); NORTHCINDER_TRUST_ENGINE=0 → seed-only fallback.
  trust: buildTrustProviderFromEnv(env),
  apiKeys: parseApiKeys(env["NORTHCINDER_API_KEYS"]),
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[northcinder-service] listening on http://127.0.0.1:${info.port}`);
  console.log(`[northcinder-service] registered stores: ${adapters.map((a) => a.manifest.id).join(", ")}`);
});
