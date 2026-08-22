#!/usr/bin/env node
/**
 * northcinder MCP server entry point (stdio). Plug into any MCP host:
 *
 *   { "mcpServers": { "northcinder": {
 *       "command": "node", "args": ["<repo>/client/dist/main.js"],
 *       "env": { "NORTHCINDER_SERVICE_URL": "http://127.0.0.1:8790",
 *                "NORTHCINDER_CLIENT_KEY": "<key>" } } } }
 *
 * IMPORTANT: stdout belongs to the MCP protocol. Stderr may be captured by
 * the buyer's MCP application, so it carries status only — never client keys, confirmation
 * codes, owner paths, or tokenized local-UI URLs.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadOrCreateMandateKeypair } from "@northcinder/checkout";
import { createProfileStore } from "@northcinder/profile";
import { createWatchStore, publishNtfy } from "@northcinder/watches";
import { createOrderGraphStore } from "@northcinder/orders";
import { createAuditLog } from "./audit-log.js";
import { createAuthorizationStore } from "./authorization.js";
import { BRAND_NAME, BRAND_SLUG } from "./brand.js";
import { createClientCheckout } from "./checkout-wiring.js";
import { loadClientConfig } from "./config.js";
import { composeApprovalPush, generateSessionToken, startLocalUi } from "./local-ui.js";
import { createOrderStore } from "./order-store.js";
import { createNorthCinderMcpServer } from "./server.js";
import { createServiceClient } from "./service-client.js";

async function main(): Promise<void> {
  const config = loadClientConfig();
  const keypair = loadOrCreateMandateKeypair({ configDir: config.configDir });
  const audit = createAuditLog(config.configDir);
  const profile = createProfileStore({ configDir: config.configDir });
  const watches = createWatchStore({ configDir: config.configDir });
  const orders = createOrderStore(config.configDir);
  const orderGraph = createOrderGraphStore(config.configDir);
  const checkout = createClientCheckout({
    configDir: config.configDir,
    trustedPublicKeys: [keypair.publicKeyB64],
    acpMerchants: config.acpMerchants,
    ...(config.acpPaymentToken !== undefined ? { acpPaymentToken: config.acpPaymentToken } : {}),
  });

  // local UI local UI: random per-boot session token; the origin is known only
  // after bind, so the approvalUrl callback closes over it (it is always
  // resolved by the time a purchase authorization is requested).
  const sessionToken = generateSessionToken();
  let uiOrigin: string | undefined;
  const ntfy = config.ui.ntfy;

  const authorizations = createAuthorizationStore({
    keypair,
    configDir: config.configDir,
    quiet: true,
    ...(config.ui.enabled
      ? {
          approvalUrl: (id: string) =>
            uiOrigin !== undefined ? `${uiOrigin}/approve/${id}?t=${sessionToken}` : undefined,
          onRequested: (event) => {
            if (!ntfy) return;
            // Best-effort at delivery, strict on leaks: the push carries the
            // approval URL + fingerprint, never the code; failures name the
            // failure, never the topic.
            void publishNtfy({ topic: ntfy.topic, ...(ntfy.baseUrl ? { baseUrl: ntfy.baseUrl } : {}) }, composeApprovalPush(event))
              .then((result) => {
                if (!result.ok) {
                  process.stderr.write(
                    `[${BRAND_NAME}-mcp] approval push failed for ${event.authorizationId}: ${result.error.code}\n`,
                  );
                }
              })
              .catch(() => {
                process.stderr.write(
                  `[${BRAND_NAME}-mcp] approval push failed for ${event.authorizationId}: transport_error\n`,
                );
              });
          },
        }
      : {}),
  });

  if (config.ui.enabled) {
    const ui = await startLocalUi(
      { sessionToken, authorizations, audit, profile, watches, orders, orderGraph },
      { port: config.ui.port },
    );
    uiOrigin = ui.origin;
  }

  const server = createNorthCinderMcpServer({
    service: createServiceClient({
      serviceUrl: config.serviceUrl,
      ...(config.clientKey !== undefined ? { clientKey: config.clientKey } : {}),
      timeoutMs: config.searchTimeoutMs,
    }),
    authorizations,
    checkout: checkout.orchestrator,
    railFor: checkout.railFor,
    audit,
    profile,
    watches,
    orders,
    orderGraph,
    ...(config.ordersMailDropDir !== undefined ? { ordersMailDropDir: config.ordersMailDropDir } : {}),
    checkoutTimeoutMs: config.checkoutTimeoutMs,
  });

  await server.connect(new StdioServerTransport());
  // When the host agent disconnects (stdin ends), exit — otherwise the local
  // UI's HTTP listener would keep an orphaned process alive.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  process.stderr.write(
    [
      `[${BRAND_NAME}-mcp] ready (stdio); buyer-run engine configured`,
      `[${BRAND_NAME}-mcp] buyer-only local state configured${keypair.created ? " (new mandate keypair generated)" : ""}`,
      `[${BRAND_SLUG}-mcp] audit, profile, watches, orders, and nonce ledger configured`,
      `[${BRAND_SLUG}-mcp] mail-drop ingest: ${config.ordersMailDropDir ? "enabled" : "disabled"}`,
      `[${BRAND_NAME}-mcp] checkout rails: ${checkout.railIds.join(", ")}`,
      ...(uiOrigin !== undefined
        ? [
            `[${BRAND_NAME}-mcp] local UI enabled on loopback; tokenized approval links are written only to buyer-local state and optional approval pushes`,
            `[${BRAND_NAME}-mcp] approval pushes: ${ntfy ? "ntfy (topic configured — treat the topic as a secret)" : "off (set NORTHCINDER_UI_NTFY_TOPIC to enable)"}`,
          ]
        : [`[${BRAND_NAME}-mcp] local UI: disabled (NORTHCINDER_UI=0)`]),
      ``,
    ].join("\n"),
  );
}

main().catch(() => {
  process.stderr.write(`[${BRAND_NAME}-mcp] fatal: startup failed; check buyer-local configuration\n`);
  process.exit(1);
});
