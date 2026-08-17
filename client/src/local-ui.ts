/**
 * local UI — the minimal local interface: ONE Hono server on 127.0.0.1 hosting
 * both thin surfaces:
 *
 *   /approve/<authId>?t=<token>   the approval page — renders the FULL
 *                                 four-tuple (via the SAME renderOrderTuple
 *                                 as the banner/code file) + the issuance
 *                                 order fingerprint, and approves through the
 *                                 SAME store.approve() gate the MCP tool uses
 *                                 ("one gate, two doors"). Decline is equally
 *                                 prominent and voids via store.decline().
 *   /dashboard?t=<token>          profile editor (stated CRUD; inferred
 *                                 entries visibly distinct, deletable),
 *                                 watches (list/cancel), audit browser
 *                                 (paged, read-only), orders (persisted
 *                                 checkout records).
 *
 * Security contract (safety contract + local UI brief):
 *   - binds to 127.0.0.1 only; never 0.0.0.0.
 *   - a RANDOM PER-BOOT session token gates EVERY route — reads AND
 *     mutations. The token travels only in URLs this server itself emits
 *     through buyer-local channels (code file or ntfy push) — NEVER in tool
 *     results.
 *   - no CORS headers of any kind (OpenMemory's mistake); a strict CSP,
 *     Referrer-Policy: no-referrer (the token lives in the URL), and
 *     Cache-Control: no-store on every response.
 *   - server-rendered HTML, zero JavaScript — the whole surface is auditable
 *     by reading this one file.
 *
 * The page door submits the CODE from the owner's local code file: the server
 * holds no separate approval credential, so the page
 * cannot approve anything the code channels didn't already authorize, and
 * store.approve()'s single-shot state makes double-approval via both doors
 * structurally impossible.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { ProfileEntryInputSchema, type ProfileEntry, type ProfileEntryInput, type Money, type Order } from "@northcinder/protocol";
import type { ProfileStore } from "@northcinder/profile";
import type { WatchStore } from "@northcinder/watches";
import type { NtfyMessage } from "@northcinder/watches";
import type { Watch } from "@northcinder/protocol";
import type { OrderGraphStore } from "@northcinder/orders";
import type { OrderRecord } from "@northcinder/checkout";
import { readAuditPage, type AuditLog } from "./audit-log.js";
import type { ApprovalRequestEvent, AuthorizationStore } from "./authorization.js";
import { BRAND_NAME } from "./brand.js";
import { formatMoney, renderOrderTuple } from "./order-tuple.js";
import type { OrderStore } from "./order-store.js";

export const DASHBOARD_TABS = ["profile", "watches", "audit", "orders"] as const;
export type DashboardTab = (typeof DASHBOARD_TABS)[number];

export interface LocalUiDeps {
  /** Random per-boot session token — see generateSessionToken(). */
  sessionToken: string;
  authorizations: AuthorizationStore;
  audit: AuditLog;
  profile?: ProfileStore;
  watches?: WatchStore;
  orders?: OrderStore;
  /** The merged post-purchase order graph (order graph): checkout orders + deterministically parsed order/shipping/return emails. Optional: without it, the orders tab shows checkout orders only (local UI behavior). */
  orderGraph?: OrderGraphStore;
  /** Injectable only for deterministic boundary verification; production uses the bounded audit reader. */
  readAuditPage?: typeof readAuditPage;
}

/** Random per-boot session token (256 bits, URL-safe). */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The ntfy approval push (contract: approval URL + fingerprint — deliberately
 * NOT the code; pushing the secret through a third-party relay would widen
 * the trust boundary. The ntfy topic itself is a bearer secret — anyone who
 * learns it receives these URLs — so it lives only in local 0600 config).
 */
export function composeApprovalPush(event: ApprovalRequestEvent): NtfyMessage {
  const body = [
    event.intent,
    `Order fingerprint ${event.fingerprint} — cross-check it on the approval page before approving.`,
    ...(event.approvalUrl !== undefined ? [`Review and approve/decline: ${event.approvalUrl}`] : []),
    `Expires ${event.expiresAt}. Your one-time confirmation code is on the ${BRAND_NAME} console / code file — never in this push.`,
  ].join("\n");
  return {
    title: `${BRAND_NAME}: purchase approval requested`,
    body,
    ...(event.approvalUrl !== undefined ? { clickUrl: event.approvalUrl } : {}),
    tags: "lock",
    priority: "high",
  };
}

// ---------------------------------------------------------------- rendering

