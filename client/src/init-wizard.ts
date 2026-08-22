/**
 * `northcinder init` — non-interactive-testable core of the setup wizard.
 *
 * The wizard produces two artifacts from a small set of answers without a live network call:
 *   1. an on-disk init-record (`<configDir>/northcinder-init.json`, 0600) the
 *      user can re-read later; and
 *   2. a vendor-neutral `mcpServers` JSON snippet.
 *
 * All the interactive prompting lives in init-main.ts; everything here is a
 * pure function of its inputs so the non-interactive/CI path is unit-testable without a TTY.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AllowedHostSchema, resolveConfigDir, validateCredentialedBaseUrl } from "@northcinder/protocol";
import { BRAND_NAME, BRAND_SLUG } from "./brand.js";

export interface InitAnswers {
  /** "self-hosted" = point at a NorthCinder engine the buyer separately deploys.
   *  "local" = the packed launcher owns an ephemeral loopback engine and can
   *  optionally configure Shopify UCP profile and storefront hosts on that side. */
  mode: "self-hosted" | "local";
  serviceUrl?: string;
  clientKey?: string;
  shops: string[];
  shopifyProfileUrl?: string;
  ntfyTopic?: string;
  configDir: string;
  /** Absolute path to client/dist/main.js — defaults to argv-relative in the CLI. */
  serverEntry: string;
}

interface InitConfigRecordBase {
  brand: string;
  shops: string[];
  shopifyProfileUrl?: string;
  ntfyTopic?: string;
  configDir: string;
  createdAt: string;
}

export interface LocalInitConfigRecord extends InitConfigRecordBase {
  mode: "local";
}

export interface SelfHostedInitConfigRecord extends InitConfigRecordBase {
  mode: "self-hosted";
  serviceUrl: string;
  clientKey: string;
}

export type InitConfigRecord = LocalInitConfigRecord | SelfHostedInitConfigRecord;

export interface InitResult {
  record: InitConfigRecord;
  configPath: string;
  mcpHostSnippet: string;
}

export class InitAnswersError extends Error {}

/** Validate + normalize answers; throws InitAnswersError with an actionable message. */
export function resolveInitAnswers(answers: InitAnswers): InitConfigRecord {
  if (answers.mode !== "local" && answers.mode !== "self-hosted") {
    throw new InitAnswersError("mode must be 'local' or 'self-hosted' (--mode)");
  }
  let validatedShopifyProfileUrl: string | undefined;
  if (answers.shopifyProfileUrl !== undefined) {
    let profile: URL;
    try {
      profile = new URL(answers.shopifyProfileUrl);
    } catch {
      throw new InitAnswersError("shopifyProfileUrl must be an HTTPS URL without credentials (--shopify-profile-url)");
    }
    if (profile.protocol !== "https:" || profile.username || profile.password) {
      throw new InitAnswersError("shopifyProfileUrl must be an HTTPS URL without credentials (--shopify-profile-url)");
    }
    validatedShopifyProfileUrl = answers.shopifyProfileUrl;
  }
  if (answers.mode === "local" && answers.shops.length > 0 && validatedShopifyProfileUrl === undefined) {
    throw new InitAnswersError("--shop requires --shopify-profile-url (an HTTPS UCP agent profile URL)");
  }
  for (const shop of answers.shops) {
    if (!AllowedHostSchema.safeParse(shop).success || shop.includes("*")) {
      throw new InitAnswersError("--shop must be a bare Shopify hostname (no scheme, path, port, or wildcard)");
    }
  }
  const common = {
    brand: BRAND_NAME,
    shops: answers.shops,
    ...(validatedShopifyProfileUrl !== undefined ? { shopifyProfileUrl: validatedShopifyProfileUrl } : {}),
    ...(answers.ntfyTopic ? { ntfyTopic: answers.ntfyTopic } : {}),
    configDir: answers.configDir,
    createdAt: new Date().toISOString(),
  };
  if (answers.mode === "local") {
    return { ...common, mode: "local" };
  }

  const serviceUrl = answers.serviceUrl;
  if (!serviceUrl) {
    throw new InitAnswersError("serviceUrl is required in self-hosted mode (--service-url)");
  }
  const parsedServiceUrl = validateCredentialedBaseUrl(serviceUrl, { allowLoopbackHttp: true });
  if (!parsedServiceUrl.ok) {
    throw new InitAnswersError(
      "serviceUrl must use HTTPS, except explicit loopback HTTP, and must not contain credentials, query, or fragment; use --client-key for your NorthCinder engine key",
    );
  }
  const clientKey = answers.clientKey;
  if (!clientKey || clientKey.length < 16) {
    throw new InitAnswersError(
      "clientKey is required and must be at least 16 characters (--client-key). " +
        "This must match a buyer-generated key from the engine's NORTHCINDER_API_KEYS.",
    );
  }
  return {
    ...common,
    mode: "self-hosted",
    serviceUrl,
    clientKey,
  };
}

