/**
 * IMAP poll path (read-only, budgeted): the MVP remote email source. Env-
 * gated exactly like the profile/watch gated paths (NORTHCINDER_ACP_MERCHANTS-style):
 * missing config → a structured `not_configured` result, NEVER a fake
 * success. Credentials are 0600-file/env only — never logged, never echoed
 * in an error message (leak discipline).
 *
 * The real socket transport (`createRealImapTransport`) is a minimal,
 * READ-ONLY IMAP4rev1 client (LOGIN, SELECT, UID SEARCH UNSEEN, UID FETCH
 * BODY.PEEK[]) — enough to pull unseen order-mail WITHOUT marking it \Seen
 * (plain `BODY[]` implicitly sets \Seen — a mutation of the user's mailbox,
 * and a crash-safety hazard: if the process dies after the fetch but before
 * the ingested result is persisted, a re-run's `UID SEARCH UNSEEN` would no
 * longer find the message, silently losing it). `.PEEK` keeps the read
 * truly read-only regardless of when/whether persistence succeeds. Every
 * poll is wrapped in a hard timeout budget (a hand-rolled budget over a raw
 * socket, since IMAP is not HTTP — `@northcinder/adapter-kit`'s `fetchWithBudget`
 * only budgets `fetch()` calls and is not used here). The socket factory is
 * injectable (`connectImpl`) so the fetch COMMAND STRING itself (not just
 * the gating behavior) can be asserted offline without a live IMAP server.
 */
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { createHash } from "node:crypto";
import type { OrderGraphStore } from "../store.js";

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
  tls: boolean;
  timeoutMs: number;
  maxMessages: number;
  maxMessageBytes: number;
  maxTotalBytes: number;
  maxResponseBytes: number;
}

export type ImapPollError = {
  code: "not_configured" | "connection_failed" | "auth_failed" | "protocol_error" | "timeout" | "unauthenticated" | "message_limit_exceeded";
  message: string;
};

export type ImapPollResult = { ok: true; ingested: number } | { ok: false; error: ImapPollError };

const MAX_MESSAGES = 100;
const MAX_MESSAGE_BYTES = 1_048_576;
const MAX_TOTAL_BYTES = 10_485_760;
const MAX_RESPONSE_BYTES = 12_582_912;

/** Reads NORTHCINDER_ORDERS_IMAP_HOST/USER/(PASSWORD|TOKEN)/PORT/MAILBOX/TLS. Returns undefined if not configured. */
export function loadImapConfigFromEnv(env: Record<string, string | undefined> = process.env): ImapConfig | undefined {
  const host = env.NORTHCINDER_ORDERS_IMAP_HOST;
  const user = env.NORTHCINDER_ORDERS_IMAP_USER;
  const secret = env.NORTHCINDER_ORDERS_IMAP_PASSWORD ?? env.NORTHCINDER_ORDERS_IMAP_TOKEN;
  if (!host || !user || !secret) return undefined;
  const portRaw = env.NORTHCINDER_ORDERS_IMAP_PORT;
  const tlsFlag = (env.NORTHCINDER_ORDERS_IMAP_TLS ?? "1").trim().toLowerCase();
  const timeoutRaw = env.NORTHCINDER_ORDERS_IMAP_TIMEOUT_MS;
  const timeoutMs = timeoutRaw === undefined || timeoutRaw === "" ? 20_000 : Number(timeoutRaw);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error("NORTHCINDER_ORDERS_IMAP_TIMEOUT_MS must be a positive integer no greater than 120000");
  }
  return {
    host,
    user,
    password: secret,
    port: portRaw ? Number.parseInt(portRaw, 10) : 993,
    mailbox: env.NORTHCINDER_ORDERS_IMAP_MAILBOX ?? "INBOX",
    tls: !["0", "false", "off", "no"].includes(tlsFlag),
    timeoutMs,
    maxMessages: MAX_MESSAGES,
    maxMessageBytes: MAX_MESSAGE_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    maxResponseBytes: MAX_RESPONSE_BYTES,
  };
}

