import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

export interface RecordedCall {
  host: string;
  tool: string;
  args: unknown;
  headers: Record<string, string>;
}

/**
 * Fake fetch replaying the CAPTURED live storefront-MCP responses (recorded
 * 2026-07-04 from the real endpoints — see scripts/live-check.mjs). Routes by
 * (host, MCP tool name).
 */
export function createFixtureFetch(
  routes: Record<string, string>, // "host tool" -> fixture file
  calls: RecordedCall[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      method?: string;
      params?: { name?: string; arguments?: unknown };
    };
    const tool = body.params?.name ?? body.method ?? "?";
    calls.push({
      host: url.host,
      tool,
      args: body.params?.arguments,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const fixture = routes[`${url.host} ${tool}`];
    if (!fixture) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: `no fixture for ${url.host} ${tool}` } }), { status: 200 });
    }
    return new Response(loadFixture(fixture), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
