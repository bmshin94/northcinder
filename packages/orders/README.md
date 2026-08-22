# @northcinder/orders

This package keeps the buyer's local order graph. It combines immutable NorthCinder checkout records with orders, shipments, deliveries, and return windows parsed from order email. The client exposes the merged view through `list_orders`, `get_order`, `import_order`, and the buyer-local dashboard.

Historical checkout JSONL remains append-only. Older records that lack a source store or product title are normalized when read. They receive a non-attributable legacy source marker, and the display title falls back to the mandate intent or offer id. The original JSONL bytes are not rewritten.

## Deterministic mail parsing

The parser reads RFC 5322 and MIME without an LLM. It unfolds headers, decodes quoted-printable and base64 text, walks multipart messages, and then applies fixed merchant or format parsers. Mail that cannot be parsed becomes a structured unparsed record instead of disappearing.

Merchant names, order numbers, and item titles are stripped of control characters before persistence. The public order schema remains the boundary for records returned to clients.

## IMAP and local import

Raw mail headers do not authenticate a message. The built-in socket IMAP transport cannot obtain provider-authenticated authority metadata, so unattended ingest fails closed. A provider-specific transport may opt in only when it supplies authenticated metadata bound to the IMAP UID and the SHA-256 digest of the exact raw message.

The local `.eml` drop directory is a separate manual path. It stays disabled until the buyer sets `NORTHCINDER_ORDERS_ALLOW_LOCAL_UNAUTHENTICATED=1`. Startup labels that state clearly. This local bypass never changes the IMAP policy.

IMAP reads use `BODY.PEEK[]`, cap message and response sizes, and destroy the socket on timeout. Missing credentials return `not_configured`.

## Outcomes and reminders

`record_order_outcome` accepts buyer-confirmed outcomes only. Exact checkout tuples can update one matching decision; ambiguous or normalized legacy records do not guess attribution. A single brand reaction remains a proposal until the buyer confirms it or separate evidence supports it.

Return, warranty, and maintenance reminders are buyer-local facts. They only send notifications. They never file a claim, perform maintenance, return an item, or buy anything.

Run one scheduler tick with:

```sh
northcinder-orders --once
```

Run a long-lived loop with:

```sh
northcinder-orders --interval 900
```

The scheduler uses the configured ntfy topic or stderr. Successful sends are deduplicated across restarts. A crash after a relay accepts a message but before the local sent marker is stored can produce a later duplicate, so delivery is at least once rather than exactly once.