export interface ImapRawMessage {
  uid: string;
  raw: string;
}

/**
 * A provider adapter may supply this only from a provider-authenticated metadata
 * API. It is deliberately separate from RFC 5322 bytes: mail headers, including
 * Authentication-Results, are attacker-controlled input at this boundary.
 */
export interface ProviderAuthentication {
  uid: string;
  rawSha256: string;
  status: "pass";
}

export interface ImapFetchResult {
  messages: ImapRawMessage[];
  providerAuthentication?: ProviderAuthentication[];
}

/** Injectable so tests or a provider-specific metadata adapter never open a real socket. */
export interface ImapTransport {
  fetchUnseen(config: ImapConfig, signal: AbortSignal): Promise<ImapFetchResult>;
}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(Object.assign(new Error("timeout"), { code: "timeout" }));
    }, ms);
    run(controller.signal).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(timedOut ? Object.assign(new Error("timeout"), { code: "timeout" }) : e);
      },
    );
  });
}

/**
 * Minimal read-only IMAP4rev1 transport over a real TLS socket. Parses
 * literal responses ({n}\r\n<n bytes>) well enough to pull raw RFC 5322
 * message text out of `UID FETCH ... (BODY[])`. Not covered by the offline
 * test suite by design (no live IMAP server available offline) — the
 * gating/env behavior above and the merge logic downstream are what's
 * tested; this function is exercised manually against a real mailbox.
 */
export function createRealImapTransport(connectImpl: typeof tlsConnect = tlsConnect): ImapTransport {
  return {
    async fetchUnseen(config, signal) {
      const socket: TLSSocket = connectImpl({ host: config.host, port: config.port, servername: config.host });
      let buffer = Buffer.alloc(0);
      let receivedBytes = 0;
      const waiters: Array<{ resolve: (chunk: Buffer) => void }> = [];
      socket.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
        buffer = Buffer.concat([buffer, chunk]);
        if (receivedBytes > config.maxResponseBytes) {
          socket.destroy(Object.assign(new Error("response_too_large"), { code: "response_too_large" }));
          return;
        }
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(buffer);
      });
      const errored = new Promise<never>((_, reject) => socket.once("error", reject));
      const abort = (): void => {
        socket.destroy(Object.assign(new Error("aborted"), { code: "aborted" }));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });

      async function readUntil(marker: string): Promise<string> {
        for (;;) {
          const idx = buffer.indexOf(marker);
          if (idx !== -1) {
            const text = buffer.subarray(0, idx + marker.length).toString("utf8");
            buffer = buffer.subarray(idx + marker.length);
            return text;
          }
          await Promise.race([new Promise<void>((resolve) => waiters.push({ resolve: () => resolve() })), errored]);
        }
      }

      let tag = 0;
      function nextTag(): string {
        tag += 1;
        return `A${tag}`;
      }
      async function command(cmd: string): Promise<string> {
        const t = nextTag();
        socket.write(`${t} ${cmd}\r\n`);
        let acc = "";
        for (;;) {
          acc += await readUntil("\r\n");
          if (acc.includes(`${t} OK`) || acc.includes(`${t} NO`) || acc.includes(`${t} BAD`)) return acc;
        }
      }

      try {
        await readUntil("\r\n"); // greeting
        const loginResp = await command(`LOGIN ${JSON.stringify(config.user)} ${JSON.stringify(config.password)}`);
        if (!loginResp.includes("OK")) throw Object.assign(new Error("auth_failed"), { code: "auth_failed" });
        const selectResp = await command(`SELECT ${config.mailbox}`);
        if (!selectResp.includes("OK")) throw Object.assign(new Error("protocol_error"), { code: "protocol_error" });
        const searchResp = await command("UID SEARCH UNSEEN");
        const searchLine = /\* SEARCH([^\r\n]*)/.exec(searchResp);
        const uids = (searchLine?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
        if (uids.length === 0) return { messages: [] };
        if (uids.length > config.maxMessages) throw Object.assign(new Error("message_limit_exceeded"), { code: "message_limit_exceeded" });
        // BODY.PEEK[] (not BODY[]) — read-only, never marks the message \Seen.
        const fetchResp = await command(`UID FETCH ${uids.join(",")} (BODY.PEEK[])`);
        const messages: ImapRawMessage[] = [];
        const literalRe = /UID\s+(\d+)[\s\S]*?\{(\d+)\}\r\n/g;
        let match: RegExpExecArray | null;
        while ((match = literalRe.exec(fetchResp))) {
          const len = Number.parseInt(match[2]!, 10);
          if (len > config.maxMessageBytes) throw Object.assign(new Error("message_limit_exceeded"), { code: "message_limit_exceeded" });
          const start = match.index + match[0].length;
          messages.push({ uid: match[1]!, raw: fetchResp.slice(start, start + len) });
        }
        return { messages };
      } finally {
        signal.removeEventListener("abort", abort);
        socket.destroy();
      }
    },
  };
}

