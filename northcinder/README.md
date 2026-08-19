# NorthCinder

NorthCinder is software for your shopping agent. You run it on your computer or on infrastructure you
control, alongside the AI app you already use.

Your agent can search configured store connections. When a native store connection is unavailable,
it can also browse with browser tools you already control and pass normalized product observations
into NorthCinder on your computer. NorthCinder strictly validates the inputs, derives merchant trust, ranks
accepted candidates against your shopping brief, and has the local client check that ordering.
Your result includes reasons, tradeoffs, rejected observations, incomplete coverage, and a local
audit record; you can also correct the interpretation and record feedback. Sellers cannot pay NorthCinder
for a better position.

Browser results are labeled as reported by your agent, not independently verified store data. You
can compare them and open the product page, but NorthCinder will not automate a purchase or create an
unattended watch until a native store connection confirms the offer. In this handoff NorthCinder does not
operate your browser or request its cookies, page HTML, screenshots, passwords, one-time codes, or
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

For scripted setup and all available options:

```sh
npx northcinder init --help
```

Generate the NorthCinder client key yourself. Do not use an OpenAI, Anthropic, or other model-provider key
as the NorthCinder client key.

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
