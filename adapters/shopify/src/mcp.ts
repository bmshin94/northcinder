import { fetchWithBudget } from "@northcinder/adapter-kit";

/**
 * Minimal MCP-over-HTTP JSON-RPC client for Shopify's catalog endpoints.
 * Resolves with a discriminated result — never throws.
 */
export type McpCallResult =
  | { ok: true; payload: unknown }
  | { ok: false; kind: "timeout" | "network" | "invalid_response"; detail: string }
  | { ok: false; kind: "rpc"; detail: string; rpcCode?: string | number }
  | { ok: false; kind: "http"; detail: string; status: number; retryAfterMs?: number };

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
    return {
      ok: false,
      kind: "http",
      detail: `HTTP ${result.status} from ${new URL(url).host}`,
      status: result.status,
      ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
    };
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(result.bodyText);
  } catch {
    return { ok: false, kind: "invalid_response", detail: "response is not JSON" };
  }
  const rpc = envelope as {
    error?: { code?: unknown; message?: string };
    result?: { isError?: boolean; structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> };
  };
  if (rpc.error) {
    const code = rpc.error.code;
    const rpcCode =
      typeof code === "number" && Number.isFinite(code)
        ? code
        : typeof code === "string" && /^[a-zA-Z0-9_.:-]{1,64}$/.test(code)
          ? code
          : undefined;
    return {
      ok: false,
      kind: "rpc",
      detail: "catalog RPC request failed",
      ...(rpcCode !== undefined ? { rpcCode } : {}),
    };
  }
  // UCP endpoints return the payload as result.structuredContent. Historical
  // offline fixtures may still carry JSON in a text content part.
  if (rpc.result?.structuredContent !== undefined && rpc.result.isError !== true) {
    return { ok: true, payload: rpc.result.structuredContent };
  }
  const text = rpc.result?.content?.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") {
    return { ok: false, kind: "invalid_response", detail: "MCP result carries no structured or text content" };
  }
  if (rpc.result?.isError) return { ok: false, kind: "rpc", detail: "catalog tool returned an error" };
  try {
    return { ok: true, payload: JSON.parse(text) };
  } catch {
    return { ok: false, kind: "invalid_response", detail: "MCP tool text payload is not JSON" };
  }
}
