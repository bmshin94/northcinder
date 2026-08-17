/**
 * The optional self-hosted, read-only NorthCinder MCP bridge, exposed over
 * Streamable HTTP for clients that cannot run a local stdio process. The
 * person deploying it owns the process and keys; there is no NorthCinder-operated endpoint.
 *
 * Deliberately NARROWER than client/src/server.ts (the stdio client): exactly
 * two tools, both read-only —
 *   - search_products: criteria search, neutrality-ranked, with the buyer brief
 *     buyer's brief and the profile interpretation echo (this variant is
 *     STATELESS v1 — there is no per-user profile store on this shared host,
 *     so the interpretation echo always shows "nothing applied").
 *   - get_trust_signal: merchant trust lookup.
 *
 * NO authorization/checkout/watch/profile/orders tools exist here — there is
 * no code path from this server to a purchase, a mandate, or a checkout rail
 * (safety contract law: no unattended checkout anywhere). This is enforced structurally
 * (the tools are simply never registered), and remote/test/mcp-server.test.ts
 * asserts their absence architecturally, the same way watch asserts local
 * checkout-tool absence from watch-only surfaces.
 *
 * Because each HTTP request in the Streamable-HTTP *stateless* transport mode
 * gets a fresh McpServer + transport (see src/http-server.ts), there is no
 * cross-call session memory: get_trust_signal takes a full `merchant` object
 * (as returned by search_products in the SAME tool-call response) rather than
 * a session-remembered merchantId.
 *
 * Neutrality-proof loop (ranking verification): this server calls the SAME buyer-run engine the
 * stdio client calls, over the SAME NorthCinderServiceClient HTTP contract, and
 * re-runs verifySearchRanking over the engine's own inputs exactly like the
 * stdio client does — the remote bridge does not get to skip the honesty
 * that the local client is held to.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  BuyersBriefSchema,
  InterpretedQuerySchema,
  MerchantSchema,
  RankedResultSchema,
  SearchQuerySchema,
  StoreStatusSchema,
  TrustSignalSchema,
  verifySearchRanking,
} from "@northcinder/protocol";
import { composeBuyersBrief, renderBriefMarkdown } from "@northcinder/brief";
import { interpretQuery } from "@northcinder/profile";
import type { NorthCinderServiceClient } from "./service-client.js";

export const NORTHCINDER_REMOTE_MCP_SERVER_NAME = "northcinder-remote";
export const NORTHCINDER_REMOTE_MCP_SERVER_VERSION = "0.1.0";

export interface NorthCinderRemoteMcpServerDeps {
  service: NorthCinderServiceClient;
}

interface ToolFailure {
  code: string;
  message: string;
  [k: string]: unknown;
}

function failure(error: ToolFailure) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error }, null, 2) }],
    isError: true,
  };
}

function success(structured: Record<string, unknown>, text?: string) {
  return {
    content: [{ type: "text" as const, text: text ?? JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

/**
 * Sanitize an upstream-service error before it reaches an authenticated
 * third-party MCP client on this PUBLIC bridge.
 *
 * `service-client.ts` (mirrored from the trusted local stdio client, where
 * this detail is fine) builds `service_unreachable` messages containing the
 * real `NORTHCINDER_SERVICE_URL` + path, and `service_error`/HTTP-error messages
 * that can echo up to 200 chars of the upstream response body. Neither
 * infra topology nor upstream internals should ever reach an arbitrary
 * API-key holder — do not log the detail either, because production log
 * access is broader than the upstream credential boundary; return a generic,
 * bounded message. Every other error code (invalid_query, invalid_merchant,
 * invalid_service_response, …) is already safe to pass through verbatim —
 * those messages describe the caller's OWN input or a schema mismatch, not
 * upstream infra.
 */
function sanitizeServiceError(error: ToolFailure): ToolFailure {
  const isUnreachable = error.code === "service_unreachable";
  const isUpstreamHttpError = error.message.startsWith("service HTTP ");
  if (!isUnreachable && !isUpstreamHttpError) return error;
  console.error(`[northcinder-remote] upstream error suppressed from client response (${error.code})`);
  return {
    code: error.code,
    message: isUnreachable ? "configured engine unavailable" : "configured engine error",
  };
}

