# @northcinder/adapter-shopify

Native Shopify catalog adapter. It is buyer-run code and contacts only the catalog endpoint and
store hosts configured by the buyer.

## Current Shopify contract and NorthCinder status

Shopify's current catalog interface is UCP. Both the cross-merchant Global Catalog and single-store
Storefront Catalog use `/api/ucp/mcp`, require a publicly fetchable UCP agent-profile URL, and do
not require an API key. The current tools are `search_catalog`, `lookup_catalog`, and `get_product`.
Shopify deprecated the former Storefront Catalog endpoint and tool shapes and stated that they would
be maintained only until June 15, 2026.

NorthCinder uses the current UCP catalog paths offline; fixture coverage is not a live-provider claim.

| Leg | Current NorthCinder behavior | Honest status |
| --- | --- | --- |
| Global Catalog search and refresh | Calls `https://catalog.shopify.com/api/ucp/mcp`; every call carries `meta["ucp-agent"].profile` and uses `search_catalog` or `get_product` with `catalog.id`. Global Catalog UPIDs refresh here only through seller-and-variant-bound Global offer IDs. | Seller-less Global clusters are skipped rather than inferred from a URL or cluster price. The optional `SHOPIFY_GLOBAL_CATALOG_API_KEY` compatibility bearer is sent only when configured. |
| Storefront Catalog search and refresh | Calls `https://<shop>/api/ucp/mcp`; every call carries the same profile and uses `search_catalog` or `get_product` with `catalog.id`. | Configured hosts are bounded and allowlisted. A Global failure can fall back to configured storefronts. |

NorthCinder requires a profile URL for every Shopify call. It must be HTTPS and contain no userinfo.
NorthCinder tries Global Catalog search first; if it fails and storefront hosts are configured, it falls
back to those hosts. The profile URL points to JSON the buyer controls; it is not an AI-provider token
or a credential issued by NorthCinder.

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
  // Optional Storefront Catalog fallback (also UCP):
  shops: ["www.allbirds.com"],
})
```

The matching environment variables are `SHOPIFY_UCP_AGENT_PROFILE_URL`,
`SHOPIFY_GLOBAL_CATALOG_API_KEY`, `SHOPIFY_GLOBAL_CATALOG_MCP_URL`, and
`SHOPIFY_MCP_SHOPS`.

- `manifest.permissions.allowedHosts` contains exactly the catalog host and explicitly configured
  shop hosts. Wildcards, schemes, paths, and ports in shop-host configuration are rejected.
- Calls use NorthCinder's bounded HTTP helper, the per-shop fan-out is concurrency-capped, and one
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
not prove current third-party access. `pnpm live-check` contacts real stores only when explicitly run;
no live run is included in this repository acceptance evidence.
