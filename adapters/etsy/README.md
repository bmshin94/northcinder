# @northcinder/adapter-etsy

Native Etsy adapter over Open API v3
(`GET /v3/application/listings/active` and `GET /v3/application/listings/{id}`), using the
`x-api-key` header at `openapi.etsy.com`.

## Access boundary

Etsy's current access model distinguishes Seller Apps, Personal Apps, and Commercial Access. A
Seller App is limited to the developer's own shop. NorthCinder's buyer-facing, beyond-one-shop use needs
an approved Personal App at minimum; Personal Apps receive a deeper review. Broader commercial use
starts with an approved Personal App and then requires a separate Commercial Access review.

Configure the approved keystring as `ETSY_API_KEY`. Without it, NorthCinder reports `not_configured`; a
pending, rejected, or unauthorized key surfaces as an access failure. NorthCinder does not provide or
broker Etsy approval.

Official reference: [Etsy Open API v3 access options](https://developers.etsy.com/documentation/).
Etsy's current documentation also says applications must not sidestep the API to retrieve Etsy
data and that screen scraping is not allowed. NorthCinder's browser-observation handoff is not permission
to bypass that rule. If the buyer's agent cannot browse consistently with the applicable site
rules, it must report Etsy coverage as unavailable.

## Fixture and live boundaries

Offline tests use fixtures shaped to Etsy's documented v3 response format. They are not evidence of
an approved app or a current live response. `pnpm live-check` is key-gated and must skip honestly
when the buyer has not supplied an approved key.

If a permitted buyer-agent observation is submitted, it remains visibly agent-observed and passes
through NorthCinder's local validation, merchant-trust derivation, neutral ranking, reasons, rejected
appendix, and audit. It cannot authorize checkout or an unattended watch until the native Etsy
adapter revalidates it.

## Mapping notes

- Etsy's scaled-integer money is converted to integer minor units with exact arithmetic.
- Active listings with positive quantity map to `in_stock`; other explicit states map to
  `out_of_stock`, and missing quantity remains `unknown`.
- The listing response supplies a numeric `shop_id`, so the current adapter uses
  `etsy-shop:<id>` / `Etsy shop #<id>` until a separate shop lookup is available.
- The adapter adds no affiliate parameters and no seller-paid ranking input.
