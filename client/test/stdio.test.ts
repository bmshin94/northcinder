/**
 * REAL stdio handshake (stdio acceptance): spawn the actual server entry
 * point as a child process and speak MCP to it with the SDK's client +
 * StdioClientTransport. Offline-safe: only tools/list plus a tools/call that
 * fails structurally before any network I/O.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("northcinder MCP server — real stdio transport", () => {
  let client: Client;
  let configDir: string;
  let stderrText = "";

  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), "northcinder-stdio-"));
    client = new Client({ name: "stdio-test-host", version: "0.0.1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(CLIENT_DIR, "src", "main.ts")],
      env: {
        ...process.env,
        NORTHCINDER_SERVICE_URL: "http://127.0.0.1:9", // discard port — never answers
        NORTHCINDER_CLIENT_KEY: "stdio-test-key-0123456789",
        NORTHCINDER_CONFIG_DIR: configDir,
        HOME: configDir,
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk) => { stderrText += String(chunk); });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it("completes the MCP handshake and lists all twenty-one tools with input schemas over stdio", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "approve_purchase",
      "cancel_watch",
      "complete_checkout",
      "create_research_plan",
      "create_watch",
      "decline_purchase",
      "get_buyers_brief",
      "get_order",
      "get_profile",
      "get_trust_signal",
      "import_order",
      "list_orders",
      "list_watches",
      "record_feedback",
      "record_order_outcome",
      "request_purchase_authorization",
      "review_preference_proposal",
      "search_products",
      "submit_browser_observations",
      "submit_decision_evidence",
      "update_profile",
    ]);
    const search = tools.find((t) => t.name === "search_products")!;
    expect(search.inputSchema.type).toBe("object");
    expect((search.inputSchema.properties as Record<string, unknown>).text).toBeDefined();
    expect(stderrText).not.toContain(configDir);
    expect(stderrText).not.toContain("http://127.0.0.1:9");
  });

  it("round-trips a tools/call over stdio (structured unknown_offer error, no network)", async () => {
    const result = await client.callTool({
      name: "request_purchase_authorization",
      arguments: { offerId: "no-such-offer", intent: "x" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("unknown_offer");
  });
});
