import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createFileNotifier,
  createNtfyNotifier,
  createStderrNotifier,
  createWebhookNotifier,
  formatNotification,
  type WatchNotification,
} from "../src/index.js";

const NOTIFICATION: WatchNotification = {
  watchId: "watch_abc",
  watchName: "Fairphone below 550",
  currentPrice: { amount: 54900, currency: "EUR" },
  targetPrice: { amount: 55000, currency: "EUR" },
  merchantName: "Shop Example",
  merchantId: "shop.example",
  productTitle: "Fairphone 5 128GB",
  url: "https://shop.example/p1",
  dedupeKey: "watch_abc:EUR:99",
  at: "2026-07-05T12:00:00.000Z",
};

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

function fakeServer(status = 200): Promise<{ server: Server; port: number; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.statusCode = status;
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0, requests });
    });
  });
}

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

describe("notification content (composed by code, deterministic)", () => {
  it("carries watch name, current vs target price, merchant, and the deep link — and NO purchase action", () => {
    const { title, body } = formatNotification(NOTIFICATION);
    expect(title).toBe('northcinder price watch: "Fairphone below 550" hit its target');
    expect(body).toContain("549.00 EUR");
    expect(body).toContain("550.00 EUR");
    expect(body).toContain("Shop Example");
    expect(body).toContain("https://shop.example/p1");
    expect(body).toContain("never buys");
    // Watches NOTIFY. The message must not offer/perform any purchase action.
    expect(body).not.toMatch(/complete_checkout|approve_purchase|auto[- ]?buy|buy now/i);
  });
});

describe("ntfy notifier (against a local fake ntfy — no real network)", () => {
  it("POSTs the composed message to the topic with Title and Click headers", async () => {
    const { server, port, requests } = await fakeServer(200);
    servers.push(server);
    const notifier = createNtfyNotifier({ topic: "long-random-topic", baseUrl: `http://127.0.0.1:${port}` });
    const result = await notifier.send(NOTIFICATION);
    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("/long-random-topic");
    expect(requests[0]!.headers["title"]).toBe('northcinder price watch: "Fairphone below 550" hit its target');
    expect(requests[0]!.headers["click"]).toBe("https://shop.example/p1");
    expect(requests[0]!.body).toContain("549.00 EUR");
  });

  it("HTTP failure returns a structured error that NEVER leaks the topic (topic = bearer secret)", async () => {
    const { server, port } = await fakeServer(500);
    servers.push(server);
    const notifier = createNtfyNotifier({ topic: "secret-topic-value", baseUrl: `http://127.0.0.1:${port}` });
    const result = await notifier.send(NOTIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ntfy_http_error");
      expect(result.error.message).toContain("HTTP 500");
      expect(JSON.stringify(result)).not.toContain("secret-topic-value");
    }
  });

  it("unreachable ntfy resolves with a structured error (budgeted, never throws)", async () => {
    const notifier = createNtfyNotifier({
      topic: "long-random-topic",
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 500,
    });
    const result = await notifier.send(NOTIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ntfy_unreachable");
  });
});

describe("webhook notifier (against a local fake server)", () => {
  it("POSTs the full structured notification as JSON", async () => {
    const { server, port, requests } = await fakeServer(200);
    servers.push(server);
    const notifier = createWebhookNotifier({ url: `http://127.0.0.1:${port}/hook` });
    const result = await notifier.send(NOTIFICATION);
    expect(result).toEqual({ ok: true });
    expect(requests[0]!.headers["content-type"]).toBe("application/json");
    const payload = JSON.parse(requests[0]!.body) as { title: string; body: string; notification: WatchNotification };
    expect(payload.notification.watchId).toBe("watch_abc");
    expect(payload.notification.currentPrice).toEqual({ amount: 54900, currency: "EUR" });
    expect(payload.title).toContain("Fairphone below 550");
  });

  it("webhook HTTP failure returns a structured error", async () => {
    const { server, port } = await fakeServer(503);
    servers.push(server);
    const notifier = createWebhookNotifier({ url: `http://127.0.0.1:${port}/hook`, timeoutMs: 2000 });
    const result = await notifier.send(NOTIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("webhook_http_error");
  });
});

describe("stderr + file notifiers", () => {
  it("stderr notifier writes the composed message to the given sink", async () => {
    const lines: string[] = [];
    const notifier = createStderrNotifier((s) => lines.push(s));
    const result = await notifier.send(NOTIFICATION);
    expect(result).toEqual({ ok: true });
    const out = lines.join("");
    expect(out).toContain("Fairphone below 550");
    expect(out).toContain("549.00 EUR");
    expect(out).toContain("https://shop.example/p1");
  });

  it("file notifier appends one JSONL line per notification to a 0600 file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "northcinder-watches-notify-"));
    const path = join(dir, "notifications.jsonl");
    const notifier = createFileNotifier(path);
    await notifier.send(NOTIFICATION);
    await notifier.send({ ...NOTIFICATION, at: "2026-07-05T13:00:00.000Z" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as WatchNotification;
    expect(first.watchId).toBe("watch_abc");
    expect(first.currentPrice).toEqual({ amount: 54900, currency: "EUR" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
