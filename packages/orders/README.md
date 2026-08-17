# @northcinder/orders

The post-purchase order graph: merges (a) your own NorthCinder checkout records
(read-only, never mutated) with (b) deterministically parsed order
confirmation, shipping, delivery, and return-window emails into one merged
view — `list_orders` / `get_order` / `import_order` in `@northcinder/client`, and
the dashboard's "Orders from email" table.

**No LLM parsing anywhere** (determinism law): a hand-rolled RFC 5322/MIME
reader feeds a fixed-order table of per-merchant/per-format parser plugins +
a generic fallback that always matches and only ever returns `unparsed` — no
mail is ever silently dropped.

## ⚠️ Trust boundary: unattended IMAP fails closed

Raw RFC 5322 mail, including `Authentication-Results`, is attacker-controlled
input and **never** authenticates an IMAP message. The built-in socket IMAP
transport has no provider-authenticated metadata API, so it returns mail
without an authority envelope and `pollImap` refuses the whole batch before
any order is ingested. A provider-specific transport may enable unattended
ingest only by supplying separate authenticated metadata with a passing status
bound to each IMAP UID and SHA-256 of that message's raw bytes.

The local `.eml` drop directory is a separate manual bypass, disabled by
default. Set `NORTHCINDER_ORDERS_ALLOW_LOCAL_UNAUTHENTICATED=1` deliberately to
enable it; startup labels it `LOCAL UNAUTHENTICATED BYPASS ENABLED`. This opt-in
never upgrades IMAP trust.

## Running the scheduler — `northcinder-orders`

Before this bin existed, `runReturnWindowReminders` and `pollImap` were
implemented and tested but nothing ever called them on an interval — they
were dead code from the running app's point of view. `northcinder-orders` ships
with `@northcinder/client` and mirrors `northcinder-watch`'s bin exactly: same two
modes, same exit-code law.

```sh
northcinder-orders --once             # one tick, then exit (cron-able)
northcinder-orders --interval 900     # long-running loop (seconds; default 900)
```

Each tick, in order:

1. **ingest the local `.eml` drop directory only when explicitly opted in**
   (`NORTHCINDER_ORDERS_ALLOW_LOCAL_UNAUTHENTICATED=1`; idempotent re-scan,
   dedup by Message-ID; `NORTHCINDER_ORDERS_MAIL_DROP_DIR` selects the path);
2. **poll IMAP if configured** (`NORTHCINDER_ORDERS_IMAP_HOST/USER/PASSWORD|TOKEN`
   — absent credentials are a structured `not_configured` SKIP, never a fake
   success, same law as every other profile/watch-style gated path in this repo);
3. **run return-window reminders** — N days before a parsed/computed return
   deadline (`NORTHCINDER_ORDERS_RETURN_REMINDER_DAYS`, default 3), pushed via
   ntfy if `NORTHCINDER_NTFY_TOPIC` is set (the SAME topic `northcinder-watch` uses —
   one push channel for the whole app) or to stderr otherwise. Dedupe
   persists on the `ReturnWindow` record itself: two ticks, one reminder,
   survives a restart.

**Reminders and IMAP polling do nothing unless this scheduler is running** —
exactly like price watches require `northcinder-watch` running to ever check
anything. `northcinder-mcp` alone only ingests the drop directory on each
`list_orders`/`get_order` call; it never polls IMAP or sends reminders by
itself.

`--once` exits **1** when every check that was actually ATTEMPTED failed
(an IMAP poll that was configured but couldn't connect, or a reminder send
that failed) — visible to cron/launchd. A quiet tick (nothing configured,
nothing due yet) is healthy and exits 0, exactly like `northcinder-watch`.

### cron (every 15 minutes)

```cron
*/15 * * * * NORTHCINDER_SERVICE_URL=http://127.0.0.1:8790 NORTHCINDER_CLIENT_KEY=… NORTHCINDER_NTFY_TOPIC=… /usr/local/bin/northcinder-orders --once >> ~/.config/northcinder/orders-cron.log 2>&1
```

### launchd (macOS)

`~/Library/LaunchAgents/com.northcinder.orders.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.northcinder.orders</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/northcinder-orders</string>
    <string>--once</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>EnvironmentVariables</key><dict>
    <key>NORTHCINDER_SERVICE_URL</key><string>http://127.0.0.1:8790</string>
    <key>NORTHCINDER_CLIENT_KEY</key><string>REPLACE_ME</string>
    <key>NORTHCINDER_NTFY_TOPIC</key><string>REPLACE_ME</string>
  </dict>
  <key>StandardErrorPath</key><string>/tmp/northcinder-orders.log</string>
</dict></plist>
```

Load it with `launchctl load ~/Library/LaunchAgents/com.northcinder.orders.plist`.

## IMAP: read-only, on purpose

`createRealImapTransport` issues `UID FETCH … (BODY.PEEK[])`, never plain
`BODY[]` — `.PEEK` never marks a message `\Seen`. This matters for
crash-safety, not just politeness: if the process died after fetching a
message but before persisting the ingested result, a plain `BODY[]` fetch
would have already marked it seen, so the next `UID SEARCH UNSEEN` would
never find it again — a silently lost order email. `.PEEK` keeps every poll
truly read-only regardless of when or whether persistence succeeds.

The real transport caps 100 UIDs, 1 MiB per raw message, 10 MiB total raw
mail, and 12 MiB cumulative socket response data. Limit failures reject the
complete batch before persistence; timeout aborts and destroys the socket.

## What's in the box

- `eml.ts` — deterministic RFC 5322/MIME reader (header unfolding,
  quoted-printable/base64 decoding, multipart walk); non-text leaves (e.g.
  an image/application attachment) are never treated as a body.
- `parser.ts` + `plugins/*` — the fixed-order plugin table (return-window →
  delivery → UPS/USPS shipping → Shopify/Amazon order confirmation →
  generic fallback); the fallback always matches and only returns
  `unparsed` — nothing is ever silently dropped.
- `sanitize.ts` — strips control characters from merchant name/order
  number/item title fields before they're persisted, so a hostile email
  can't inject a fake extra line into ICS text or MCP tool output.
- `store.ts` — the merged order graph (0600 JSON + an append-only 0600
  `unparsed-emails.jsonl`).
- `ics.ts` — RFC 5545 ICS export for a return-window deadline.
- `reminders.ts` — `runReturnWindowReminders`, reusing the shared low-level
  `publishNtfy` transport from `@northcinder/watches` (not the price-flavored
  `Notifier`, whose copy would be factually wrong for a return reminder).
- `ingest/drop-dir.ts` / `ingest/imap.ts` — the two ingest sources.
