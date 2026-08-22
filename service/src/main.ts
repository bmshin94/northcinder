import { serve } from "@hono/node-server";
import { canonicalizeProductEnv } from "@northcinder/protocol";
import { pathToFileURL } from "node:url";
import { buildAdaptersFromEnv } from "./adapters-from-env.js";
import { createApp } from "./http/app.js";
import { createOrchestrator } from "./orchestrator/orchestrator.js";
import { parseRequiredApiKeys } from "./runtime.js";
import { buildTrustProviderFromEnv } from "./trust/from-env.js";

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
function main(): void {
  const env = canonicalizeProductEnv(process.env);
  const keys = parseRequiredApiKeys(env["NORTHCINDER_API_KEYS"]);
  const port = Number(env["PORT"] ?? 8790);
  const hostname = env["NORTHCINDER_HOST"] ?? "127.0.0.1";
  const adapters = buildAdaptersFromEnv(env);
  const app = createApp({
    orchestrator: createOrchestrator(adapters),
    // Verifiable-signals trust engine by default (RDAP age, Tranco rank, curated
    // deny sources, best-effort CT); NORTHCINDER_TRUST_ENGINE=0 → seed-only fallback.
    trust: buildTrustProviderFromEnv(env),
    auth: { kind: "api-keys", keys },
  });

  serve({ fetch: app.fetch, hostname, port }, (info) => {
    const boundHost = info.address.includes(":") ? `[${info.address}]` : info.address;
    console.log(`[northcinder-service] listening on http://${boundHost}:${info.port}`);
    console.log(`[northcinder-service] registered stores: ${adapters.map((a) => a.manifest.id).join(", ")}`);
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
