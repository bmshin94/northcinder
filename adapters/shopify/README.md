# @northcinder/adapter-shopify

Native Shopify catalog adapter. It is buyer-run code and contacts only the catalog endpoint and
store hosts configured by the buyer.

## Current Shopify contract and NorthCinder status

Shopify's current catalog interface is UCP. Both the cross-merchant Global Catalog and single-store
Storefront Catalog use `/api/ucp/mcp`, require a publicly fetchable UCP agent-profile URL, and do
not require an API key. The current tools are `search_catalog`, `lookup_catalog`, and `get_product`.
Shopify deprecated the former Storefront Catalog endpoint and tool shapes and stated that they would
be maintained only until June 15, 2026.

NorthCinder's implementation is only partly migrated:

| Leg | Current NorthCinder behavior | Honest status |
| --- | --- | --- |
| Global Catalog search | Calls `https://catalog.shopify.com/api/ucp/mcp`, sends `meta["ucp-agent"].profile` from `SHOPIFY_UCP_AGENT_PROFILE_URL`, and calls `search_catalog`. | Matches the current search endpoint and profile-URL shape. An optional `SHOPIFY_GLOBAL_CATALOG_API_KEY` compatibility bearer is supported by the code but is not required by Shopify's current catalog documentation. The real endpoint is not part of offline acceptance. |
| Per-store search | Calls `https://<shop>/api/mcp` with the pre-UCP request shape. | Legacy implementation. Do not describe this as current live support; it needs `/api/ucp/mcp` and current UCP response migration. |
| Offer details | Calls the configured product's store at `/api/mcp` with `get_product_details`. | Legacy implementation. It needs migration to current `get_product` before end-to-end current Shopify support can be claimed. |

If a profile URL is configured, NorthCinder tries Global Catalog search first. If that fails and legacy
per-store hosts are also configured, it falls back to those hosts. A profile URL is a URL to JSON
the buyer controls; it is not an AI-provider token or a credential issued by NorthCinder.

Official references:

- [Shopify catalog interfaces](https://shopify.dev/docs/agents/catalog)
- [Global Catalog MCP](https://shopify.dev/docs/agents/catalog/global-catalog)
- [Storefront UCP migration notice](https://shopify.dev/changelog/storefront-catalog-mcp-now-implements-ucp)

## Configuration

```ts
createShopifyAdapter({
  globalCatalog: {
    profileUrl: "https://agent.example/.well-known/ucp",
    // Optional compatibility bearer in the current implementation:
    apiKey: "...",
    url: "https://catalog.shopify.com/api/ucp/mcp",
  },
  // Legacy per-store fallback until NorthCinder completes its UCP migration:
  shops: ["www.allbirds.com"],
})
```

The matching environment variables are `SHOPIFY_UCP_AGENT_PROFILE_URL`,
`SHOPIFY_GLOBAL_CATALOG_API_KEY`, `SHOPIFY_GLOBAL_CATALOG_MCP_URL`, and
`SHOPIFY_MCP_SHOPS`.

- `manifest.permissions.allowedHosts` contains exactly the catalog host and explicitly configured
  shop hosts. Wildcards, schemes, paths, and ports in shop-host configuration are rejected.
- Calls use NorthCinder's bounded HTTP helper, the per-shop fan-out is concurrency-capped, and one legacy
  shop failure does not hide the others.
- NorthCinder does not request Shopify's `catalog.placements` option. Shopify says omitting that field
  returns organic results rather than promoted placements; the adapter also adds no affiliate
  parameters.

## When native coverage is unavailable

The buyer's existing agent may use browser tools it already controls, where the store's rules
permit, and pass normalized observations into local NorthCinder. Those offers are labeled agent-observed,
ranked and audited locally, and cannot be used for automated checkout or an unattended watch until
a current native Shopify response revalidates them. NorthCinder does not receive the browser session.

## Tests and live verification

`pnpm test` is offline and uses historical captured responses plus fixtures. A fixture passing does
not prove the retired per-store endpoint still works. `pnpm live-check` contacts real stores when
explicitly run; until the remaining UCP migration is complete and a dated live run passes, it must
not be presented as current end-to-end Shopify evidence.
