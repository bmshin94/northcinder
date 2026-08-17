#!/usr/bin/env node
/**
 * `northcinder` bin dispatcher (packaging packaging): `northcinder init [...]` runs the setup
 * wizard; anything else (including no args) starts the stdio MCP server —
 * this is the entry point registered with `npx northcinder` or an MCP host.
 * The pre-existing `northcinder-mcp` bin is kept pointed straight at main.js for
 * anyone already wired to that name (docs, mcpServers configs).
 */
import { BRAND_NAME } from "./brand.js";

const subcommand = process.argv[2];

if (subcommand === "init") {
  const { main } = await import("./init-main.js");
  main(process.argv.slice(3)).catch((err: unknown) => {
    process.stderr.write(`[${BRAND_NAME} init] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
} else {
  await import("./main.js");
}
