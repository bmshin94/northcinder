/**
 * The real IMAP transport must be READ-ONLY: `UID FETCH ... (BODY[])`
 * implicitly marks a message \Seen (a mailbox mutation, and a crash-safety
 * hazard — see ingest/imap.ts). Asserts the ISSUED FETCH command string uses
 * `BODY.PEEK[]`, by injecting a fake socket via the transport's connectImpl
 * hook rather than opening a live TLS connection.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createRealImapTransport } from "../src/ingest/imap.js";
import type { ImapConfig } from "../src/ingest/imap.js";

/** A minimal fake TLSSocket: captures every written command and scripts canned IMAP responses. */
class FakeImapSocket extends EventEmitter {
  public written: string[] = [];
  destroy(error?: Error): void {
    if (error) queueMicrotask(() => this.emit("error", error));
  }
  write(data: string): boolean {
    this.written.push(data);
    // Reply asynchronously (mirrors a real socket never resolving synchronously).
    setImmediate(() => this.respond(data));
    return true;
  }
  private respond(sent: string): void {
    const tag = sent.split(" ")[0]!;
    if (/LOGIN/.test(sent)) {
      this.emit("data", Buffer.from(`${tag} OK LOGIN completed\r\n`));
    } else if (/SELECT/.test(sent)) {
      this.emit("data", Buffer.from(`${tag} OK [READ-WRITE] SELECT completed\r\n`));
    } else if (/UID SEARCH UNSEEN/.test(sent)) {
      this.emit("data", Buffer.from(`* SEARCH 42\r\n${tag} OK UID SEARCH completed\r\n`));
    } else if (/UID FETCH/.test(sent)) {
      const body = "Order #1 no-op body";
      this.emit("data", Buffer.from(`* 1 FETCH (UID 42 BODY[] {${body.length}}\r\n${body})\r\n${tag} OK UID FETCH completed\r\n`));
    } else {
      this.emit("data", Buffer.from(`${tag} BAD unknown command\r\n`));
    }
  }
}

const CONFIG: ImapConfig = {
  host: "imap.example.com",
  port: 993,
  user: "jordan",
  password: "hunter2",
  mailbox: "INBOX",
  tls: true,
  timeoutMs: 5_000,
  maxMessages: 100,
  maxMessageBytes: 1_048_576,
  maxTotalBytes: 10_485_760,
  maxResponseBytes: 12_582_912,
};

describe("createRealImapTransport — read-only FETCH", () => {
  it("issues UID FETCH with BODY.PEEK[] (never bare BODY[], which marks \\Seen)", async () => {
    let fakeSocket: FakeImapSocket | undefined;
    const connectImpl = (() => {
      fakeSocket = new FakeImapSocket();
      // The greeting arrives unprompted, immediately after connect.
      setImmediate(() => fakeSocket!.emit("data", Buffer.from("* OK IMAP4rev1 ready\r\n")));
      return fakeSocket as unknown as ReturnType<typeof import("node:tls").connect>;
    }) as typeof import("node:tls").connect;

    const transport = createRealImapTransport(connectImpl);
    const result = await transport.fetchUnseen(CONFIG, new AbortController().signal);

    expect(result.messages).toEqual([{ uid: "42", raw: "Order #1 no-op body" }]);
    const fetchCommand = fakeSocket!.written.find((w) => /UID FETCH/.test(w));
    expect(fetchCommand).toBeDefined();
    expect(fetchCommand).toContain("BODY.PEEK[]");
    expect(fetchCommand).not.toMatch(/\(BODY\[\]\)/);
  });

  it("destroys the socket when cumulative response bytes exceed the cap across chunks", async () => {
    let fakeSocket: FakeImapSocket | undefined;
    const connectImpl = (() => {
      fakeSocket = new FakeImapSocket();
      setImmediate(() => fakeSocket!.emit("data", Buffer.from("* OK IMAP4rev1 ready\r\n")));
      return fakeSocket as unknown as ReturnType<typeof import("node:tls").connect>;
    }) as typeof import("node:tls").connect;
    const transport = createRealImapTransport(connectImpl);
    await expect(transport.fetchUnseen({ ...CONFIG, maxResponseBytes: 40 }, new AbortController().signal)).rejects.toMatchObject({
      code: "response_too_large",
    });
  });
});
