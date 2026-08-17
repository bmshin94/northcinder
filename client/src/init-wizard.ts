/**
 * `northcinder init` — non-interactive-testable core of the setup wizard.
 *
 * The wizard produces three artifacts from a small set of answers without a live network call:
 *   1. an on-disk init-record (`<configDir>/northcinder-init.json`, 0600 — it can
 *      hold a client key) the user can re-read later;
 *   2. a vendor-neutral `mcpServers` JSON snippet; and
 *   3. in local mode, the engine launch command — "you run NorthCinder
 *      yourself" is only actionable if the wizard says HOW.
 *
 * All the interactive prompting lives in init-main.ts; everything here is a
 * pure function of its inputs so the non-interactive/CI path is unit-testable without a TTY.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BRAND_NAME, BRAND_SLUG } from "./brand.js";

export interface InitAnswers {
  /** "self-hosted" = point at a NorthCinder engine the buyer separately deploys.
   *  "local" = the buyer will run `node service/dist/main.js` locally;
   *  the wizard fills in the loopback URL and can optionally configure
   *  legacy Shopify shop hosts on that side. */
  mode: "self-hosted" | "local";
  serviceUrl?: string;
  clientKey?: string;
  shops: string[];
  ntfyTopic?: string;
  configDir: string;
  /** Absolute path to client/dist/main.js — defaults to argv-relative in the CLI. */
  serverEntry: string;
  /** Optional packed launcher service entry. Source checkouts retain their sibling service path. */
  serviceEntry?: string;
}

export interface InitConfigRecord {
  brand: string;
  mode: "self-hosted" | "local";
  serviceUrl: string;
  clientKey: string;
  shops: string[];
  ntfyTopic?: string;
  configDir: string;
  createdAt: string;
}

export interface InitResult {
  record: InitConfigRecord;
  configPath: string;
  mcpHostSnippet: string;
  /** Local mode only: the ready-to-paste service launch command. */
  serviceCommand?: string;
}

const LOCAL_SERVICE_URL = "http://127.0.0.1:8790";

export class InitAnswersError extends Error {}

/** Quote one argv or environment-assignment value for a POSIX shell.
 *
 * Init output is intentionally copy/pasteable, so treat every answer as
 * hostile shell text. Single quotes suppress substitutions; embedded single
 * quotes use the portable close-quote/double-quoted-quote/reopen sequence.
 */
export function quotePosixShell(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/** Validate + normalize answers; throws InitAnswersError with an actionable message. */
export function resolveInitAnswers(answers: InitAnswers): InitConfigRecord {
  if (answers.mode !== "local" && answers.mode !== "self-hosted") {
    throw new InitAnswersError("mode must be 'local' or 'self-hosted' (--mode)");
  }
  const serviceUrl = answers.mode === "local" ? LOCAL_SERVICE_URL : answers.serviceUrl;
  if (!serviceUrl) {
    throw new InitAnswersError("serviceUrl is required in self-hosted mode (--service-url)");
  }
  let parsedServiceUrl: URL;
  try {
    parsedServiceUrl = new URL(serviceUrl);
  } catch {
    throw new InitAnswersError("serviceUrl is not a valid URL");
  }
  if (!["http:", "https:"].includes(parsedServiceUrl.protocol)) {
    throw new InitAnswersError("serviceUrl must use HTTP or HTTPS");
  }
  if (parsedServiceUrl.username || parsedServiceUrl.password) {
    throw new InitAnswersError("serviceUrl must not contain credentials; use --client-key for your NorthCinder engine key");
  }
  const clientKey = answers.clientKey;
  if (!clientKey || clientKey.length < 16) {
    throw new InitAnswersError(
      "clientKey is required and must be at least 16 characters (--client-key). " +
        "This must match a buyer-generated key from the engine's NORTHCINDER_API_KEYS.",
    );
  }
  return {
    brand: BRAND_NAME,
    mode: answers.mode,
    serviceUrl,
    clientKey,
    shops: answers.shops,
    ...(answers.ntfyTopic ? { ntfyTopic: answers.ntfyTopic } : {}),
    configDir: answers.configDir,
    createdAt: new Date().toISOString(),
  };
}

export function buildMcpHostSnippet(answers: InitAnswers, record: InitConfigRecord): string {
  const env: Record<string, string> = {
    NORTHCINDER_SERVICE_URL: record.serviceUrl,
    NORTHCINDER_CLIENT_KEY: record.clientKey,
    NORTHCINDER_CONFIG_DIR: record.configDir,
    ...(record.ntfyTopic ? { NORTHCINDER_UI_NTFY_TOPIC: record.ntfyTopic } : {}),
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
 * Local mode only: the launch command for the engine the buyer just chose to
 * run locally. The engine entry is derived from the client's serverEntry
 * (client/dist/main.js → ../../service/dist/main.js in the same checkout).
 * Self-hosted mode returns undefined because the buyer runs that deployment separately.
 */
export function buildServiceCommand(answers: InitAnswers, record: InitConfigRecord): string | undefined {
  if (answers.mode !== "local") return undefined;
  return [
    `NORTHCINDER_API_KEYS=${quotePosixShell(`me:${record.clientKey}`)}`,
    ...(record.shops.length > 0
      ? [`SHOPIFY_MCP_SHOPS=${quotePosixShell(record.shops.join(","))}`]
      : []),
    `node ${quotePosixShell(answers.serviceEntry ?? resolve(dirname(answers.serverEntry), "..", "..", "service", "dist", "main.js"))}${answers.serviceEntry ? " service" : ""}`,
  ].join(" \\\n  ");
}

/** Writes the init record to `<configDir>/northcinder-init.json` (0600) and returns the full result. */
export function runInit(answers: InitAnswers): InitResult {
  const record = resolveInitAnswers(answers);
  mkdirSync(record.configDir, { recursive: true, mode: 0o700 });
  const configPath = join(record.configDir, "northcinder-init.json");
  writeFileSync(configPath, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync's mode does not change an existing file; the record carries
  // a client key, so enforce its mode after both creation and overwrite.
  chmodSync(configPath, 0o600);
  const serviceCommand = buildServiceCommand(answers, record);
  return {
    record,
    configPath,
    mcpHostSnippet: buildMcpHostSnippet(answers, record),
    ...(serviceCommand !== undefined ? { serviceCommand } : {}),
  };
}
