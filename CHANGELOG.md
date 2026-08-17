# Changelog

Notable public changes to NorthCinder are recorded here.

## 2026-08-17 — `northcinder` 0.1.2

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
