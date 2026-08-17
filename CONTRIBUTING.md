# Contributing

Thanks for helping improve NorthCinder. Small, focused changes with reproducible tests are easiest to
review.

## Set up a source checkout

You need Node.js 20 or later, Corepack, and Git.

```sh
git clone https://github.com/jdshfhds/northcinder.git
cd northcinder
corepack pnpm install --frozen-lockfile
corepack pnpm release:build
node northcinder/bin/northcinder.js init
```

## Before you start

- Search [existing issues](https://github.com/jdshfhds/northcinder/issues) before opening a new one.
- For a substantial behavior or protocol change, open a focused proposal first.
- Never include credentials, browser profiles, approval URLs, private mail, audit logs, or real
  purchase data in an issue, commit, fixture, or screenshot.
- Report security problems through the private route in [`SECURITY.md`](./SECURITY.md).

## Preserve the product contract

Changes must preserve NorthCinder's core guarantees:

- ranking inputs are buyer criteria, never seller payment;
- sponsored offers are labeled below organic offers;
- recommendations include machine-readable reasons;
- absent merchant history remains `unknown`;
- checkout requires a signed, single-use, payload-bound approval; and
- raw card fields are rejected.

## Find the right surface

| Change | Primary paths | Required attention |
| --- | --- | --- |
| ranking, protocol, trust | `packages/protocol` | deterministic behavior, property tests, generated-doc drift |
| adapter | `adapters/*`, `packages/adapter-kit` | conformance, timeouts, exact money, honest status |
| checkout or approval | `packages/checkout`, `client` | payload binding, replay protection, human decision, audit events |
| service | `service` | bounded aggregation and client-side verification compatibility |
| launcher or packaging | `northcinder`, package manifests | isolated install and initialization |
| public copy or site | top-level docs, `docs`, `site` | local links, accurate claims, public-surface audit |

## Verify

Use the smallest relevant package tests while iterating. Before opening a pull request, run:

```sh
corepack pnpm release:build
corepack pnpm release:typecheck
corepack pnpm release:test
corepack pnpm release:audit
corepack pnpm audit:public
```

Behavior changes should include a test that fails without the change. Keep third-party code, data,
fixtures, and media provenance clear.

By participating, you agree to [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
