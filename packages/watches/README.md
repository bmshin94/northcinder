# @northcinder/watches

Standing price watches: when a watched offer (or standing query) reaches your
target price, NorthCinder **notifies** you.

**A watch never buys.** There is no code path from a watch to checkout — this
package has no dependency on `@northcinder/checkout`, and an architectural test
(`test/no-checkout-path.test.ts`) fails the build if anyone ever adds one.
A notification only deep-links the product page; buying still requires the
normal, explicit, per-purchase human authorization flow.

## What's in the box

- **Store** — one `watches.json` (0600) in the NorthCinder config dir; atomic
  write-then-rename; fail-closed reads. Shared by the MCP tools
  (`create_watch` / `list_watches` / `cancel_watch`), the `northcinder-watch`
  scheduler, and the dashboard.
- **Checker** — re-fetches current offers through the client's existing
  budgeted service path (or any `OfferSource`), compares against the target,
  persists `lastCheckedAt`/`lastPrice`/`lastStatus` (crash-safe, idempotent
  resume). A store/adapter failure is a structured status; the watch stays
  active and retries next tick. Watches auto-expire (default ~6 months).
- **Notifications** — at-least-once, with a persisted dedupe ledger keyed by
  `watchId + priceBucket` (bucket = 1% of the target price), so a restarted
  scheduler never re-spams the same hit, while a further real price drop is
  news and notifies again.
- **`Notifier`** — minimal interface (`id` + `send`) with four
  implementations: `ntfy`, `stderr`, `file` (JSONL, 0600), `webhook`.

## Running the scheduler

The `northcinder-watch` bin ships with `@northcinder/client`. Two modes, no daemon
manager needed:

```sh
northcinder-watch --once             # one tick over all active watches, then exit
northcinder-watch --interval 900     # long-running loop (seconds; default 900)
```

Environment: the same `NORTHCINDER_SERVICE_URL` / `NORTHCINDER_CLIENT_KEY` /
`NORTHCINDER_CONFIG_DIR` as `northcinder-mcp`, plus `NORTHCINDER_NTFY_TOPIC`,
`NORTHCINDER_NTFY_BASE_URL` (default `https://ntfy.sh`), `NORTHCINDER_WATCH_INTERVAL_S`.

### cron (every 15 minutes)

```cron
*/15 * * * * NORTHCINDER_SERVICE_URL=http://127.0.0.1:8790 NORTHCINDER_CLIENT_KEY=… NORTHCINDER_NTFY_TOPIC=… /usr/local/bin/northcinder-watch --once >> ~/.config/northcinder/watch-cron.log 2>&1
```

`--once` exits **1 when every check failed** (service unreachable / nothing
deliverable), so cron's failure mail / your monitoring sees a fully-failed
tick. Partial failure — some watches erroring while others check fine — is a
normal, reported state and exits 0.

### launchd (macOS)

`~/Library/LaunchAgents/com.northcinder.watch.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.northcinder.watch</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/northcinder-watch</string>
    <string>--once</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>EnvironmentVariables</key><dict>
    <key>NORTHCINDER_SERVICE_URL</key><string>http://127.0.0.1:8790</string>
    <key>NORTHCINDER_CLIENT_KEY</key><string>REPLACE_ME</string>
    <key>NORTHCINDER_NTFY_TOPIC</key><string>REPLACE_ME</string>
  </dict>
  <key>StandardErrorPath</key><string>/tmp/northcinder-watch.log</string>
</dict></plist>
```

Load it with `launchctl load ~/Library/LaunchAgents/com.northcinder.watch.plist`.

## ntfy: your topic IS the secret

ntfy (https://ntfy.sh) has no accounts on the public instance — **anyone who
knows your topic name can read your notifications and post to them**. Treat
the topic like a bearer token:

- generate a long random topic, e.g. `openssl rand -hex 16`;
- never reuse a guessable name (`northcinder`, your username, …);
- NorthCinder stores it only in the 0600 `watches.json`/environment and never
  echoes it into tool results, logs, audit lines, or error messages;
- for stronger privacy, self-host ntfy and point `NORTHCINDER_NTFY_BASE_URL` at it.

## Notification content

Composed by code (never a model): watch name, current vs target price,
merchant, and a link to the product page — and **no purchase action of any
kind**. Opening the link and starting a normal authorization is always the
human's move.