/** Polls IMAP for unseen order mail and ingests each. Structured `not_configured` if creds are absent — never a fake success. */
export async function pollImap(
  store: OrderGraphStore,
  deps: { env?: Record<string, string | undefined>; transport?: ImapTransport } = {},
): Promise<ImapPollResult> {
  const config = loadImapConfigFromEnv(deps.env ?? process.env);
  if (!config) {
    return {
      ok: false,
      error: { code: "not_configured", message: "IMAP is not configured (set NORTHCINDER_ORDERS_IMAP_HOST/USER/PASSWORD)" },
    };
  }
  const transport = deps.transport ?? createRealImapTransport();
  try {
    const fetched = await withTimeout((signal) => transport.fetchUnseen(config, signal), config.timeoutMs);
    if (fetched.messages.length > config.maxMessages) {
      return { ok: false, error: { code: "message_limit_exceeded", message: "IMAP poll exceeded the configured message limit; refusing partial ingest" } };
    }
    let totalBytes = 0;
    for (const message of fetched.messages) {
      const bytes = Buffer.byteLength(message.raw, "utf8");
      totalBytes += bytes;
      if (bytes > config.maxMessageBytes || totalBytes > config.maxTotalBytes) {
        return { ok: false, error: { code: "message_limit_exceeded", message: "IMAP poll exceeded the configured byte limit; refusing partial ingest" } };
      }
    }
    const authenticated = new Map((fetched.providerAuthentication ?? []).map((entry) => [entry.uid, entry]));
    for (const message of fetched.messages) {
      const envelope = authenticated.get(message.uid);
      if (!envelope || envelope.status !== "pass" || envelope.rawSha256 !== createHash("sha256").update(message.raw).digest("hex")) {
        return { ok: false, error: { code: "unauthenticated", message: "IMAP mail has no separately provider-authenticated metadata bound to its UID and message bytes; refusing unattended ingest" } };
      }
    }
    for (const message of fetched.messages) store.ingestEml(message.raw, "imap");
    return { ok: true, ingested: fetched.messages.length };
  } catch (cause) {
    // Never echo host/user/password in the error text (leak discipline).
    const code = (cause as { code?: string })?.code;
    if (code === "timeout" || (cause instanceof Error && cause.message === "timeout")) {
      return { ok: false, error: { code: "timeout", message: "IMAP poll timed out" } };
    }
    if (code === "message_limit_exceeded" || code === "response_too_large") {
      return { ok: false, error: { code: "message_limit_exceeded", message: "IMAP poll exceeded a response limit; refusing partial ingest" } };
    }
    return {
      ok: false,
      error: { code: code === "auth_failed" || code === "protocol_error" ? code : "connection_failed", message: "IMAP poll failed (connection or protocol error)" },
    };
  }
}
