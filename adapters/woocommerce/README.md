# @northcinder/adapter-woocommerce

Native WooCommerce adapter over the Store API:

- `GET /wp-json/wc/store/v1/products?search=<terms>&per_page=<n>`
- `GET /wp-json/wc/store/v1/products/{id}`

## Access boundary

WooCommerce documents the Store API as public and unauthenticated. Product reads do not require an
API key or OAuth token, but NorthCinder still needs an explicit list of store hosts and each site must
actually expose the `wc/store/v1` endpoint. A store, firewall, plugin, or site policy can make the
endpoint unavailable; NorthCinder reports that failure rather than treating it as an empty catalog.

Configure comma-separated bare hostnames in `WOOCOMMERCE_STORE_HOSTS`. With no hosts, NorthCinder reports
`not_configured`. Multiple stores are searched with bounded concurrency, and one failed host does
not hide results from another responding host.

Official references:

- [WooCommerce Store API](https://developer.woocommerce.com/docs/apis/store-api/)
- [WooCommerce products endpoint](https://developer.woocommerce.com/docs/apis/store-api/resources-endpoints/products/)

## When native coverage is unavailable

Where the site's rules permit, the buyer's existing agent may use browser tools it already controls
and pass normalized observations into local NorthCinder. They remain agent-observed rather than verified
Store API facts. NorthCinder validates, ranks, explains, and audits them locally, but blocks automated
checkout and unattended watches until the native Store API or another merchant protocol
revalidates the offer.

## Mapping notes

- `prices.price` is a scaled integer string interpreted with `prices.currency_minor_unit` and
  converted with exact arithmetic.
- `is_in_stock` maps to NorthCinder's `in_stock` or `out_of_stock` state.
- Because a product resource has no cross-store display name, merchant identity is the configured
  host.
- HTML is removed from `short_description` before it reaches NorthCinder's plain-text product fields.
- The Store API response has no placement-provenance field. The native adapter currently maps its
  product results as non-sponsored and adds no affiliate parameters; this is adapter behavior, not
  proof about every placement elsewhere on the merchant's site.

## Tests and live verification

Offline tests use fixtures. `pnpm live-check` contacts only buyer-configured hosts and skips when no
host is supplied. A historical successful store probe is not proof that every WooCommerce site
exposes the endpoint today.
