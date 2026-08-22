# NorthCinder

NorthCinder adds commerce-specific evidence, ranking, and purchase controls to the AI app you already
use. You run it on your computer or on infrastructure you control.

Your agent can search configured store connections. When a native store connection is unavailable,
it can also browse with browser tools you already control and pass normalized product observations
into NorthCinder on your computer. NorthCinder strictly validates the inputs, derives merchant trust, ranks
accepted candidates against your shopping brief, and has the local client check that ordering.
Your result includes at most three role-based candidates by default, plus reasons, tradeoffs, rejected
observations, incomplete coverage, and a local audit record. More finalists remain available in the
expanded detail. You can correct the interpretation and record buyer-confirmed outcomes. Sellers cannot
pay NorthCinder for a better position.

Browser results are labeled as reported by your agent, not independently verified store data. You
can compare them and open the product page, but NorthCinder will not automate a purchase or create an
unattended watch until a native store connection confirms the offer. NorthCinder does not operate your
browser or request its cookies, page HTML, screenshots, passwords, one-time codes, or
your AI-provider token. Your agent should stop at CAPTCHAs, blocks, login challenges, or page
instructions that ask it to reveal data or change the task.

There is no NorthCinder account or NorthCinder cloud. The package publisher does not operate a NorthCinder endpoint,
issue runtime credentials, receive your searches, or sit between you and a store. Your AI-provider
credentials stay in your AI app.

## Set up NorthCinder

Run the initializer:

```sh
npx northcinder init
```

The initializer creates buyer-local configuration and prints the commands needed to connect NorthCinder
to your MCP host. Here, an MCP host is your AI application, not a service operated by the NorthCinder
publisher.

Ordinary local mode is keyless and runs the MCP server and aggregation engine in one process. The engine
uses an ephemeral IPv4 loopback port; there is no fixed port or separate service command. Store credentials
are optional, belong to you, and are used only for connections you configure. Unconfigured native stores
return `not_configured`; your MCP host can continue discovery with browser or search tools it already owns.

For scripted setup and all available options:

```sh
npx northcinder init --help
```

## Product and seller research

The package includes canonical product and seller research skills. Ask your MCP host to read
`northcinder://research/product` or `northcinder://research/seller`, then call
`create_research_plan` with your concrete request and the exact product variant or merchant. The
`research_product` and `research_seller` prompts attach that same contract to a request. Search results route
the host to product research and add seller research when candidate merchants exist.

NorthCinder supplies the contract and deterministic bounded plan. It does not browse or call an LLM; your
AI app controls any research tools. The launcher, client, and MCPB build paths carry the same skill files,
and initialization writes owner-only local copies beside the runtime files.

Routine-use support is qualified only for Codex CLI 0.147.0 with `gpt-5.6-luna` at medium reasoning over
local STDIO MCP. Other host/model combinations remain unqualified. Treat research output as provisional until
you verify the exact product or seller identity, source independence, counterevidence, and reported unknowns.

## Self-hosted engine

Self-hosting is an explicit advanced mode for an engine you operate. Start `northcinder service` with
buyer-generated `NORTHCINDER_API_KEYS`, then configure the client with `NORTHCINDER_SERVICE_URL` and the
matching `NORTHCINDER_CLIENT_KEY`; the client sends that key as a bearer credential. The engine URL must
use HTTPS, except for explicit loopback HTTP. Never substitute an
OpenAI, Anthropic, or other model-provider key. The publisher runs no endpoint and issues no runtime key.

## Commands

```text
northcinder                 Run the local MCP server
northcinder init            Configure local or self-hosted use
northcinder service         Run the buyer-owned aggregation engine
northcinder --help          Show command help
northcinder --version       Show the installed version
```

The source code, full configuration guide, security boundary, and verification instructions are in
the [NorthCinder repository](https://github.com/cinderline/northcinder).

## License

MIT