function money(m: { amount: number; currency: string }): string {
  return `${(m.amount / 100).toFixed(2)} ${m.currency}`;
}

/**
 * Verify that the service accounted for every adapter it says is registered.
 * Keep this consumer-local rather than trusting the local client package: the
 * self-hosted bridge is independently deployable and must not silently bless an
 * omitted (or duplicated) store status.
 */
function verifyStoreCoverage(registeredStores: readonly string[] | undefined, statuses: readonly { store: string }[]) {
  if (registeredStores === undefined) return { verified: "not_applicable" as const, missing: [], unexpected: [] };
  const registered = new Set(registeredStores);
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status.store, (counts.get(status.store) ?? 0) + 1);
  const missing = [...registered].filter((store) => !counts.has(store)).sort();
  const unexpected = [...counts.keys()].filter((store) => !registered.has(store) || (counts.get(store) ?? 0) !== 1).sort();
  return { verified: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

export function createNorthCinderRemoteMcpServer(deps: NorthCinderRemoteMcpServerDeps): McpServer {
  const server = new McpServer({ name: NORTHCINDER_REMOTE_MCP_SERVER_NAME, version: NORTHCINDER_REMOTE_MCP_SERVER_VERSION });

  // ---------------------------------------------------------------- search
  server.registerTool(
    "search_products",
    {
      title: "Search products (neutrally ranked) — self-hosted read-only bridge",
      description:
        "Search for products across the configured stores and get back offers ranked ONLY by the buyer's " +
        "criteria (price, spec match, delivery, availability, merchant trust, ethics). No seller can pay for " +
        "position: sponsored listings are always labeled and ranked below every organic result. Every response " +
        "is verified locally by this bridge: it re-runs the OPEN rankOffers over the returned offers + trust " +
        "signals and compares orders — `rankingVerified` reports the outcome. `interpretedQuery` echoes exactly " +
        "how the query was read; this self-hosted bridge is STATELESS (no saved profile), so it always shows the " +
        "query criteria with nothing merged in from a profile. `brief` is the buyer's brief (buyer brief): ≤5 finalists " +
        "with whyThis, computed tradeoffs, per-cell provenance, a rejected appendix, and per-store coverage. " +
        "This is a READ-ONLY bridge: it has no authorization, approval, checkout, watch, or profile tools — " +
        "purchasing requires the full northcinder client.",
      inputSchema: {
        text: z.string().min(1).describe("what to buy, in plain language"),
        maxPrice: z
          .object({
            amount: z.int().nonnegative().describe("budget ceiling in MINOR units (cents)"),
            currency: z.string().regex(/^[A-Z]{3}$/).describe("ISO-4217 code, e.g. USD"),
          })
          .optional(),
        mustHaveAttributes: z.array(z.string().min(1)).optional().describe("attributes the product must have"),
        deliveryBy: z.iso.date().optional().describe("latest acceptable delivery date (ISO 8601 date)"),
        ethicsFlags: z.array(z.string().min(1)).optional().describe('buyer ethics preferences, e.g. "fair-trade"'),
        maxResults: z.int().positive().max(100).optional().describe("soft cap on results per store"),
      },
      outputSchema: {
        results: z.array(RankedResultSchema),
        storeStatuses: z.array(StoreStatusSchema),
        registeredStores: z.array(z.string()).optional(),
        interpretedQuery: InterpretedQuerySchema,
        trustSignals: z.record(z.string(), TrustSignalSchema).optional(),
        brief: BuyersBriefSchema,
        rankingVerified: z.union([z.boolean(), z.literal("not_applicable")]),
        coverageVerified: z.union([z.boolean(), z.literal("not_applicable")]),
        coverageMissing: z.array(z.string()),
        coverageUnexpected: z.array(z.string()),
        rankingDivergences: z
          .array(
            z.object({
              kind: z.enum(["order_mismatch", "score_mismatch", "reasons_mismatch"]),
              position: z.int().positive(),
              expected: z.object({ offerKey: z.string(), score: z.number() }),
              actual: z.object({ offerKey: z.string(), score: z.number() }),
            }),
          )
          .optional(),
      },
    },
    async (args) => {
      const parsed = SearchQuerySchema.safeParse(args);
      if (!parsed.success) {
        return failure({ code: "invalid_query", message: parsed.error.issues[0]?.message ?? "invalid search criteria" });
      }
      // Stateless v1: no profile store on this shared host — the
      // interpretation echo is run over zero profile entries, so it always
      // reports the query verbatim with nothing applied/overridden.
      const interpreted = interpretQuery(parsed.data, []);
      const query = interpreted.criteria;
      const result = await deps.service.search(query);
      if (!result.ok) return failure(sanitizeServiceError(result.error));

      const { results, storeStatuses, trustSignals, registeredStores } = result.data;

      // client-side ranking verification: re-run the OPEN ranking over the service's
      // own inputs and diff, exactly like the stdio client does.
      const verification = verifySearchRanking(result.data, query);
      const coverage = verifyStoreCoverage(registeredStores, storeStatuses);

      const searchId = "stateless"; // no session to bind a real searchId to
      const brief = composeBuyersBrief({
        searchId,
        results,
        interpretedQuery: interpreted,
        storeStatuses,
        trustSignals,
      });

      const statusLines = storeStatuses
        .map((s) =>
          s.ok
            ? `  ✓ ${s.store}: ${s.offerCount} offer(s) in ${s.durationMs}ms`
            : `  ✗ ${s.store}: ${s.error.code} — ${s.error.message}`,
        )
        .join("\n");
      const verificationLine =
        verification.verified === true
          ? `Ranking verified: recomputation matches the configured engine's order, scores and reasons.`
          : verification.verified === "not_applicable"
            ? `Ranking verification not applicable: ${verification.reason}`
            : `⚠️ RANKING VERIFICATION FAILED — the configured engine's order does not match the open recomputation. Treat this ordering as untrusted.`;
      const coverageLine =
        coverage.verified === true
          ? "Store coverage verified: every registered store has exactly one status."
          : coverage.verified === "not_applicable"
            ? "Store coverage verification not applicable: the configured engine did not enumerate registered stores."
            : `⚠️ STORE COVERAGE VERIFICATION FAILED — missing: ${coverage.missing.join(", ") || "none"}; unexpected/duplicate: ${coverage.unexpected.join(", ") || "none"}.`;
      const text = [
        `${results.length} offer(s), ranked by the given criteria only (sponsored always labeled + last).`,
        verificationLine,
        coverageLine,
        ``,
        `Store statuses:`,
        statusLines,
        ``,
        renderBriefMarkdown(brief),
      ].join("\n");

      return success(
        {
          results,
          storeStatuses,
          interpretedQuery: interpreted,
          ...(trustSignals !== undefined ? { trustSignals } : {}),
          ...(registeredStores !== undefined ? { registeredStores } : {}),
          brief,
          rankingVerified: verification.verified,
          coverageVerified: coverage.verified,
          coverageMissing: coverage.missing,
          coverageUnexpected: coverage.unexpected,
          ...(verification.verified === false ? { rankingDivergences: verification.divergences } : {}),
        },
        text,
      );
    },
  );

  // ----------------------------------------------------------------- trust
  server.registerTool(
    "get_trust_signal",
    {
      title: "Merchant trust signal — self-hosted read-only bridge",
      description:
        "Get the trust signal (trusted | known | unknown | flagged) with evidence for a merchant. Pass the full " +
        "`merchant` object as returned inline by search_products (this stateless bridge has no session to look " +
        "up a bare merchantId across calls). Unknown merchants are flagged as unknown WITH the reason.",
      inputSchema: {
        merchant: MerchantSchema.describe("full merchant object, e.g. from a search_products result in the same call"),
      },
      outputSchema: TrustSignalSchema.shape,
    },
    async (args) => {
      const parsed = MerchantSchema.safeParse(args.merchant);
      if (!parsed.success) {
        return failure({
          code: "invalid_merchant",
          message: "pass a full `merchant` object (this stateless bridge cannot resolve a bare merchantId across calls)",
        });
      }
      const result = await deps.service.trust(parsed.data);
      if (!result.ok) return failure(sanitizeServiceError(result.error));
      return success(result.data, `${parsed.data.name}: ${result.data.level} — ${result.data.evidence.map((e) => e.detail).join("; ")}`);
    },
  );

  return server;
}

// Re-exported for callers that want to render the trust-signal money helper
// consistently with the local client's formatting.
export { money };
