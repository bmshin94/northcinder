import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/northcinder.js", import.meta.url));
const configDir = mkdtempSync(join(tmpdir(), "northcinder-launcher-test-"));
try {
  const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: northcinder /m);
  assert.match(help.stdout, /northcinder init/);
  assert.doesNotMatch(help.stderr, /fatal|configuration/i);

  const initHelp = spawnSync(process.execPath, [bin, "init", "--help"], { encoding: "utf8" });
  assert.equal(initHelp.status, 0, initHelp.stderr);
  assert.match(initHelp.stdout, /^Usage: northcinder init /m);
  assert.match(initHelp.stdout, /--client-key/);
  assert.match(initHelp.stdout, /optional legacy Shopify/i);
  assert.doesNotMatch(initHelp.stderr, /clientKey|fatal/i);

  const serviceHelp = spawnSync(process.execPath, [bin, "service", "--help"], { encoding: "utf8" });
  assert.equal(serviceHelp.status, 0, serviceHelp.stderr);
  assert.match(serviceHelp.stdout, /^Usage: northcinder service/m);
  assert.match(serviceHelp.stdout, /NORTHCINDER_API_KEYS/);
  assert.match(serviceHelp.stdout, /PORT\s+Loopback HTTP port \(default: 8790\)/);
  assert.doesNotMatch(serviceHelp.stdout, /NORTHCINDER_PORT|8787/);

  const unknown = spawnSync(process.execPath, [bin, "definitely-not-a-command"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command: definitely-not-a-command/);
  assert.match(unknown.stderr, /Usage: northcinder /);
  assert.doesNotMatch(unknown.stderr, /\[NorthCinder-mcp\] fatal|startup failed/i);

  const output = execFileSync(process.execPath, [bin, "init", "--non-interactive", "--mode", "self-hosted", "--service-url", "http://127.0.0.1:8790", "--client-key", "0123456789abcdef", "--config-dir", configDir], { encoding: "utf8" });
  assert.match(output, /Wrote config:/);
  assert.match(output, /NORTHCINDER_SERVICE_URL/);

  const localOutput = execFileSync(process.execPath, [bin, "init", "--non-interactive", "--mode", "local", "--client-key", "0123456789abcdef", "--config-dir", configDir], { encoding: "utf8" });
  assert.match(localOutput, /Wrote config:/);
  assert.match(localOutput, /start NorthCinder locally/);
  assert.doesNotMatch(localOutput, /SHOPIFY_MCP_SHOPS/);
  const localRecord = JSON.parse(readFileSync(join(configDir, "northcinder-init.json"), "utf8"));
  assert.equal(localRecord.mode, "local");
  assert.deepEqual(localRecord.shops, []);
  assert.equal(execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).trim(), "northcinder 0.1.2");
  assert.equal(
    execFileSync(process.execPath, [bin, "service", "--version"], { encoding: "utf8" }).trim(),
    "northcinder service 0.1.2",
  );
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
