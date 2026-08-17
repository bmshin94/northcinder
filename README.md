# NorthCinder

**Make your shopping agent compare, explain, and ask before buying.**

NorthCinder helps your AI agent search for products, compare them against your brief, and show why one
option ranks above another. Seller payment and affiliate data never improve a result's position.

NorthCinder runs on your computer alongside the AI app you already use. There is no NorthCinder account or
cloud service.

## Get started

You need Node.js 20 or later and an AI app that supports MCP. MCP is the standard the app uses to
connect to tools running on your computer.

```sh
npx northcinder init
```

The initializer walks you through setup and prints the configuration to add to your AI app. Once
connected, try a specific brief:

> Find black wool running shoes under $130. Compare price, delivery, fit, and merchant trust. Tell
> me why the winner ranked first and which options were ruled out.

## What you get

- A ranked shortlist based on the requirements and preferences in your brief.
- Reasons for every recommendation, including tradeoffs and missing information.
- Sponsored offers labeled and placed below organic results.
- Merchant trust evidence and an honest report of which stores were searched.
- A local history you can review, correct, and use to improve later searches.
- A separate approval step before any automated checkout.

## How NorthCinder works

1. You tell your agent what you want, what matters, and your budget.
2. NorthCinder collects candidates from the direct store connections you configured. Your agent can also pass
   product details from browser tools it already controls.
3. NorthCinder checks the candidates, ranks them against your brief, and returns a shortlist with reasons
   and coverage gaps.
4. If you choose to buy, NorthCinder asks you to approve the exact item, quantity, and spending limit.

Results reported from a browser are clearly marked as agent-observed. You can compare them and open
the product page, but NorthCinder will not use them for automated checkout or a background price watch
until a direct store connection confirms the offer.

## Store coverage

Store access varies because each platform has different rules. NorthCinder reports a store as unavailable
or blocked when it cannot search it, rather than presenting partial coverage as a complete market
search.

| Store | What works today |
| --- | --- |
| [Shopify](./adapters/shopify/README.md) | Catalog search is available after additional Shopify setup. The older per-store connection is no longer current. |
| [WooCommerce](./adapters/woocommerce/README.md) | Works with stores that expose WooCommerce's public Store API. |
| [eBay](./adapters/ebay/README.md) | Native search requires approved eBay Buy API access. |
| [Etsy](./adapters/etsy/README.md) | Native search requires approved Etsy app access. |
| [Amazon](./adapters/amazon/README.md) | Read-only comparison can use a browser profile you control. It stops at challenges and does not check out. |

When a native store connection is unavailable, your agent may still compare permitted product pages
with browser tools it already has. NorthCinder accepts only product facts needed for comparison. It does
not take over the browser or ask for cookies, page contents, passwords, one-time codes, or your AI
provider key.

## Privacy and control

NorthCinder is software you run. The repository owner does not operate a NorthCinder service.

- Your AI provider key stays in your AI app. Store logins stay with you and the store.
- NorthCinder does not send your searches, settings, or local history to the repository owner.
- NorthCinder never accepts raw card details. Automated checkout can use a payment token created for the purchase,
  or NorthCinder can hand you a cart to finish in your own browser.
- Search is not permission to buy. Every automated checkout needs your approval for that purchase.

## Learn more

- [Why NorthCinder exists](./MANIFESTO.md)
- [How ranking works](./docs/RANKING.md)
- [How merchant trust works](./docs/TRUST.md)
- [Privacy and software ownership](./docs/INDEPENDENCE.md)
- [Build from source or contribute](./CONTRIBUTING.md)
- [Report a security issue](./SECURITY.md)

NorthCinder is open source under the [MIT License](./LICENSE).
