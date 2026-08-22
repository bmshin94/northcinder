import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/northcinder.js", import.meta.url));
const configDir = mkdtempSync(join(tmpdir(), "northcinder-launcher-test-"));
const localDispatchEnv = {
  PATH: process.env.PATH,
  HOME: configDir,
  NORTHCINDER_CONFIG_DIR: configDir,
  NORTHCINDER_MODE: "local",
  NORTHCINDER_SERVICE_URL: "",
  NORTHCINDER_CLIENT_KEY: "",
};
const dispatchOptions = { encoding: "utf8", env: localDispatchEnv, timeout: 5_000 };
try {
  const help = spawnSync(process.execPath, [bin, "--help"], dispatchOptions);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: northcinder /m);
  assert.match(help.stdout, /northcinder init/);
  assert.doesNotMatch(help.stderr, /fatal|configuration/i);

  const initHelp = spawnSync(process.execPath, [bin, "init", "--help"], dispatchOptions);
  assert.equal(initHelp.status, 0, initHelp.stderr);
  assert.match(initHelp.stdout, /^Usage: northcinder init /m);
  assert.match(initHelp.stdout, /--client-key <key>\s+Required only for self-hosted mode/i);
  assert.doesNotMatch(initHelp.stdout, /--client-key <key>\s+Buyer-generated engine key \(at least 16 characters\)/i);
  assert.match(initHelp.stdout, /Optional Shopify Storefront Catalog host/i);
  assert.match(initHelp.stdout, /--shopify-profile-url <url>/i);
  assert.doesNotMatch(initHelp.stderr, /clientKey|fatal/i);

  const serviceHelp = spawnSync(process.execPath, [bin, "service", "--help"], dispatchOptions);
  assert.equal(serviceHelp.status, 0, serviceHelp.stderr);
  assert.match(serviceHelp.stdout, /^Usage: northcinder service/m);
  assert.match(serviceHelp.stdout, /NORTHCINDER_API_KEYS[^\n]+\(required\)/);
  assert.match(serviceHelp.stdout, /PORT\s+Loopback HTTP port \(default: 8790\)/);
  assert.doesNotMatch(serviceHelp.stdout, /NORTHCINDER_PORT|8787/);

  const unknown = spawnSync(process.execPath, [bin, "definitely-not-a-command"], dispatchOptions);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command: definitely-not-a-command/);
  assert.match(unknown.stderr, /Usage: northcinder /);
  assert.doesNotMatch(unknown.stderr, /\[NorthCinder-mcp\] fatal|startup failed/i);

  const version = spawnSync(process.execPath, [bin, "--version"], dispatchOptions);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), "northcinder 0.2.0");

  const unauthenticatedService = spawnSync(process.execPath, [bin, "service"], dispatchOptions);
  assert.equal(unauthenticatedService.status, 1, unauthenticatedService.stderr);
  assert.match(unauthenticatedService.stderr, /NORTHCINDER_API_KEYS is required/);
  assert.doesNotMatch(unauthenticatedService.stderr, /ready \(stdio\)|buyer-only local state/);

  const explicitEntryConfigDir = join(configDir, "explicit-entry");
  const explicitEntryInit = spawnSync(
    process.execPath,
    [
      bin,
      "init",
      "--non-interactive",
      "--mode",
      "local",
      "--config-dir",
      explicitEntryConfigDir,
      "--server-entry",
      bin,
    ],
    dispatchOptions,
  );
  assert.equal(
    explicitEntryInit.status,
    0,
    `explicit-entry init must exit after success; error=${explicitEntryInit.error?.code ?? "none"}; signal=${explicitEntryInit.signal ?? "none"}; stderr=${explicitEntryInit.stderr}`,
  );
  assert.match(explicitEntryInit.stdout, /Wrote config:/);
  assert.match(explicitEntryInit.stdout, /Local runtime check: ready on loopback/);
  assert.doesNotMatch(explicitEntryInit.stderr, /ready \(stdio\)|buyer-only local state/);

  const rejectedExplicitEntryInit = spawnSync(
    process.execPath,
    [
      bin,
      "init",
      "--non-interactive",
      "--mode",
      "self-hosted",
      "--config-dir",
      join(configDir, "rejected-explicit-entry"),
      "--server-entry",
      bin,
    ],
    { ...dispatchOptions, timeout: 2_000 },
  );
  assert.equal(
    rejectedExplicitEntryInit.status,
    1,
    `explicit-entry init must exit after validation failure; error=${rejectedExplicitEntryInit.error?.code ?? "none"}; signal=${rejectedExplicitEntryInit.signal ?? "none"}; stderr=${rejectedExplicitEntryInit.stderr}`,
  );
  assert.match(rejectedExplicitEntryInit.stderr, /serviceUrl is required in self-hosted mode/);
  assert.doesNotMatch(rejectedExplicitEntryInit.stderr, /ready \(stdio\)|buyer-only local state/);

  const output = execFileSync(process.execPath, [bin, "init", "--non-interactive", "--mode", "self-hosted", "--service-url", "http://127.0.0.1:8790", "--client-key", "0123456789abcdef", "--config-dir", configDir], { encoding: "utf8" });
  assert.match(output, /Wrote config:/);
  assert.match(output, /NORTHCINDER_SERVICE_URL/);
  assert.doesNotMatch(output, /Local runtime check/);

  const fakeEntry = join(configDir, "fake-entry.js");
  writeFileSync(fakeEntry, "#!/usr/bin/env node\nprocess.exit(0);\n");
  const fakeEntryInit = spawnSync(
    process.execPath,
    [
      bin,
      "init",
      "--non-interactive",
      "--mode",
      "local",
      "--config-dir",
      join(configDir, "fake-entry"),
      "--server-entry",
      fakeEntry,
    ],
    { ...dispatchOptions, timeout: 8_000 },
  );
  assert.equal(fakeEntryInit.status, 1, "a non-MCP emitted entry must not pass initializer readiness");
  assert.doesNotMatch(fakeEntryInit.stdout, /Local runtime check: ready on loopback/);
  assert.equal(
    fakeEntryInit.stderr,
    "[NorthCinder init] Local runtime check failed; retry init and check loopback access.\n",
  );
  assert.doesNotMatch(fakeEntryInit.stderr, new RegExp(configDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const localResult = spawnSync(
    process.execPath,
    [bin, "init", "--non-interactive", "--mode", "local", "--config-dir", configDir],
    dispatchOptions,
  );
  assert.equal(localResult.status, 0, localResult.stderr);
  const localOutput = localResult.stdout;
  assert.match(localOutput, /Wrote config:/);
  assert.equal(localOutput.match(/Local runtime check: ready on loopback/g)?.length, 1);
  assert.match(
    localOutput,
    /Discovery sources: amazon=not_configured, ebay=not_configured, etsy=not_configured, shopify=not_configured, woocommerce=not_configured/,
  );
  assert.doesNotMatch(localOutput, /ready on loopback:\s*\d|127\.0\.0\.1:\d/);
  assert.doesNotMatch(localOutput, /start NorthCinder locally/);
  assert.doesNotMatch(localOutput, /NORTHCINDER_(?:SERVICE_URL|CLIENT_KEY)/);
  assert.doesNotMatch(localOutput, /SHOPIFY_MCP_SHOPS/);
  const localRecord = JSON.parse(readFileSync(join(configDir, "northcinder-init.json"), "utf8"));
  assert.equal(localRecord.mode, "local");
  assert.deepEqual(localRecord.shops, []);
  assert.equal(Object.hasOwn(localRecord, "serviceUrl"), false);
  assert.equal(Object.hasOwn(localRecord, "clientKey"), false);

  const missingProfileShopsDir = join(configDir, "missing-profile-shops");
  const missingProfileShopsInit = spawnSync(
    process.execPath,
    [
      bin,
      "init",
      "--non-interactive",
      "--mode",
      "local",
      "--shop",
      "www.allbirds.com",
      "--config-dir",
      missingProfileShopsDir,
    ],
    dispatchOptions,
  );
  assert.equal(missingProfileShopsInit.status, 1);
  assert.match(missingProfileShopsInit.stderr, /shopify-profile-url/i);
  assert.equal(existsSync(join(missingProfileShopsDir, "northcinder-init.json")), false);

  const malformedShopDir = join(configDir, "malformed-shop");
  const malformedShop = "https://operator-secret.invalid/path";
  const malformedShopInit = spawnSync(
    process.execPath,
    [bin, "init", "--non-interactive", "--mode", "local", "--shop", malformedShop,
      "--shopify-profile-url", "https://agent.example/ucp-profile.json", "--config-dir", malformedShopDir],
    dispatchOptions,
  );
  assert.equal(malformedShopInit.status, 1);
  assert.match(malformedShopInit.stderr, /shop/i);
  assert.doesNotMatch(malformedShopInit.stderr, /operator-secret|malformed-shop/);
  assert.equal(existsSync(join(malformedShopDir, "northcinder-init.json")), false);

  const validShopDir = join(configDir, "valid-shop");
  const validShopInit = spawnSync(
    process.execPath,
    [bin, "init", "--non-interactive", "--mode", "local", "--shop", "www.allbirds.com",
      "--shopify-profile-url", "https://agent.example/ucp-profile.json", "--config-dir", validShopDir],
    dispatchOptions,
  );
  assert.equal(validShopInit.status, 0, validShopInit.stderr);
  const validShopRecord = JSON.parse(readFileSync(join(validShopDir, "northcinder-init.json"), "utf8"));
  assert.deepEqual(validShopRecord.shops, ["www.allbirds.com"]);
  assert.equal(validShopRecord.shopifyProfileUrl, "https://agent.example/ucp-profile.json");
  assert.equal(execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).trim(), "northcinder 0.2.0");
  assert.equal(
    execFileSync(process.execPath, [bin, "service", "--version"], { encoding: "utf8" }).trim(),
    "northcinder service 0.2.0",
  );
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
