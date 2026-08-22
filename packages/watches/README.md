# @northcinder/watches

NorthCinder price watches notify the buyer when an exact offer or standing query reaches its target. A watch never buys. Opening the product link and starting a separate purchase authorization remains the buyer's choice.

## Scheduler

The `northcinder-watch` command performs the checks. The MCP server only creates and manages watch records; it does not run a hidden background loop.

```sh
northcinder-watch --once
northcinder-watch --interval 900
```

Exact-offer watches refresh the stored source and offer id. Query watches share identical searches within one tick. Provider cooldowns, last success, last failure, current price, and next eligible check time are stored with the watch.

Successful notifications are deduplicated by watch and price bucket. A crash after the destination accepts a message but before the local marker is stored can cause one later duplicate. Delivery is therefore at least once.

## Notification destinations

The model-facing `create_watch` tool can select only:

- stderr;
- the fixed `notifications.jsonl` file inside the buyer's config directory; or
- the scheduler's preconfigured `NORTHCINDER_NTFY_TOPIC`.

The caller cannot choose a file path, ntfy bearer topic, or webhook URL. Channel details are not returned in MCP results or audit lines.

Older watch files may contain a custom file path, ntfy topic, or webhook. The scheduler rejects file targets outside the buyer's config directory. Legacy webhooks require HTTPS, cannot contain URL credentials or fragments, cannot use localhost or an IP literal, and cannot redirect. NorthCinder does not resolve the hostname before the request, so DNS resolution and rebinding remain boundaries for an operator who retains a legacy webhook.

The public ntfy service has no account boundary for a topic. Anyone who knows the topic can read and publish notifications. Use a long random value, keep it in buyer-owned configuration, and consider a self-hosted ntfy instance when notification privacy requires it.

Notification content is composed by code from the watch name, current and target price, merchant, product title, and product link. It contains no purchase action.