/** HTML-escape every dynamic value — no exceptions. */
function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Warm paper canvas, hairline structure (never card chrome for dense data),
 * tabular-mono numerals/codes, color-only-points (a single --verified accent
 * that POINTS at what's trusted, never decorates), status-dot-not-pill,
 * symmetric confirm/decline. Light + dark via prefers-color-scheme — no JS.
 * Fonts are the system UI/mono stacks only (no external font requests —
 * the strict `default-src 'none'` CSP intentionally forbids any network
 * fetch from this page).
 */
const STYLE = `
  :root {
    color-scheme: light dark;
    --paper: #FBFAF7;
    --ink: #1A1A17;
    --ink-2: #57544C;
    --line: #E6E2D9;
    --surface: #FFFFFF;
    --verified: #1F7A5C;
    --verified-tint: #E7F1EC;
    --flag: #9C4A1C;
    --flag-tint: #F5E9E0;
    --danger: #A83232;
    --rail-w: 216px;
    --topbar-h: 56px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #14140F;
      --ink: #F2EFE7;
      --ink-2: #A6A296;
      --line: #2A2A22;
      --surface: #1B1B14;
      --verified: #4FB48C;
      --verified-tint: #1C2E27;
      --flag: #D98A5C;
      --flag-tint: #2E241B;
      --danger: #D97A7A;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--paper);
    color: var(--ink);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-variant-numeric: tabular-nums; }
  .eyebrow { font-family: ui-monospace, monospace; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-2); }

  /* ---------- top bar + left nav rail (dashboard) ---------- */
  .topbar { height: var(--topbar-h); display: flex; align-items: center; justify-content: space-between; padding: 0 20px; border-bottom: 1px solid var(--line); background: var(--paper); position: sticky; top: 0; }
  .brand { display: flex; align-items: center; gap: 9px; }
  .brand svg { display: block; color: var(--verified); }
  .brand-word { font-weight: 700; font-size: 15px; letter-spacing: -0.01em; }
  .status-chip { display: flex; align-items: center; gap: 14px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .dot.verified, .dot.active { background: var(--verified); }
  .dot.cancelled { background: var(--ink-2); }
  .dot.expired { background: var(--flag); }
  .status-label { font-size: 12.5px; color: var(--ink-2); }
  .status-label strong { color: var(--ink); font-weight: 600; }
  .config-path { font-size: 11.5px; color: var(--ink-2); }

  .shell { display: flex; min-height: calc(100vh - var(--topbar-h)); }
  .rail { width: var(--rail-w); flex-shrink: 0; border-right: 1px solid var(--line); padding: 20px 0; }
  .rail-group { padding: 0 12px; }
  .rail a { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 12px; margin-bottom: 2px; border-radius: 6px; text-decoration: none; color: var(--ink-2); font-size: 13.5px; font-weight: 500; }
  .rail a svg { flex-shrink: 0; opacity: 0.75; }
  .rail a.active { background: var(--verified-tint); color: var(--verified); font-weight: 600; }
  .rail a.active svg { opacity: 1; }
  .rail a:not(.active):hover { background: var(--surface); color: var(--ink); }

  .main { flex: 1; min-width: 0; width: 100%; padding: 28px 32px 64px; }
  .surface-title { font-size: 20px; font-weight: 700; margin: 0 0 4px; letter-spacing: -0.01em; }
  .surface-sub { color: var(--ink-2); font-size: 13px; margin: 0 0 24px; max-width: 62ch; }

  /* ---------- hairline ledger table (audit/watches/orders/profile) ---------- */
  table.ledger { border-collapse: collapse; width: 100%; font-size: 13px; margin: 0 0 8px; }
  table.ledger th { text-align: left; font-family: ui-monospace, monospace; font-size: 10.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-2); padding: 0 10px 8px; border-bottom: 1px solid var(--line); }
  table.ledger td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  table.ledger tr:last-child td { border-bottom: none; }
  .fingerprint { font-family: ui-monospace, monospace; font-size: 22px; font-weight: 700; letter-spacing: 0.04em; }
  .badge { display: inline-flex; align-items: center; gap: 5px; font-family: ui-monospace, monospace; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; padding: 1px 6px; border-radius: 3px; }
  .badge.inferred { color: var(--flag); background: var(--flag-tint); }
  .badge.stated { color: var(--verified); background: var(--verified-tint); }

  .code-field { width: 100%; margin: 22px 0 0; display: flex; flex-direction: column; gap: 8px; }
  .code-help { margin: 0; color: var(--ink-2); font-size: 11.5px; }
  .actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 12px 0 4px; align-items: stretch; }
  .actions form { margin: 0; }
  .actions button { height: 100%; }
  button { min-height: 44px; font: inherit; padding: 7px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer; }
  button.approve, button.decline { width: 100%; font-weight: 600; font-size: 13.5px; padding: 12px 16px; border-radius: 7px; }
  button.approve { background: var(--verified); color: var(--paper); border-color: var(--verified); }
  button.approve.approve-muted { background: var(--flag-tint); color: var(--flag); border-color: var(--flag); }
  button.decline { background: transparent; color: var(--danger); border-color: var(--danger); }
  .caution-band { background: var(--flag-tint); border: 1px solid var(--flag); border-radius: 6px; padding: 11px 12px; margin: 14px 0; }
  .caution-band .eyebrow { color: var(--flag); }
  .caution-band p { margin: 5px 0 0; font-size: 12px; color: var(--ink); }
  button.small { min-width: 44px; padding: 7px 10px; font-size: 11.5px; background: none; color: var(--ink-2); }
  button.small:hover { border-color: var(--danger); color: var(--danger); }
  input:not([type="checkbox"]), select { min-height: 44px; font: inherit; padding: 6px 9px; border-radius: 6px; border: 1px solid var(--line); background: var(--paper); color: var(--ink); }
  input.code-input { font-family: ui-monospace, monospace; font-size: 15px; letter-spacing: 0.08em; }
  details.addform { margin: 6px 0; }
  details.addform summary { display: flex; align-items: center; min-height: 44px; cursor: pointer; font-size: 12.5px; color: var(--verified); font-weight: 600; }
  details.addform form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 8px 0; }
  .form-field { display: flex; flex-direction: column; gap: 4px; min-width: 150px; color: var(--ink-2); font-size: 11.5px; }
  .status { font-weight: 700; }
  .muted { color: var(--ink-2); font-size: 12px; }
  .pager { display: flex; gap: 14px; margin-top: 14px; font-size: 12px; color: var(--ink-2); }
  .pager a { color: var(--verified); text-decoration: none; font-weight: 600; padding: 6px 4px; margin: -6px -4px; display: inline-block; }
  a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--verified); outline-offset: 2px; }
  .error { color: var(--danger); font-weight: 600; }
  details.json summary { cursor: pointer; color: var(--ink-2); font-size: 11.5px; }
  details.json pre { background: var(--surface); border: 1px solid var(--line); padding: 8px 10px; border-radius: 6px; font-size: 11.5px; overflow-x: auto; font-family: ui-monospace, monospace; }
  .table-wrap { width: 100%; overflow-x: auto; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      scroll-behavior: auto !important;
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }

  /* ---------- responsive: dashboard never scrolls the PAGE horizontally ---------- */
  @media (max-width: 768px) {
    .topbar { height: auto; flex-wrap: wrap; gap: 8px 16px; padding: 12px 16px; }
    .topbar > * { min-width: 0; }
    .shell { flex-direction: column; min-height: 0; }
    .rail { width: 100%; border-right: none; border-bottom: 1px solid var(--line); padding: 10px 0; overflow-x: auto; }
    .rail-group { display: flex; gap: 4px; padding: 0 12px; }
    .rail a { white-space: nowrap; margin-bottom: 0; }
    .main { padding: 20px 16px 48px; max-width: 100%; }
    .status-chip { flex-wrap: wrap; gap: 6px 12px; min-width: 0; }
    .config-path { word-break: break-all; overflow-wrap: anywhere; max-width: 100%; }
  }

  @media (max-width: 520px) {
    .table-wrap { overflow-x: visible; }
    table.ledger, table.ledger tbody { display: block; width: 100%; }
    table.ledger tr:first-child { display: none; }
    table.ledger tr:not(:first-child) { display: block; padding: 8px 0; border-bottom: 1px solid var(--line); }
    table.ledger td { display: grid; grid-template-columns: minmax(88px, 0.35fr) minmax(0, 1fr); gap: 10px; width: 100%; padding: 7px 0; border: 0; overflow-wrap: anywhere; }
    table.ledger td::before { content: attr(data-label); font-family: ui-monospace, monospace; font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-2); }
    table.ledger td[colspan] { display: block; }
    table.ledger td[colspan]::before { content: none; }
    table.ledger td form { margin: 0; }
  }

  /* ---------- approval receipt card (centered focused surface) ---------- */
  body.approval-body { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 40px 16px; }
  .field { width: 100%; max-width: 460px; }
  .brand-row { display: flex; align-items: center; gap: 8px; justify-content: center; margin-bottom: 22px; }
  .brand-row span { font-weight: 700; font-size: 14px; letter-spacing: -0.01em; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 28px 28px 24px; }
  .card h1 { font-size: 18px; font-weight: 700; margin: 0 0 3px; letter-spacing: -0.01em; }
  .card p.card-sub { color: var(--ink-2); font-size: 12.5px; margin: 0 0 20px; }

  .tuple { border-top: 1px solid var(--line); margin: 0; }
  .tuple-line { padding: 12px 0; border-bottom: 1px solid var(--line); font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; }

  .cap-line { display: flex; align-items: baseline; justify-content: space-between; margin: 16px 0 4px; padding: 11px 12px; background: var(--verified-tint); border-radius: 6px; }
  .cap-line .cap-amt { font-family: ui-monospace, monospace; font-weight: 700; font-size: 15px; color: var(--verified); }
  .cap-note { color: var(--ink-2); font-size: 11.5px; margin: 6px 0 0; }

  .match-pair { display: flex; align-items: center; justify-content: center; gap: 10px; margin: 22px 0 4px; padding: 16px 0; border-top: 1px dashed var(--line); border-bottom: 1px dashed var(--line); }
  .match-cell { text-align: center; }
  .match-cell .m-label { font-family: ui-monospace, monospace; font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-2); margin-bottom: 4px; }
  .match-sep { color: var(--line); font-size: 20px; padding-top: 12px; }
  .match-note { text-align: center; color: var(--ink-2); font-size: 11.5px; margin: 10px 0 0; }
  .decline-note { text-align: center; color: var(--ink-2); font-size: 11px; margin: 8px 0 0; }
  .footer-note { text-align: center; color: var(--ink-2); font-size: 11px; margin-top: 20px; max-width: 460px; }
  @media (max-width: 480px) {
    body.approval-body { align-items: flex-start; padding: 24px 12px; }
    .card { padding: 22px 18px 20px; }
    .actions { grid-template-columns: 1fr; }
    .cap-line { align-items: flex-start; flex-direction: column; gap: 4px; }
  }
`;

/** The one-accent brand mark (docs/brand/mark.svg): a single stroked polyline
 * that reads as BOTH an itemized-ledger bracket and a checkmark — construction
 * unchanged from the frozen mark, currentColor'd so `.brand svg { color }`
 * carries the theme's --verified accent in light and dark. */
function brandMarkSvg(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 90" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M18,72 L18,50 L42,50 L47,65 L83,19" stroke="currentColor" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

const RAIL_ICONS: Record<DashboardTab, string> = {
  profile: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="2"/><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  watches: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2"/><path d="M12 8v4l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  orders: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><rect x="4" y="3" width="16" height="18" rx="1.5" stroke="currentColor" stroke-width="2"/><path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  audit: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M4 4h16v13l-4 3H4V4z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 9h8M8 13h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};

/** Generic chrome for every non-dashboard page (approval flows + dashboard
 * mutation error pages): the centered "Verified Ledger" receipt card — the
 * one surface the direction doc calls out as correctly centered (a decision
 * moment). `footer` renders BELOW the card, matching the approved mockup. */
function layout(title: string, body: string, footer?: string): string {
  return [
    `<!doctype html>`,
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="referrer" content="no-referrer">`,
    `<title>${esc(title)} · ${esc(BRAND_NAME)}</title>`,
    `<style>${STYLE}</style></head><body class="approval-body">`,
    `<div class="field">`,
    `<div class="brand-row">${brandMarkSvg(16)}<span>${esc(BRAND_NAME)}</span></div>`,
    `<main class="card">`,
    body,
    `</main>`,
    `<p class="footer-note">${footer ?? "local, loopback-only — your data and approvals are not returned over MCP."}</p>`,
    `</div>`,
    `</body></html>`,
  ].join("\n");
}

/** Dashboard chrome: top bar (brand + verified/loopback status + config
 * path) and the left nav rail (Profile / Watches / Orders / Audit) over a
 * quiet per-tab data surface — the direction doc's explicit non-centered
 * dashboard layout (Mercury-style structure, not a centered column). */
function dashboardLayout(c: Context, tab: DashboardTab, body: string): string {
  const token = encodeURIComponent(c.req.query("t") ?? "");
  const rail = DASHBOARD_TABS.map(
    (name) =>
      `<a class="${name === tab ? "active" : ""}"${name === tab ? ' aria-current="page"' : ""} href="/dashboard?t=${token}&tab=${name}">${RAIL_ICONS[name]}${esc(name[0]!.toUpperCase() + name.slice(1))}</a>`,
  ).join("");
  return [
    `<!doctype html>`,
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="referrer" content="no-referrer">`,
    `<title>Dashboard — ${esc(tab)} · ${esc(BRAND_NAME)}</title>`,
    `<style>${STYLE}</style></head><body>`,
    `<div class="topbar">`,
    `<div class="brand">${brandMarkSvg(20)}<span class="brand-word">${esc(BRAND_NAME)}</span></div>`,
    `<div class="status-chip"><span class="config-path mono">local state</span><span class="status-label"><span class="dot verified"></span> <strong>verified</strong> · loopback-only</span></div>`,
    `</div>`,
    `<div class="shell">`,
    `<nav class="rail" aria-label="Dashboard sections"><div class="rail-group">${rail}</div></nav>`,
    `<main class="main" id="main-content">`,
    `<h1 class="surface-title">${esc(tab[0]!.toUpperCase() + tab.slice(1))}</h1>`,
    body,
    `</main>`,
    `</div>`,
    `</body></html>`,
  ].join("\n");
}

// ------------------------------------------------------------------- server

/** Modest cap on mutation POST bodies — defense-in-depth against self-DoS (this is a single-user loopback server, not an attack surface, but a stray huge body should never be entertained). */
const MUTATION_BODY_LIMIT_BYTES = 64 * 1024;

/** Applied to every mutation route, AFTER the token gate (app.use("*") above runs first). */
const mutationBodyLimit = bodyLimit({ maxSize: MUTATION_BODY_LIMIT_BYTES });

export function createLocalUiApp(deps: LocalUiDeps): Hono {
  const app = new Hono();
  const expectedTokenDigest = createHash("sha256").update(deps.sessionToken).digest();

  function tokenOk(presented: string | undefined): boolean {
    if (presented === undefined || presented.length === 0) return false;
    const digest = createHash("sha256").update(presented).digest();
    return timingSafeEqual(digest, expectedTokenDigest);
  }

  /** Token for URL/form embedding — always the caller's own validated token. */
  function t(c: Context): string {
    return c.req.query("t") ?? "";
  }

  function dashUrl(c: Context, tab: DashboardTab, page?: number): string {
    return `/dashboard?t=${encodeURIComponent(t(c))}&tab=${tab}${page !== undefined ? `&page=${page}` : ""}`;
  }

  function dashboardRecovery(c: Context, tab: DashboardTab, message: string): string {
    const label = tab[0]!.toUpperCase() + tab.slice(1);
    return [
      `<section class="recovery" role="alert">`,
      `<p class="error">${esc(message)}</p>`,
      `<p><a href="${esc(dashUrl(c, tab))}">Return to ${esc(label)}</a> and refresh before retrying. If the problem continues, rerun the source initializer.</p>`,
      `</section>`,
    ].join("\n");
  }

  function dashboardUnconfigured(c: Context, tab: DashboardTab, capability: string): string {
    return dashboardRecovery(c, tab, `No ${capability} store is configured.`);
  }

  function dashboardMutationFailure(c: Context, tab: "profile" | "watches", message: string) {
    return c.html(layout("Change not saved", `<h1>Change not saved</h1>${dashboardRecovery(c, tab, message)}`), 500);
  }

  function dashboardAuditFailure(c: Context, tab: "profile" | "watches", label: "Profile" | "Watches") {
    return c.html(
      layout(
        "Change needs review",
        [
          `<h1>Change needs review</h1>`,
          `<section class="recovery" role="alert">`,
          `<p class="error">${label} may have changed, but its audit record could not be written.</p>`,
          `<p><a href="${esc(dashUrl(c, tab))}">Refresh ${label} before trying again</a>. Do not repeat the change until you have checked its current state.</p>`,
          `</section>`,
        ].join("\n"),
      ),
      500,
    );
  }

  function approvalAuditFailure(
    c: Context,
    authorizationId: string,
    outcome: "wrong-code" | "rejected" | "approved" | "declined",
    attemptsRemaining?: number,
  ) {
    const inspectUrl = `/approve/${encodeURIComponent(authorizationId)}?t=${encodeURIComponent(t(c))}`;
    const copy = outcome === "wrong-code"
      ? {
          title: "Attempt recorded; audit record missing",
          heading: "ATTEMPT CONSUMED — AUDIT RECORD MISSING",
          result: `The wrong confirmation code was rejected. This authorization remains pending with ${attemptsRemaining ?? 0} attempts remaining.`,
          recovery: "Its rejection audit record could not be written, and the last attempt was already consumed. Inspect the authorization status before entering another code.",
          link: "Inspect authorization status",
        }
      : outcome === "rejected"
        ? {
            title: "Approval not granted; audit record missing",
            heading: "APPROVAL NOT GRANTED — AUDIT RECORD MISSING",
            result: `Authorization ${authorizationId} was not approved; its state may already be final or unavailable.`,
            recovery: "The rejection audit record could not be written. Do not submit another code; inspect the authorization status before taking any further action.",
            link: "Inspect final authorization status",
          }
        : outcome === "approved"
        ? {
            title: "Approved; audit record missing",
            heading: "APPROVED — AUDIT RECORD MISSING",
            result: `Authorization ${authorizationId} is approved and its signed mandate is live.`,
            recovery: "The approval audit record could not be written. Do not submit this approval again; inspect the final authorization status and return to your agent.",
            link: "Inspect final authorization status",
          }
        : {
            title: "Declined; audit record missing",
            heading: "DECLINED — AUDIT RECORD MISSING",
            result: `Authorization ${authorizationId} is denied and the decline is final. Nothing was purchased or charged.`,
            recovery: "The decline audit record could not be written. Do not submit this decline again; inspect the final authorization status before requesting anything new.",
            link: "Inspect final authorization status",
          };
    return c.html(
      layout(
        copy.title,
        [
          `<h1 class="status">${esc(copy.heading)}</h1>`,
          `<section class="recovery" role="alert">`,
          `<p>${esc(copy.result)}</p>`,
          `<p class="error">${esc(copy.recovery)}</p>`,
          `<p><a href="${esc(inspectUrl)}">${esc(copy.link)}</a></p>`,
          `</section>`,
        ].join("\n"),
      ),
      500,
    );
  }

  // EVERY route — reads and mutations alike — is session-token-gated, and
  // every response carries the local-surface security headers. There is
  // deliberately no CORS header of any kind: a browser page from any web
  // origin gets no cross-origin read/write grant whatsoever.
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    // Legacy-browser belt-and-suspenders alongside CSP frame-ancestors 'none'.
    c.header("X-Frame-Options", "DENY");
    if (!tokenOk(c.req.query("t"))) {
      // One uniform refusal: no hint about which routes/ids exist.
      return c.text("unauthorized", 401);
    }
    await next();
  });

  app.get("/", (c) => c.redirect(dashUrl(c, "profile")));

  // ------------------------------------------------------- approval page
  /** The receipt card: intent + the SAME renderOrderTuple lines (verbatim,
   * one full line per row — never split across markup, so the exact-line
   * security assertions hold), the hard-cap band, and the code/fingerprint
   * match pair. `footer` is the auth-id/expiry line the mockup renders
   * BELOW the card. */
  function tupleBlock(authId: string): { cardHtml: string; footer: string; status: string; noRail: boolean } | undefined {
    const auth = deps.authorizations.get(authId);
    if (!auth) return undefined;
    const fingerprint = deps.authorizations.fingerprintOf(authId) ?? "????";
    const noRail = auth.paymentContext === "none";
    const tupleLines = renderOrderTuple(auth.offer, auth.paymentContext)
      .map((line) => `<div class="tuple-line">${esc(line)}</div>`)
      .join("\n");
    const cautionBand = noRail
      ? [
          `<div class="caution-band">`,
          `<span class="eyebrow">No checkout rail configured</span>`,
          `<p>Signing this mandate will NOT result in a purchase — checkout will be refused for this merchant. You can still decline below at no cost.</p>`,
          `</div>`,
        ].join("\n")
      : "";
    const cardHtml = [
      `<p class="card-sub">${esc(auth.intent)}</p>`,
      `<div class="tuple">${tupleLines}</div>`,
      cautionBand,
      `<div class="cap-line"><span class="eyebrow">Hard spending cap</span><span class="cap-amt">${esc(formatMoney(auth.maxAmount))}</span></div>`,
      `<p class="cap-note">Checkout is refused above this amount — no exceptions, no retries at a higher price.</p>`,
      `<div class="match-pair"><div class="match-cell"><div class="m-label">Order fingerprint</div><span class="fingerprint">${esc(fingerprint)}</span></div></div>`,
      `<p class="match-note" id="fingerprint-help">The fingerprint above must MATCH the fingerprint printed next to your confirmation code. If it differs, decline.</p>`,
    ].join("\n");
    const footer = `Authorization ${esc(auth.id)} · expires ${esc(auth.expiresAt)} · loopback-only, not returned over MCP`;
    return { cardHtml, footer, status: auth.status, noRail };
  }

  app.get("/approve/:id", (c) => {
    const id = c.req.param("id");
    const block = tupleBlock(id);
    if (!block) return c.html(layout("Approval", `<h1>Not found</h1><p class="error">No such authorization.</p>`), 404);
    if (block.status !== "pending") {
      const recovery =
        block.status === "expired"
          ? `<p>This authorization expired. Return to your agent and request a new purchase authorization.</p>`
          : `<p>You can return to your agent or close this page.</p>`;
      return c.html(
        layout(
          "Purchase approval",
          `<h1>Purchase approval</h1>${block.cardHtml}<p class="status">Status: ${esc(block.status.toUpperCase())} — nothing to approve here.</p>${recovery}`,
          block.footer,
        ),
      );
    }
    const token = encodeURIComponent(t(c));
    const body = [
      `<h1>Approve this purchase?</h1>`,
      block.cardHtml,
      `<div class="code-field">`,
      `<label for="code">Confirmation code (from your ${esc(BRAND_NAME)} console or code file)</label>`,
      `<input class="code-input" id="code" name="code" form="approve-form" autocomplete="off" inputmode="text" aria-describedby="code-help fingerprint-help" placeholder="XXXX-XXXX" required>`,
      `<p class="code-help" id="code-help">Enter the one-time code only after the fingerprint matches.</p>`,
      `</div>`,
      `<div class="actions" aria-label="Authorization decision">`,
      `<form id="approve-form" method="post" action="/approve/${encodeURIComponent(id)}?t=${token}">`,
      block.noRail
        ? `<button class="approve approve-muted" type="submit">Sign anyway — no purchase will occur</button>`
        : `<button class="approve" type="submit">Approve — sign the mandate</button>`,
      `</form>`,
      `<form method="post" action="/decline/${encodeURIComponent(id)}?t=${token}">`,
      `<button class="decline" type="submit">Decline — void this authorization</button>`,
      `</form>`,
      `</div>`,
      `<p class="decline-note">Declining is always available, costs nothing, and is never penalized.</p>`,
    ].join("\n");
    return c.html(layout("Purchase approval", body, block.footer));
  });

  app.post("/approve/:id", mutationBodyLimit, async (c) => {
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    const code = typeof form.code === "string" ? form.code : "";
    // THE single gate — identical verification to the approve_purchase tool.
    const result = deps.authorizations.approve(id, code);
    if (!result.ok) {
      try {
        deps.audit.append({
          type: "authorization_denied",
          door: "approval_page",
          authorizationId: id,
          reason: result.error.code,
          message: result.error.message,
        });
      } catch {
        return approvalAuditFailure(
          c,
          id,
          result.error.code === "code_mismatch" ? "wrong-code" : "rejected",
          result.error.attemptsRemaining,
        );
      }
      const retry =
        result.error.code === "code_mismatch"
          ? `<p><a href="/approve/${encodeURIComponent(id)}?t=${encodeURIComponent(t(c))}">Try again</a> (${esc(result.error.attemptsRemaining ?? 0)} attempt(s) remaining).</p>`
          : "";
      return c.html(
        layout("Approval failed", `<h1>Not approved</h1><p class="error">${esc(result.error.message)}</p>${retry}`),
        400,
      );
    }
    const mandate = result.authorization.mandate!;
    try {
      deps.audit.append({
        type: "authorization_approved",
        door: "approval_page",
        authorizationId: result.authorization.id,
        mandateId: mandate.id,
        offerId: mandate.constraints.offerId,
        merchantId: mandate.constraints.merchantId,
        maxAmount: mandate.constraints.maxAmount,
        mandateExpiresAt: mandate.expiresAt,
      });
    } catch {
      return approvalAuditFailure(c, result.authorization.id, "approved");
    }
    return c.html(
      layout(
        "Approved",
        [
          `<h1 class="status">APPROVED</h1>`,
          `<p>Authorization ${esc(result.authorization.id)} is approved: your local key signed single-use mandate ${esc(mandate.id)} (expires ${esc(mandate.expiresAt)}).</p>`,
          `<p>Your agent can now complete checkout — it still cannot exceed the hard cap of ${esc(formatMoney(result.authorization.maxAmount))}.</p>`,
        ].join("\n"),
      ),
    );
  });

  app.post("/decline/:id", mutationBodyLimit, (c) => {
    const id = c.req.param("id");
    const result = deps.authorizations.decline(id);
    if (!result.ok) {
      return c.html(
        layout("Decline failed", `<h1>Not declined</h1><p class="error">${esc(result.error.message)}</p>`),
        result.error.code === "not_found" ? 404 : 409,
      );
    }
    try {
      deps.audit.append({
        type: "authorization_declined",
        door: "approval_page",
        authorizationId: result.authorization.id,
        offerId: result.authorization.offer.id,
        merchantId: result.authorization.offer.merchant.id,
      });
    } catch {
      return approvalAuditFailure(c, result.authorization.id, "declined");
    }
    return c.html(
      layout(
        "Declined",
        [
          `<h1 class="status">DECLINED</h1>`,
          `<p>Authorization ${esc(result.authorization.id)} is void. Nothing was purchased and nothing will be charged.</p>`,
          `<p class="muted">Declining is a normal outcome — you can request a new authorization any time.</p>`,
        ].join("\n"),
      ),
    );
  });

  // ----------------------------------------------------------- dashboard
  function profileEntryFields(e: ProfileEntry): string {
    const { id, origin, source, createdAt, kind, ...fields } = e;
    return Object.entries(fields)
      .map(([k, v]) => `${esc(k)}: ${esc(typeof v === "object" ? formatMoney(v as Money) : v)}`)
      .join(", ");
  }

  function profileRows(c: Context, entries: ProfileEntry[]): string {
    if (entries.length === 0) return `<tr><td colspan="4" class="muted">none</td></tr>`;
    return entries
      .map(
        (e) => `<tr><td data-label="Kind">${esc(e.kind)}</td><td data-label="Preference">${profileEntryFields(e)}</td><td data-label="Attribution" class="muted">${esc(e.source)} · ${esc(e.createdAt)}</td><td data-label="Action"><form method="post" action="/profile/delete?t=${encodeURIComponent(t(c))}"><input type="hidden" name="id" value="${esc(e.id)}"><button class="small" type="submit" aria-label="Delete ${esc(e.kind)} preference">Delete</button></form></td></tr>`,
      )
      .join("\n");
  }

  const ADD_FORMS: Array<{ kind: ProfileEntryInput["kind"]; label: string; fields: string }> = [
    { kind: "size", label: "Size", fields: `<label class="form-field"><span>Category</span><input name="category" placeholder="e.g. sneakers" required></label><label class="form-field"><span>Size</span><input name="value" placeholder="e.g. EU 43" required></label>` },
    { kind: "budget", label: "Budget default", fields: `<label class="form-field"><span>Category</span><input name="category" placeholder="e.g. sneakers" required></label><label class="form-field"><span>Maximum price</span><input name="amount" inputmode="decimal" placeholder="e.g. 120.00" required></label><label class="form-field"><span>Currency</span><input name="currency" placeholder="USD" size="4" maxlength="3" required></label>` },
    { kind: "brand", label: "Brand allow/deny", fields: `<label class="form-field"><span>Brand</span><input name="brand" placeholder="e.g. Allbirds" required></label><label class="form-field"><span>Stance</span><select name="stance"><option value="allow">allow</option><option value="deny">deny</option></select></label>` },
    { kind: "ethics", label: "Ethics flag", fields: `<label class="form-field"><span>Ethics flag</span><input name="flag" placeholder="e.g. fair-trade" required></label>` },
    { kind: "delivery", label: "Delivery default", fields: `<label class="form-field"><span>Maximum days</span><input name="maxDays" type="number" min="1" placeholder="e.g. 5" required></label>` },
    { kind: "notification", label: "Notification preference", fields: `<label class="form-field"><span>Event</span><input name="event" placeholder="e.g. price-drop" required></label><label><input type="checkbox" name="enabled" checked> enabled</label>` },
  ];

  function profileTab(c: Context): string {
    if (!deps.profile) return dashboardUnconfigured(c, "profile", "profile");
    const entries: ProfileEntry[] = deps.profile.list();
    const stated = entries.filter((e) => e.origin === "stated");
    const inferred = entries.filter((e) => e.origin === "inferred");
    const forms = ADD_FORMS.map(
      (f) =>
        `<details class="addform"><summary>+ ${esc(f.label)}</summary><form method="post" action="/profile/add?t=${encodeURIComponent(t(c))}"><input type="hidden" name="kind" value="${esc(f.kind)}">${f.fields}<button class="small" type="submit">Save stated preference</button></form></details>`,
    ).join("\n");
    return [
      `<h3><span class="badge stated">STATED</span> — preferences you set yourself</h3>`,
      `<div class="table-wrap"><table class="ledger"><tr><th scope="col">kind</th><th scope="col">preference</th><th scope="col">attribution</th><th scope="col">action</th></tr>${profileRows(c, stated)}</table></div>`,
      `<h4>Add a stated preference</h4>`,
      forms,
      `<h3><span class="badge inferred">INFERRED</span> — ${esc(BRAND_NAME)}'s guesses, learned from your feedback</h3>`,
      `<p class="muted">These were NOT stated by you. Delete any of them — one click, no questions.</p>`,
      `<div class="table-wrap"><table class="ledger"><tr><th scope="col">kind</th><th scope="col">preference</th><th scope="col">attribution</th><th scope="col">action</th></tr>${profileRows(c, inferred)}</table></div>`,
    ].join("\n");
  }

  function watchRow(c: Context, w: Watch): string {
    const target =
      w.target.kind === "offer"
        ? `${w.target.offer.product.title} at ${w.target.offer.merchant.name}`
        : `query "${w.target.query.text}"`;
    const last =
      w.lastCheckedAt === undefined
        ? "never checked yet"
        : `${w.lastCheckedAt}${w.lastPrice ? ` at ${formatMoney(w.lastPrice)}` : ""}`;
    const cancel =
      w.state === "active"
        ? `<form method="post" action="/watches/${encodeURIComponent(w.id)}/cancel?t=${encodeURIComponent(t(c))}"><button class="small" type="submit" aria-label="Cancel watch ${esc(w.name)}">Cancel</button></form>`
        : "";
    const dotClass = w.state === "active" ? "active" : w.state === "expired" ? "expired" : "cancelled";
    return `<tr><td data-label="State"><span class="dot ${dotClass}"></span> ${esc(w.state.toUpperCase())}</td><td data-label="Watch">${esc(w.name)}<br><span class="muted">${esc(target)}</span></td><td data-label="Target">≤ ${esc(formatMoney(w.targetPrice))}</td><td data-label="Channel">${esc(w.channel.type)}</td><td data-label="Last checked" class="muted mono">${esc(last)}</td><td data-label="Action">${cancel}</td></tr>`;
  }

  function watchesTab(c: Context): string {
    if (!deps.watches) return dashboardUnconfigured(c, "watches", "watch");
    const all: Watch[] = deps.watches.list();
    if (all.length === 0) return `<p class="muted">No price watches yet. Watches NOTIFY you — they never buy.</p>`;
    return [
      `<div class="table-wrap">`,
      `<table class="ledger"><tr><th scope="col">state</th><th scope="col">watch</th><th scope="col">target</th><th scope="col">channel</th><th scope="col">last checked</th><th scope="col">action</th></tr>`,
      ...all.map((w) => watchRow(c, w)),
      `</table>`,
      `</div>`,
    ].join("\n");
  }

  function auditTab(c: Context): string {
    const page = Number(c.req.query("page") ?? "1") || 1;
    const view = (deps.readAuditPage ?? readAuditPage)(deps.audit.path, { page });
    const rows =
      view.entries.length === 0
        ? `<tr><td colspan="3" class="muted">the audit trail is empty</td></tr>`
        : view.entries
            .map((e) => {
              const { at, type, ...rest } = e;
              return `<tr><td data-label="At" class="muted">${esc(at ?? "")}</td><td data-label="Type">${esc(type ?? "(raw)")}</td><td data-label="Details"><details class="json"><summary class="muted">details</summary><pre>${esc(JSON.stringify(rest, null, 2))}</pre></details></td></tr>`;
            })
            .join("\n");
    const pager = [
      view.page > 1 ? `<a href="${dashUrl(c, "audit", view.page - 1)}">← newer</a>` : "",
      `<span class="muted">page ${view.page} of ${view.totalPages} (${view.totalEntries} entries, newest first)</span>`,
      view.page < view.totalPages ? `<a href="${dashUrl(c, "audit", view.page + 1)}">older →</a>` : "",
    ].join(" ");
    return [
      `<div class="table-wrap"><table class="ledger"><tr><th scope="col">at</th><th scope="col">type</th><th scope="col">details</th></tr>${rows}</table></div>`,
      `<div class="pager">${pager}</div>`,
    ].join("\n");
  }

  /** Email/import-derived rows from the order graph merged order graph — shipment status + return deadline, every field escaped (store-controlled, untrusted). */
  function emailOrderRow(o: Order): string {
    const detail = deps.orderGraph!.getOrder(o.id);
    const latestShipment = detail?.shipments[detail.shipments.length - 1];
    const shipmentStatus = latestShipment ? `${latestShipment.carrier.toUpperCase()} ${latestShipment.status}` : "—";
    const returnDeadline = detail?.returnWindow?.deadline ?? "—";
    return [
      `<tr>`,
      `<td data-label="Date" class="muted">${esc(o.orderDate)}</td>`,
      `<td data-label="Order">${esc(o.orderNumber ?? o.id)}<br><span class="muted">${esc(o.merchantName)}</span></td>`,
      `<td data-label="Status" class="status">${esc(o.status)}</td>`,
      `<td data-label="Shipment">${esc(shipmentStatus)}</td>`,
      `<td data-label="Return by">${esc(returnDeadline)}</td>`,
      `<td data-label="Source" class="muted">${esc(o.source.kind)}</td>`,
      `</tr>`,
    ].join("");
  }

  function ordersTab(): string {
    const checkoutOrders = deps.orders?.list() ?? [];
    // Only the email/import-derived orders here — checkout orders are
    // rendered by the existing table below (their own richer evidence).
    const emailOrders = deps.orderGraph ? deps.orderGraph.listOrders(checkoutOrders).filter((o) => o.source.kind !== "checkout") : [];

    if (checkoutOrders.length === 0 && emailOrders.length === 0) {
      return `<p class="muted">No orders yet. Every completed or handed-off checkout lands here, along with orders recovered from order-confirmation/shipping/return-window emails.</p>`;
    }

    const checkoutTable =
      checkoutOrders.length === 0
        ? ""
        : [
            `<h3>Checkout orders</h3>`,
            `<div class="table-wrap">`,
            `<table class="ledger"><tr><th scope="col">at</th><th scope="col">order</th><th scope="col">status</th><th scope="col">rail</th><th scope="col">merchant</th><th scope="col">evidence</th></tr>`,
            ...checkoutOrders.map(
              (o) =>
                `<tr><td data-label="At" class="muted">${esc(o.createdAt)}</td><td data-label="Order">${esc(o.orderId)}<br><span class="muted">offer ${esc(o.offerId)} · mandate ${esc(o.mandateId)}</span></td><td data-label="Status" class="status">${esc(o.status)}</td><td data-label="Rail">${esc(o.railId)}</td><td data-label="Merchant">${esc(o.merchantId)}</td><td data-label="Evidence"><details class="json"><summary class="muted">details</summary><pre>${esc(JSON.stringify(o.evidence, null, 2))}</pre></details></td></tr>`,
            ),
            `</table>`,
            `</div>`,
          ].join("\n");

    const emailTable =
      emailOrders.length === 0
        ? ""
        : [
            `<h3>Orders from email</h3>`,
            `<p class="muted">Recovered from order-confirmation, shipping, delivery, and return-window emails — deterministically parsed, never model-generated.</p>`,
            `<div class="table-wrap">`,
            `<table class="ledger"><tr><th scope="col">date</th><th scope="col">order</th><th scope="col">status</th><th scope="col">shipment</th><th scope="col">return by</th><th scope="col">source</th></tr>`,
            ...emailOrders.map((o) => emailOrderRow(o)),
            `</table>`,
            `</div>`,
          ].join("\n");

    return [checkoutTable, emailTable].filter((s) => s.length > 0).join("\n");
  }

  const TAB_SUBTITLE: Record<DashboardTab, string> = {
    profile: "Preferences that steer search and ranking — what you stated yourself, and what was inferred from your feedback.",
    watches: "Notify when a target price is hit — they never buy anything.",
    orders: "Every completed or handed-off checkout, plus orders recovered from order-confirmation/shipping/return-window emails.",
    audit: "Read-only, append-only trail — every search, ranking (with reasons), authorization, approval, and checkout attempt this client ever made. Newest first.",
  };

  app.get("/dashboard", (c) => {
    const requested = c.req.query("tab");
    const tab: DashboardTab = (DASHBOARD_TABS as readonly string[]).includes(requested ?? "")
      ? (requested as DashboardTab)
      : "profile";
    let content: string;
    try {
      content = tab === "profile"
        ? profileTab(c)
        : tab === "watches"
          ? watchesTab(c)
          : tab === "audit"
            ? auditTab(c)
            : (!deps.orders && !deps.orderGraph)
              ? dashboardUnconfigured(c, "orders", "order")
              : ordersTab();
    } catch {
      const label: Record<DashboardTab, string> = { profile: "Profile", watches: "Watch", audit: "Audit", orders: "Order" };
      content = dashboardRecovery(c, tab, `${label[tab]} data could not be read safely.`);
    }
    const body = `<p class="surface-sub">${esc(TAB_SUBTITLE[tab])}</p>\n${content}`;
    return c.html(dashboardLayout(c, tab, body));
  });

  // ------------------------------------------------- dashboard mutations
  app.post("/profile/add", mutationBodyLimit, async (c) => {
    if (!deps.profile) return c.html(layout("Setup required", `<h1>Setup required</h1>${dashboardUnconfigured(c, "profile", "profile")}`), 400);
    const form = await c.req.parseBody();
    const str = (name: string): string => (typeof form[name] === "string" ? (form[name] as string) : "");
    const kind = str("kind");
    let candidate: Record<string, unknown>;
    switch (kind) {
      case "size":
        candidate = { kind, category: str("category"), value: str("value") };
        break;
      case "budget": {
        const major = Number.parseFloat(str("amount"));
        candidate = {
          kind,
          category: str("category"),
          maxPrice: { amount: Number.isFinite(major) ? Math.round(major * 100) : -1, currency: str("currency").toUpperCase() },
        };
        break;
      }
      case "brand":
        candidate = { kind, brand: str("brand"), stance: str("stance") };
        break;
      case "ethics":
        candidate = { kind, flag: str("flag") };
        break;
      case "delivery":
        candidate = { kind, maxDays: Number(str("maxDays")) };
        break;
      case "notification":
        candidate = { kind, event: str("event"), enabled: form.enabled !== undefined };
        break;
      default:
        return c.html(layout("Error", `<p class="error">Unknown preference kind.</p>`), 400);
    }
    const parsed = ProfileEntryInputSchema.safeParse(candidate);
    if (!parsed.success) {
      return c.html(
        layout("Error", `<p class="error">Invalid preference: ${esc(parsed.error.issues[0]?.message ?? "invalid")}</p>`),
        400,
      );
    }
    let entry: ProfileEntry;
    try {
      entry = deps.profile.add(parsed.data, { origin: "stated", source: "dashboard (user-edited)" });
    } catch {
      return dashboardMutationFailure(c, "profile", "Profile change could not be saved safely.");
    }
    try {
      deps.audit.append({
        type: "profile_write",
        door: "dashboard",
        added: [{ id: entry.id, kind: entry.kind, origin: entry.origin }],
      });
    } catch {
      return dashboardAuditFailure(c, "profile", "Profile");
    }
    return c.redirect(dashUrl(c, "profile"), 303);
  });

  app.post("/profile/delete", mutationBodyLimit, async (c) => {
    if (!deps.profile) return c.html(layout("Setup required", `<h1>Setup required</h1>${dashboardUnconfigured(c, "profile", "profile")}`), 400);
    const form = await c.req.parseBody();
    const id = typeof form.id === "string" ? form.id : "";
    let outcome;
    try {
      outcome = deps.profile.remove(id);
    } catch {
      return dashboardMutationFailure(c, "profile", "Profile change could not be saved safely.");
    }
    if (!outcome.removed) {
      return c.html(layout("Error", `<p class="error">No profile entry with that id.</p>`), 404);
    }
    try {
      deps.audit.append({ type: "profile_delete", door: "dashboard", deleted: [outcome.entry] });
    } catch {
      return dashboardAuditFailure(c, "profile", "Profile");
    }
    return c.redirect(dashUrl(c, "profile"), 303);
  });

  app.post("/watches/:id/cancel", mutationBodyLimit, (c) => {
    if (!deps.watches) return c.html(layout("Setup required", `<h1>Setup required</h1>${dashboardUnconfigured(c, "watches", "watch")}`), 400);
    const id = c.req.param("id");
    let outcome;
    try {
      outcome = deps.watches.cancel(id);
    } catch {
      return dashboardMutationFailure(c, "watches", "Watch change could not be saved safely.");
    }
    if (!outcome.ok) {
      return c.html(
        layout("Error", `<p class="error">${outcome.reason === "not_found" ? "No such watch." : "Only active watches can be cancelled."}</p>`),
        outcome.reason === "not_found" ? 404 : 409,
      );
    }
    try {
      deps.audit.append({ type: "watch_cancelled", door: "dashboard", watchId: outcome.watch.id, name: outcome.watch.name });
    } catch {
      return dashboardAuditFailure(c, "watches", "Watches");
    }
    return c.redirect(dashUrl(c, "watches"), 303);
  });

  return app;
}

export interface LocalUiServer {
  /** e.g. "http://127.0.0.1:53412" */
  origin: string;
  port: number;
  close(): void;
}

/** Serves the UI on 127.0.0.1 ONLY (never 0.0.0.0). port 0 = ephemeral. */
export async function startLocalUi(deps: LocalUiDeps, options: { port?: number } = {}): Promise<LocalUiServer> {
  const app = createLocalUiApp(deps);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: options.port ?? 0 });
  const port = await new Promise<number>((resolve, reject) => {
    server.addListener("listening", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error(`${BRAND_NAME} local UI: could not determine bound port`));
        return;
      }
      resolve(addr.port);
    });
    server.addListener("error", reject);
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () => server.close(),
  };
}
