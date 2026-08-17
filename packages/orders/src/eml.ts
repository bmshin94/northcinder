/**
 * Deterministic .eml (RFC 5322 + MIME) reader. NOT a general-purpose email
 * client — just enough structural parsing (headers, header unfolding,
 * multipart/*, quoted-printable + base64 transfer-decoding) to hand a clean
 * {subject, from, date, textBody, htmlBody} to the deterministic order
 * parser plugins. No LLM anywhere in this path (determinism law): every
 * decision here is a fixed rule over RFC-defined syntax, never a model guess.
 */

export interface ParsedEmail {
  messageId: string;
  subject: string;
  /** Raw From header value, e.g. `"Shopify Store" <no-reply@shop.example.com>`. */
  from: string;
  fromAddress: string;
  fromDomain: string;
  /** ISO 8601 datetime parsed from the Date header. Falls back to epoch-ish "now" only if unparsable. */
  date: string;
  textBody: string;
  htmlBody?: string;
}

interface MimeNode {
  headers: Map<string, string>;
  body: string; // raw (still transfer-encoded) body bytes as a string
}

function splitHeadersAndBody(raw: string): { headerBlock: string; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const sep = normalized.indexOf("\n\n");
  if (sep === -1) return { headerBlock: normalized, body: "" };
  return { headerBlock: normalized.slice(0, sep), body: normalized.slice(sep + 2) };
}

function parseHeaders(headerBlock: string): Map<string, string> {
  // RFC 5322 header folding: a continuation line starts with whitespace.
  const lines = headerBlock.split("\n");
  const unfolded: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] = `${unfolded[unfolded.length - 1]} ${line.trim()}`;
    } else {
      unfolded.push(line);
    }
  }
  const headers = new Map<string, string>();
  for (const line of unfolded) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    // Later same-name headers (rare, malformed mail) never overwrite the first — first wins, deterministic.
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

function parseNode(raw: string): MimeNode {
  const { headerBlock, body } = splitHeadersAndBody(raw);
  return { headers: parseHeaders(headerBlock), body };
}

function decodeQuotedPrintable(input: string): string {
  // Soft line breaks: "=\n" is a folding artifact, not a real newline.
  const joined = input.replace(/=\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const ch = joined[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeBody(body: string, transferEncoding: string | undefined): string {
  const enc = (transferEncoding ?? "7bit").toLowerCase();
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  if (enc === "base64") {
    try {
      return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return body;
    }
  }
  return body; // 7bit / 8bit / binary: pass through
}

function extractBoundary(contentType: string): string | undefined {
  const m = /boundary="?([^";]+)"?/i.exec(contentType);
  return m?.[1];
}

/** Splits a multipart body on its boundary into raw per-part strings (headers+body each, undecoded). */
function splitMultipart(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const parts = body.split(marker);
  // First segment (preamble) and last segment (epilogue, starts with "--") are not parts.
  return parts.slice(1, -1).map((p) => p.replace(/^\n/, "").replace(/\n$/, ""));
}

/** Recursively walks a MIME tree and collects the first text/plain and text/html leaf bodies (decoded). */
function collectBodies(raw: string): { text?: string; html?: string } {
  const node = parseNode(raw);
  const contentType = node.headers.get("content-type") ?? "text/plain";
  const mimeType = contentType.split(";")[0]!.trim().toLowerCase();

  if (mimeType.startsWith("multipart/")) {
    const boundary = extractBoundary(contentType);
    if (!boundary) return {};
    let text: string | undefined;
    let html: string | undefined;
    for (const partRaw of splitMultipart(node.body, boundary)) {
      const inner = collectBodies(partRaw);
      text = text ?? inner.text;
      html = html ?? inner.html;
    }
    const result: { text?: string; html?: string } = {};
    if (text !== undefined) result.text = text;
    if (html !== undefined) result.html = html;
    return result;
  }

  if (mimeType === "text/html") return { html: decodeBody(node.body, node.headers.get("content-transfer-encoding")) };
  if (mimeType.startsWith("text/")) return { text: decodeBody(node.body, node.headers.get("content-transfer-encoding")) };
  // A non-text leaf (e.g. an image/application attachment) is not a body —
  // decoding it as "text" would splice binary garbage (including embedded
  // control/null bytes) into the deterministic parser's textBody input.
  return {};
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*\n+/g, "\n")
    .trim();
}

function parseFromHeader(from: string): { address: string; domain: string } {
  const m = /<([^>]+)>/.exec(from);
  const address = (m ? m[1]! : from).trim().toLowerCase();
  const domain = address.split("@")[1] ?? "";
  return { address, domain };
}

function parseDateHeader(value: string | undefined): string {
  if (value) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  // No usable Date header: deterministic, obviously-a-fallback sentinel rather
  // than silently claiming "now" as the email's timestamp.
  return new Date(0).toISOString();
}

export function parseEml(raw: string): ParsedEmail {
  const node = parseNode(raw);
  const { text, html } = collectBodies(raw);
  const from = node.headers.get("from") ?? "";
  const { address, domain } = parseFromHeader(from);
  const textBody = text ?? (html ? stripHtml(html) : "");
  const result: ParsedEmail = {
    messageId: (node.headers.get("message-id") ?? "").replace(/^<|>$/g, "") || `no-id-${domain}-${node.headers.get("date") ?? ""}`,
    subject: node.headers.get("subject") ?? "",
    from,
    fromAddress: address,
    fromDomain: domain,
    date: parseDateHeader(node.headers.get("date")),
    textBody,
  };
  if (html !== undefined) result.htmlBody = html;
  return result;
}
