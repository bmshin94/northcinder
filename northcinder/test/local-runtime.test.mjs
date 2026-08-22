import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "../../client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const packageDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const productSkill = readFileSync(new URL("../../client/research-skills/product-research/SKILL.md", import.meta.url), "utf8");
const sellerSkill = readFileSync(new URL("../../client/research-skills/seller-research/SKILL.md", import.meta.url), "utf8");

function withDeadline(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

test("relative packed init emits a portable MCP command that launches from another cwd", { timeout: 30_000 }, async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "northcinder-packed-local-runtime-"));
  const initCwd = join(tempRoot, "init-cwd");
  const hostCwd = join(tempRoot, "host-cwd");
  const relativeConfigDir = "owner-config-path-canary";
  const shellOnlyEbayId = "shell-only-ebay-id-canary";
  const shellOnlyEbaySecret = "shell-only-ebay-secret-canary";
  const configDir = join(initCwd, relativeConfigDir);
  mkdirSync(initCwd, { recursive: true, mode: 0o700 });
  mkdirSync(hostCwd, { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { mode: 0o700 });
  chmodSync(configDir, 0o700);
  assert.equal(statSync(configDir).mode & 0o777, 0o700);

  let client;
  let transport;
  let stderrText = "";
  try {
    const pack = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", tempRoot, "--json"], {
      cwd: packageDir,
      encoding: "utf8",
    }))[0];
    const tarball = join(tempRoot, pack.filename);
    execFileSync("tar", ["-xzf", tarball, "-C", tempRoot]);
    const packedBin = join(tempRoot, "package", "bin", "northcinder.js");
    assert.match(readFileSync(packedBin, "utf8"), /^#!\/usr\/bin\/env node/);

    const initOutput = execFileSync(
      process.execPath,
      [packedBin, "init", "--non-interactive", "--mode", "local", "--config-dir", relativeConfigDir],
      {
        cwd: initCwd,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: initCwd,
          EBAY_CLIENT_ID: shellOnlyEbayId,
          EBAY_CLIENT_SECRET: shellOnlyEbaySecret,
        },
        timeout: 10_000,
      },
    );
    const jsonStart = initOutput.indexOf("{");
    const discoveryStart = initOutput.indexOf("\nDiscovery sources:");
    const readinessStart = initOutput.indexOf("\nLocal runtime check:");
    const jsonEnd = discoveryStart === -1 ? readinessStart : discoveryStart;
    assert.notEqual(jsonStart, -1, initOutput);
    assert.notEqual(jsonEnd, -1, initOutput);
    assert.match(initOutput, /ebay=not_configured/);
    assert.doesNotMatch(initOutput, /ebay=ready/);
    assert.doesNotMatch(initOutput, new RegExp(`${shellOnlyEbayId}|${shellOnlyEbaySecret}`));
    const emitted = JSON.parse(initOutput.slice(jsonStart, jsonEnd));
    const entry = emitted.mcpServers.northcinder;
    assert.equal(entry.command, "node");
    assert.equal(entry.args.length, 1);
    assert.equal(entry.args[0], join(configDir, "runtime", "northcinder.js"));
    assert.equal(entry.env.NORTHCINDER_CONFIG_DIR, configDir);
    assert.doesNotMatch(JSON.stringify(emitted), /EBAY_CLIENT_ID|EBAY_CLIENT_SECRET|shell-only-ebay/);
    assert.doesNotMatch(
      readFileSync(join(configDir, "northcinder-init.json"), "utf8"),
      /EBAY_CLIENT_ID|EBAY_CLIENT_SECRET|shell-only-ebay/,
    );
    assert.equal(
      readFileSync(join(configDir, "research-skills", "product-research", "SKILL.md"), "utf8"),
      productSkill,
    );
    assert.equal(
      readFileSync(join(configDir, "research-skills", "seller-research", "SKILL.md"), "utf8"),
      sellerSkill,
    );
    assert.equal(statSync(join(configDir, "research-skills", "product-research", "SKILL.md")).mode & 0o777, 0o600);
    assert.equal(statSync(join(configDir, "research-skills", "seller-research", "SKILL.md")).mode & 0o777, 0o600);

    client = new Client({ name: "northcinder-packed-local-runtime-test", version: "0.0.1" });
    transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      cwd: hostCwd,
      env: { HOME: initCwd, ...entry.env },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => { stderrText += String(chunk); });
    try {
      await client.connect(transport, { timeout: 10_000 });
    } catch (error) {
      throw new Error(`packed local MCP initialize failed: ${error instanceof Error ? error.message : String(error)}; stderr=${stderrText}`);
    }

    const child = transport._process;
    assert.ok(child, "StdioClientTransport must own the spawned packed child");
    const childExit = new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    const listed = await client.listTools(undefined, { timeout: 5_000 });
    assert.equal(listed.tools.some((tool) => tool.name === "search_products"), true);
    assert.equal(listed.tools.some((tool) => tool.name === "create_research_plan"), true);

    const resources = await client.listResources(undefined, { timeout: 5_000 });
    assert.deepEqual(
      resources.resources.filter((resource) => resource.uri.startsWith("northcinder://research/")).map((resource) => resource.uri),
      ["northcinder://research/product", "northcinder://research/seller"],
    );
    const product = await client.readResource({ uri: "northcinder://research/product" }, { timeout: 5_000 });
    const seller = await client.readResource({ uri: "northcinder://research/seller" }, { timeout: 5_000 });
    assert.equal(product.contents[0].text, productSkill);
    assert.equal(seller.contents[0].text, sellerSkill);

    const prompt = await client.getPrompt({
      name: "research_product",
      arguments: { request: "Check exact fit", subject: "Packed Product Variant" },
    }, { timeout: 5_000 });
    assert.match(prompt.messages[0].content.text, /Request: Check exact fit/);
    assert.match(prompt.messages[0].content.text, /Subject: Packed Product Variant/);

    const plan = await client.callTool({
      name: "create_research_plan",
      arguments: { skill: "product-research", request: "Check exact fit", subject: "Packed Product Variant" },
    }, undefined, { timeout: 5_000 });
    assert.notEqual(plan.isError, true, JSON.stringify(plan.content));
    assert.equal(plan.structuredContent.skillResourceUri, "northcinder://research/product");
    assert.equal(plan.structuredContent.limits.maxQueries, 8);

    const search = await client.callTool(
      { name: "search_products", arguments: { text: "black wool running shoes", maxResults: 5 } },
      undefined,
      { timeout: 10_000 },
    );
    assert.notEqual(search.isError, true, JSON.stringify(search.content));
    const structured = search.structuredContent;
    assert.ok(structured && typeof structured === "object");
    assert.deepEqual(structured.results, []);
    assert.deepEqual(structured.discoveryState.researchResourceUris, ["northcinder://research/product"]);
    assert.deepEqual(
      [...structured.registeredStores].sort(),
      ["amazon", "ebay", "etsy", "shopify", "woocommerce"],
    );
    assert.equal(structured.storeStatuses.length, 5);
    assert.equal(
      structured.storeStatuses.every((status) => status.ok === false && status.error?.code === "not_configured"),
      true,
      JSON.stringify(structured.storeStatuses),
    );
    assert.doesNotMatch(JSON.stringify(search), /service_unreachable|unauthorized/);
    assert.doesNotMatch(stderrText, new RegExp(configDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    await withDeadline(client.close(), 5_000, "MCP transport close");
    client = undefined;
    const exit = await withDeadline(childExit, 5_000, `packed child ${child.pid} exit`);
    assert.deepEqual(exit, { code: 0, signal: null }, `stderr=${stderrText}`);
  } finally {
    if (client) await client.close().catch(() => {});
    else if (transport) await transport.close().catch(() => {});
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("packed init retains an explicit XDG config root for its emitted MCP child", { timeout: 30_000 }, async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "northcinder-packed-xdg-runtime-"));
  const xdgConfigHome = join(tempRoot, "xdg-config");
  const unrelatedHome = join(tempRoot, "unrelated-home");
  const legacyDir = join(unrelatedHome, ".config", "brier");
  mkdirSync(xdgConfigHome, { recursive: true, mode: 0o700 });
  mkdirSync(legacyDir, { recursive: true, mode: 0o700 });

  let client;
  let transport;
  let stderrText = "";
  try {
    const pack = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", tempRoot, "--json"], {
      cwd: packageDir,
      encoding: "utf8",
    }))[0];
    const tarball = join(tempRoot, pack.filename);
    execFileSync("tar", ["-xzf", tarball, "-C", tempRoot]);
    const packedBin = join(tempRoot, "package", "bin", "northcinder.js");
    const initOutput = execFileSync(
      process.execPath,
      [packedBin, "init", "--non-interactive", "--mode", "local"],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: unrelatedHome, XDG_CONFIG_HOME: xdgConfigHome },
        timeout: 10_000,
      },
    );
    const jsonStart = initOutput.indexOf("{");
    const jsonEnd = initOutput.indexOf("\nDiscovery sources:");
    assert.notEqual(jsonStart, -1, initOutput);
    assert.notEqual(jsonEnd, -1, initOutput);
    const entry = JSON.parse(initOutput.slice(jsonStart, jsonEnd)).mcpServers.northcinder;
    assert.equal(entry.env.NORTHCINDER_CONFIG_DIR, join(xdgConfigHome, "northcinder"));
    assert.equal(entry.env.XDG_CONFIG_HOME, xdgConfigHome);

    const entryWithoutXdg = { ...entry.env };
    delete entryWithoutXdg.XDG_CONFIG_HOME;
    const splitGuard = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { resolveConfigDir } from ${JSON.stringify(new URL("../../packages/protocol/dist/config-dir.js", import.meta.url).href)}; resolveConfigDir(process.env);`,
      ],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: unrelatedHome, ...entryWithoutXdg },
      },
    );
    assert.equal(splitGuard.status, 1, splitGuard.stderr);
    assert.match(splitGuard.stderr, /refusing to split legacy state/);
    const childWithoutXdg = spawnSync(entry.command, entry.args, {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: unrelatedHome, ...entryWithoutXdg },
      timeout: 2_000,
    });
    assert.equal(
      childWithoutXdg.status,
      1,
      `stderr=${childWithoutXdg.stderr}; signal=${childWithoutXdg.signal}; error=${childWithoutXdg.error?.code}`,
    );
    assert.equal(
      childWithoutXdg.stderr,
      "[NorthCinder-mcp] fatal: startup failed; check buyer-local configuration\n",
    );

    client = new Client({ name: "northcinder-packed-xdg-runtime-test", version: "0.0.1" });
    transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      env: { HOME: unrelatedHome, ...entry.env },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => { stderrText += String(chunk); });
    try {
      await client.connect(transport, { timeout: 10_000 });
    } catch (error) {
      throw new Error(`packed XDG MCP initialize failed: ${error instanceof Error ? error.message : String(error)}; stderr=${stderrText}`);
    }
    const listed = await client.listTools(undefined, { timeout: 5_000 });
    assert.equal(listed.tools.some((tool) => tool.name === "search_products"), true);
    await withDeadline(client.close(), 5_000, "XDG MCP transport close");
    client = undefined;
  } finally {
    if (client) await client.close().catch(() => {});
    else if (transport) await transport.close().catch(() => {});
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
