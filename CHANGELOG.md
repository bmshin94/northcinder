# Changelog

Notable public changes to NorthCinder are recorded here.

## 2026-08-22: `northcinder` 0.2.0

### Added

- Added product and seller research resources, prompts, and bounded research plans. Routine-use support is qualified only for Codex CLI 0.147.0 with `gpt-5.6-luna` at medium reasoning over local STDIO MCP. Other host/model combinations remain unqualified.
- Added strict exact-product, seller, landed-cost, return, warranty, and sourced-claim evidence with explicit conflicts and unknowns. Research evidence changes readiness and provenance, not rank.
- Added a buyer decision surface with at most three role-based candidates by default. Additional finalists, rejections, raw reasons, and provenance remain available in expanded detail.
- Added buyer-confirmed order outcomes, exact decision attribution, confirmation-gated preference proposals, and buyer-local return, warranty, and maintenance reminders. Reminders only notify.
- Added current Shopify Global and Storefront Catalog UCP discovery and refresh, plus a structured handoff to browser or search tools already controlled by the buyer's MCP host.
- Added structured issue and pull-request templates, public product pages, and fail-closed metadata for unconfigured site builds.

### Changed

- Made ordinary `npx northcinder init` keyless and single-process. The launcher owns an ephemeral loopback engine for the MCP lifetime; separately operated engines still require buyer-generated bearer keys.
- Replaced underbound purchase mandates with a versioned signature over the complete purchase-relevant offer digest and quantity one. Older mandates fail closed, while historical order records remain readable.
- Limited MCP-created watch destinations to stderr, the fixed buyer-local notification file, or the scheduler's configured ntfy topic. Legacy webhooks require a public HTTPS domain and cannot redirect. The person running the scheduler remains responsible for DNS resolution.
- Required secure credential destinations for ACP, self-hosted engine, remote bridge, and Shopify catalog bearer traffic. Non-loopback bearer endpoints require HTTPS.
- Replaced Shopify and ACP upstream error text with fixed messages and bounded status or code fields before MCP output or audit persistence.
- Added an explicit widget CSP. Automatic product images load only from exact built-in adapter image origins; other safe HTTPS images are user-opened links.
- Kept detailed discovery readiness on the launcher-owned loopback health response and made self-hosted health generic.
- Clarified that MCPB and server-template packages are advanced clients for a separately operated authenticated engine.
- Updated the public explanation of NorthCinder around buyer-owned AI tools, inspectable evidence, a short decision brief, separate purchase approval, local outcomes, and reminders that never act.

## 2026-08-17: `northcinder` 0.1.2

- Published NorthCinder as buyer-run, open-source shopping-agent software with `npx northcinder init`.
- Added criteria-based cross-store search, deterministic ranking with machine-readable reasons,
  explicit merchant-trust evidence, and honest coverage reporting.
- Added an optional handoff for browser tools already controlled by the buyer's agent. Accepted
  observations pass through NorthCinder's strict validation, merchant-trust derivation, deterministic
  ranking, client verification, buyer's brief, rejected appendix, feedback, and local audit path.
- Marked browser candidates as agent-observed rather than independently verified and required
  native adapter or merchant-protocol revalidation before checkout authorization or unattended
  watches.
- Kept browser sessions and AI-provider credentials in the buyer's existing agent environment;
  NorthCinder accepts normalized observations, not cookies, raw HTML, screenshots, headers, passwords,
  tokens, page instructions, or caller-supplied trust and ranking claims.
- Added signed, payload-bound purchase approval with single-use nonce protection.
- Added local profiles, watches, order tracking, merchant-trust derivation, and an audit trail.
- Added Shopify, WooCommerce, eBay, Etsy, and read-only Amazon adapters, plus a self-hostable
  read-only MCP bridge.
- Added offline build, typecheck, test, dependency, secret, and public-surface checks.
