# @northcinder/adapter-ebay

Native eBay adapter over the buyer-side Buy Browse API
(`/buy/browse/v1/item_summary/search` and `/buy/browse/v1/item/{id}`), using client-credentials
tokens cached until expiry.

## Access boundary

- Both Sandbox and Production require an eBay Developers Program account and the matching
  application keyset. Sandbox keys do not work in Production.
- Production use of the Buy APIs is a separate gate. eBay says applicants must meet eligibility
  requirements, obtain approvals, and sign applicable agreements; approval is not guaranteed.
- Configure `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, and `EBAY_ENV=sandbox` or `production`.
  Without both credentials, the adapter reports `not_configured`. NorthCinder never issues these keys.

Official references:

- [Create eBay application keysets](https://www.developer.ebay.com/api-docs/static/gs_create-the-ebay-api-keysets.html)
- [Buy APIs requirements](https://developer.ebay.com/api-docs/buy/buy-requirements.html)

This repository contains no eBay credential or production approval. Production remains an explicit
buyer-owned follow-up gate.

## Fixture and live boundaries

Offline tests, including protocol conformance, use fixtures shaped from eBay's documented Browse
API examples. They were not recorded from a live Sandbox or Production account. `pnpm live-check`
is credential-gated; without a buyer-provided keyset it must skip rather than imply live coverage.

When native eBay access is unavailable, the buyer's existing agent may browse only where eBay's
rules and the buyer's browser tooling permit, then pass normalized observations into local NorthCinder.
Those observations are not an eBay API response: NorthCinder labels them agent-observed, includes them in
local validation, ranking, reasons, and audit, and blocks automated checkout and unattended watches
until a native store connection revalidates the offer.

## Mapping notes

- eBay decimal-string money is converted to integer minor units without floating-point arithmetic.
- The adapter does not add eBay Partner Network or other affiliate parameters.
- Search summaries that omit stock state map to `availability: "unknown"`; offer details map
  available stock evidence to `in_stock` or `out_of_stock`.
- Merchant identity comes from the listing seller. Condition strings are normalized to NorthCinder's
  `new`, `refurbished`, or `used` values when possible.
