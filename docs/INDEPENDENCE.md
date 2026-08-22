# NorthCinder is software, not a hosted service

NorthCinder is MIT-licensed source code that the buyer downloads and runs. The repository owner does not
operate a NorthCinder endpoint, create user accounts, issue API keys, receive configuration, collect
telemetry, observe searches, retain audit trails, or participate in checkout.

## What runs where

- The MCP client, approval UI, audit trail, profiles, watches, and order records run under the
  buyer's control.
- The aggregation engine runs locally by default inside the same process as the MCP server. Its keyless
  HTTP listener is confined to an ephemeral IPv4 loopback port and ends with that process; local setup
  reserves no fixed port and prints no second service command.
- An advanced user may separately deploy the engine on infrastructure they control. That is an
  authenticated self-hosted deployment, not a NorthCinder-operated service.
- The optional read-only HTTP bridge is also self-hosted. The person deploying it generates its
  client keys and is responsible for its network, TLS, access, and retention policy.
- Store adapters contact the stores the buyer configured. Optional trust feeds and notification
  endpoints are third parties selected or enabled by the buyer; none is operated by this
  repository's owner.
- If a native store connection is unavailable, the buyer's existing agent may browse with tools it
  already controls and pass normalized product observations into the local NorthCinder process. NorthCinder
  does not launch or control that browser, and observations do not pass through the repository
  owner.
- Native credentials are optional and buyer-owned. A missing connection remains visible as
  `not_configured`; it does not become fake coverage or prevent the host from continuing its own discovery.

## Credential ownership

An AI model/provider token remains inside the buyer's AI application and is never requested by
NorthCinder. Ordinary local mode uses no client key. For an explicitly self-hosted engine,
`NORTHCINDER_API_KEYS` protects the service and a matching `NORTHCINDER_CLIENT_KEY` is sent by that buyer's
client as a bearer credential. Store credentials and browser sessions belong to the buyer. Checkout uses
only an opaque delegated payment token or the buyer's own merchant session, never raw card fields.

The browser-observation handoff accepts a strict comparison schema, not cookies, request headers,
raw HTML, screenshots, passwords, one-time codes, browser storage, account data, or model-provider
tokens. The observing agent cannot supply NorthCinder's trust level, score, rank, ranking reason, or
checkout capability. NorthCinder derives those locally.

## Observation is not verification

A browser observation records what the buyer's agent reported seeing on a product page. NorthCinder can
validate its shape and source URL, derive merchant trust, rank it against the buyer's brief, and
record it in the buyer-local audit trail; NorthCinder cannot independently prove that the page was
complete or transcribed correctly. The UI keeps that provenance visible.

Agent-observed offers may be compared and opened in the buyer's browser. They cannot be used for
automated checkout or unattended watches until a native store adapter or merchant protocol
revalidates the offer. A CAPTCHA, block, login challenge, or merchant-page instruction ends the
browser attempt rather than transferring more authority or credentials to NorthCinder.

## No continuing relationship

Cloning, downloading, or installing NorthCinder creates no account, subscription, callback, support
contract, or operational dependency on the repository owner. GitHub issues and source updates are
optional maintenance channels. An installed copy continues to run without contacting GitHub or the
repository owner.

The economic boundary remains the same: NorthCinder does not sell sponsored placement, attach affiliate
identifiers, skim checkout, sell buyer data, or accept seller payment to affect selection or rank.
