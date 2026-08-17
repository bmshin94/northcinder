import { fetchWithBudget } from "@northcinder/adapter-kit";

/**
 * Minimal MCP-over-HTTP JSON-RPC client for Shopify's catalog endpoints.
 * Resolves with a discriminated result — never throws.
 */
export type McpCallResult =
  | { ok: true; payload: unknown }
  | { ok: false; kind: "timeout" | "network" | "http" | "rpc" | "invalid_response"; detail: string };

export interface McpCallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

let rpcId = 0;

export async function callMcpTool(
  url: string,
  tool: string,
  args: Record<string, unknown>,
  options: McpCallOptions,
): Promise<McpCallResult> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: ++rpcId,
    method: "tools/call",
    params: { name: tool, arguments: args },
  });
  const result = await fetchWithBudget(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...options.headers },
      body,
    },
    {
      timeoutMs: options.timeoutMs,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    },
  );
  if (!result.ok) {
    if (result.kind === "timeout") return { ok: false, kind: "timeout", detail: `MCP call ${tool} timed out` };
    if (result.kind === "too_large") return { ok: false, kind: "invalid_response", detail: "response exceeded body cap" };
    return { ok: false, kind: "network", detail: `network failure calling ${tool}` };
  }
  if (result.status !== 200) {
    return { ok: false, kind: "http", detail: `HTTP ${result.status} from ${new URL(url).host}` };
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(result.bodyText);
  } catch {
    return { ok: false, kind: "invalid_response", detail: "response is not JSON" };
  }
  const rpc = envelope as {
    error?: { message?: string };
    result?: { isError?: boolean; structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> };
  };
  if (rpc.error) return { ok: false, kind: "rpc", detail: rpc.error.message ?? "JSON-RPC error" };
  // UCP endpoints (live-verified 2026-07-11) return the payload as
  // result.structuredContent; the legacy storefront /api/mcp tools return it
  // as JSON inside a text content part. Accept both.
  if (rpc.result?.structuredContent !== undefined && rpc.result.isError !== true) {
    return { ok: true, payload: rpc.result.structuredContent };
  }
  const text = rpc.result?.content?.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") {
    return { ok: false, kind: "invalid_response", detail: "MCP result carries no structured or text content" };
  }
  if (rpc.result?.isError) return { ok: false, kind: "rpc", detail: text.slice(0, 300) };
  try {
    return { ok: true, payload: JSON.parse(text) };
  } catch {
    return { ok: false, kind: "invalid_response", detail: "MCP tool text payload is not JSON" };
  }
}
