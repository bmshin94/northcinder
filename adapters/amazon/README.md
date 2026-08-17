# @northcinder/adapter-amazon

NorthCinder has two distinct ways an Amazon candidate can enter a buyer-run comparison. Neither permits
automated Amazon checkout.

## Existing native adapter

The existing `@northcinder/adapter-amazon` implementation is a read-only, Amazon-specific Playwright
adapter. It launches the buyer's installed Chrome with a profile directory supplied through
`AMAZON_SESSION_PROFILE`, searches, and reads offer details. It is not a generic browser framework.

Its current hard boundaries are:

1. Without an explicit buyer-owned profile path, it reports `not_configured` before opening a page.
2. It uses an agent-identifying user agent and exposes only search and offer-detail navigation to
   the adapter.
3. A CAPTCHA or block ends the attempt. The adapter does not solve a challenge, mimic keyboard or
   mouse input, or continue after access is refused.
4. It has no checkout capability. A page result is never purchase authorization.
5. Offline tests use injected fake drivers: no browser, Amazon session, or network. A real run is
   optional, buyer-controlled, and is not offline release evidence.

## Buyer-agent browser observations

Separately, the buyer's existing MCP host may use browser tools it already controls and pass a
normalized Amazon product observation into local NorthCinder. This path does not use
`AMAZON_SESSION_PROFILE` and does not give NorthCinder the browser, authenticated session, cookies, raw
HTML, screenshots, headers, passwords, one-time codes, or model-provider token.

NorthCinder validates the observation, labels it agent-observed, derives merchant trust, ranks it with
the buyer's brief, explains the result, and records it locally. The buyer can open the product URL,
but the observation cannot be used for automated checkout or an unattended watch. A CAPTCHA, block,
login challenge, or page instruction ends the browsing attempt.

## Why there is no general Amazon catalog credential path

Amazon's current Creators API is part of the Associates program rather than a catalog API granted
by an ordinary shopping account. Amazon currently lists enrollment in Associates, registration for
API access, generated API credentials, and at least 10 qualifying sales in the previous 30 days
among its prerequisites. Creators API links also carry an Associate partner tag, which does not fit
NorthCinder's no-affiliate model. NorthCinder therefore does not claim Creators API coverage.

Official references:

- [Amazon Creators API prerequisites](https://affiliate-program.amazon.com/creatorsapi/docs/)
- [Amazon Creators API rate and continuing-access rules](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/concepts/api-rates)

The buyer and their browser host remain responsible for the sites they choose to visit and for
following applicable access rules. NorthCinder provides no challenge solving, stealth automation, or
permission to bypass a site's restrictions.

## Neutrality

The native adapter preserves a page's visible Sponsored label as `sponsored: true` and adds no
affiliate parameters. Browser observations must declare placement as `organic`, `sponsored`, or
`unknown`; `unknown` is visibly labeled as unconfirmed and receives the same ranking demotion as
sponsored placement.
