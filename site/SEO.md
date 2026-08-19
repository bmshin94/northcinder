# SEO/GEO operating runbook

The Astro source is private-by-default. Without a verified production origin, every HTML page is noindex,
`robots.txt` disallows the site, the sitemap is empty, and canonical/schema URLs are omitted.

## Production build

Set both verified public coordinates when building:

```sh
NORTHCINDER_SITE_URL="https://your-real-origin.example" \
NORTHCINDER_REPOSITORY_URL="https://github.com/cinderline/northcinder" \
corepack pnpm --filter @northcinder/site build
```

The site-origin validator rejects HTTP, credentials, paths, queries, fragments, reserved domains, and
placeholder labels. Replace the sample origin above with a domain the operator actually controls; never
publish the literal example value.

## Post-deploy gate

Run the live checker against the exact HTTPS origin:

```sh
corepack pnpm --filter @northcinder/site seo:live -- https://your-real-origin.example
```

It checks each crawler user agent, every canonical page, JSON-LD parsing, cache-control, robots, sitemap,
`llms.txt`, and the social image. A clean spoofed-user-agent result proves there is no user-agent-level block;
it does not prove that a CDN permits the crawler's real IP range. Confirm verified-bot and WAF settings in the
edge provider and inspect request logs after deployment.

## Indexing and citation measurement

1. Verify the domain in Google Search Console and Bing Webmaster Tools.
2. Submit `/sitemap.xml` to both. Bing is particularly important because ChatGPT Search draws heavily from
   Bing's search pool.
3. Validate the live homepage and article pages in Schema.org Validator. Use Google Rich Results Test only
   for schema types it supports.
4. Record Google/Bing indexed-page coverage weekly until all seven public routes are indexed.
5. Track a stable prompt set weekly across ChatGPT Search, Google AI results, and Perplexity. Record whether
   NorthCinder is cited, the cited URL, citation position, and competing domains.
6. Re-run the live checker after any DNS, CDN, firewall, bot-policy, or deployment change.

NorthCinder does not add runtime visitor telemetry. Search Console, Bing Webmaster Tools, public GitHub
traffic, npm downloads, independent setup reports, and dated citation checks provide the measurement layer
without sending buyer searches or local product data to the repository maintainer.

## Off-site authority

On-site markup only makes a page eligible. The next authority steps are external and must remain genuine:

- publish the local stdio server to the official MCP Registry from a verified namespace;
- link technical explanations to the committed ranking and checkout evidence;
- answer real MCP and agent-commerce questions where the implementation is directly relevant;
- seek independent setup reports and downstream integrations rather than manufactured testimonials;
- pitch the deterministic audit dataset to technical newsletters or maintainers who cover agent safety; and
- never buy links, reviews, stars, directory placement, or fresh-account promotion.
