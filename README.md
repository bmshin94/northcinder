# NorthCinder

**Your shopping agent should work for you.**

AI agents are starting to do more than answer shopping questions. Soon they will decide which products people see and, in some cases, buy on their behalf.

Big marketplaces are building the easiest version of this: an agent that searches one catalog and steers the buyer toward that platform's checkout. That may be convenient, but it is not independent advice. The marketplace still decides what can be seen and makes money when the agent closes the sale.

NorthCinder takes a different approach. It compares products from the sources you choose and shows where its facts came from. Before it buys anything, it asks for your approval. NorthCinder is software you run alongside your AI app.

The repository owner does not operate a NorthCinder service. There is no NorthCinder account or cloud service.

## Get started

You need Node.js 20 or later and an MCP-capable AI app.

```sh
npx northcinder init
```

The command saves your configuration on your computer and prints the MCP entry for your AI app. Local mode is keyless. It runs the MCP server and search engine together in one process, using a temporary loopback port.

Once connected, try a real shopping brief:

> Find black wool running shoes under $130. Compare price, delivery, fit, and merchant trust. Tell me why the winner ranked first and which options were ruled out.

## What a result looks like

NorthCinder does not pretend there is one universal "best" product. It normally shows no more than three useful choices: the strongest fit, a lower-risk option, and a cheaper or meaningfully different option when one exists.

Each result explains why it ranked where it did. You can also inspect the other finalists, rejected offers, and facts that could not be verified.

## Research before recommendation

Product research gets messy quickly. Model names overlap, sellers copy one another, and a polished product page can hide the one detail that makes an item wrong for the buyer.

NorthCinder includes separate research guides for products and sellers. Before doing the research, the MCP host should:

1. Read `northcinder://research/product` or `northcinder://research/seller`.
2. Call `create_research_plan` with the actual request and exact subject.
3. Follow the returned checklist with the research tools it already controls.

If the sources disagree or do not identify the exact product or seller, the result stays provisional. Research can decide whether an offer is ready to compare, but it cannot add ranking points.

So far, we have tested this workflow end to end with Codex CLI 0.147.0, `gpt-5.6-luna`, medium reasoning, and local STDIO MCP. We do not yet make the same claim for other hosts or models.

## Buying stays a separate decision

A recommendation is not permission to buy. Every checkout needs a fresh approval for one exact offer and one unit. The signed approval includes the merchant, variant, price, known total, and spending cap. It can be used once.

NorthCinder rejects raw card details. A supported automated checkout can use an opaque payment token, or NorthCinder can hand the buyer a cart link to finish in their own browser.

Order outcomes stay local and only attach to the purchase they belong to. NorthCinder does not silently rewrite the buyer's profile, and its reminders only send notifications.

## Rules you can inspect

Seller payment never improves ranking. Sponsored offers stay labeled and below organic results. Missing store coverage stays visible, and unknown seller history remains unknown instead of being guessed safe or unsafe.

NorthCinder reruns the ranking locally and writes recommendations, approvals, and checkout attempts to a local audit log. The [ranking specification](./docs/RANKING.md), [trust specification](./docs/TRUST.md), [neutrality audit](./docs/NEUTRALITY-AUDIT.md), and [checkout package](./packages/checkout) contain the details.

These checks cover the offers NorthCinder received, not the completeness or truth of a store's catalog.

## How NorthCinder works

Your AI app talks to NorthCinder over MCP. NorthCinder runs the search engine locally, checks the ranking before returning it, and keeps the audit log and purchase approvals on your computer. You choose the store connections. The repository owner is not part of this path.

## Store coverage

Store access varies, and NorthCinder says when a store was unavailable or not configured. It does not present a partial search as though it covered the whole market.

Built-in adapters cover [Shopify](./adapters/shopify/README.md), [WooCommerce](./adapters/woocommerce/README.md), [eBay](./adapters/ebay/README.md), [Etsy](./adapters/etsy/README.md), and read-only [Amazon](./adapters/amazon/README.md) comparison.

If a native connection is missing, the AI app can keep researching with its own browser or search tools. NorthCinder accepts product facts, not cookies, raw pages, passwords, or page instructions. A native connection must confirm the exact offer before checkout or an unattended watch.

## Self-hosted engine

Most people should use local mode. If you choose to run the engine separately, set `NORTHCINDER_API_KEYS` on the service and configure the client with `NORTHCINDER_SERVICE_URL` and the matching `NORTHCINDER_CLIENT_KEY` bearer credential. Non-loopback bearer connections must use HTTPS.

## Privacy

- NorthCinder never needs your AI provider key. It stays in your AI app. Store credentials stay with you and the store.
- NorthCinder does not send your searches, settings, or local history to the repository owner.
- Raw card details are rejected rather than stored or forwarded.
- Starting a search or price watch does not give NorthCinder permission to buy anything.

Read [privacy and software ownership](./docs/INDEPENDENCE.md) and the [security policy](./SECURITY.md) for the full boundary.

## Build from source

This is a pnpm workspace. Product packages need Node.js 20 or later. The private site workspace needs Node.js 22.12 or later.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
node northcinder/bin/northcinder.js init
```

The full release checks are documented in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Contributing and support

- Use [GitHub Issues](https://github.com/cinderline/northcinder/issues) for reproducible bugs and focused proposals.
- Use [GitHub Discussions](https://github.com/cinderline/northcinder/discussions) for questions and early ideas.
- Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/cinderline/northcinder/security/advisories/new), not a public issue.

NorthCinder is open source under the [MIT License](./LICENSE).