export function buildMcpHostSnippet(answers: InitAnswers, record: InitConfigRecord): string {
  const env: Record<string, string> = {
    NORTHCINDER_MODE: record.mode,
    ...(record.mode === "self-hosted"
      ? {
          NORTHCINDER_SERVICE_URL: record.serviceUrl,
          NORTHCINDER_CLIENT_KEY: record.clientKey,
        }
      : {}),
    NORTHCINDER_CONFIG_DIR: record.configDir,
    ...(record.ntfyTopic ? { NORTHCINDER_UI_NTFY_TOPIC: record.ntfyTopic } : {}),
    ...(process.env.XDG_CONFIG_HOME !== undefined ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
  };
  const snippet = {
    mcpServers: {
      [BRAND_SLUG]: {
        command: "node",
        args: [answers.serverEntry],
        env,
      },
    },
  };
  return JSON.stringify(snippet, null, 2);
}

/**
 * Materialize persisted local-only adapter configuration for an engine owned
 * by the packed launcher. An explicit vendor environment value takes
 * precedence; the MCP host environment remains limited to NorthCinder values.
 */
export function materializeOwnedLocalEngineEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const materialized = { ...env };
  if (env.SHOPIFY_MCP_SHOPS !== undefined && env.SHOPIFY_UCP_AGENT_PROFILE_URL !== undefined) return materialized;

  const configDir = resolveConfigDir(env);
  let raw: string;
  try {
    raw = readFileSync(join(configDir, "northcinder-init.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return materialized;
    throw new InitAnswersError("local init record is invalid; run northcinder init again");
  }

  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new InitAnswersError("local init record is invalid; run northcinder init again");
  }
  if (typeof record !== "object" || record === null) {
    throw new InitAnswersError("local init record is invalid; run northcinder init again");
  }
  const candidate = record as Record<string, unknown>;
  if (candidate.mode === "self-hosted") return materialized;
  if (
    candidate.brand !== BRAND_NAME ||
    candidate.mode !== "local" ||
    candidate.configDir !== configDir ||
    typeof candidate.createdAt !== "string" ||
    !Array.isArray(candidate.shops) ||
    !candidate.shops.every((shop) => typeof shop === "string")
  ) {
    throw new InitAnswersError("local init record is invalid; run northcinder init again");
  }
  if (candidate.shops.length > 0) {
    if (env.SHOPIFY_MCP_SHOPS === undefined) materialized.SHOPIFY_MCP_SHOPS = candidate.shops.join(",");
  }
  if (candidate.shopifyProfileUrl !== undefined) {
    if (typeof candidate.shopifyProfileUrl !== "string") throw new InitAnswersError("local init record is invalid; run northcinder init again");
    if (env.SHOPIFY_UCP_AGENT_PROFILE_URL === undefined) materialized.SHOPIFY_UCP_AGENT_PROFILE_URL = candidate.shopifyProfileUrl;
  }
  return materialized;
}

/** Writes the init record to `<configDir>/northcinder-init.json` (0600) and returns the full result. */
export function runInit(answers: InitAnswers): InitResult {
  const record = resolveInitAnswers(answers);
  mkdirSync(record.configDir, { recursive: true, mode: 0o700 });
  const configPath = join(record.configDir, "northcinder-init.json");
  writeFileSync(configPath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync's mode does not change an existing file; enforce owner-only
  // permissions after both creation and overwrite.
  chmodSync(configPath, 0o600);
  return {
    record,
    configPath,
    mcpHostSnippet: buildMcpHostSnippet(answers, record),
  };
}
