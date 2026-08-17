/**
 * Untrusted-input sanitization for text fields sourced from a parsed email
 * (merchant name, item titles, order numbers) before they reach a persisted
 * `Order` record — and therefore before they reach ICS text or any MCP tool
 * output. A merchant name is attacker-controlled the moment any drop-directory or mailbox accepts
 * untrusted mail: an
 * embedded CR/LF or other C0 control character could otherwise inject a
 * fake extra "line" into the plain-text tool output the host agent reads
 * (a header/line-injection variant). `escapeIcsText` (ics.ts) separately
 * handles the ICS-specific escaping RFC 5545 requires; this is the earlier,
 * broader boundary — applied once at ingest so every downstream reader
 * (ICS, list_orders/get_order text + structuredContent, the dashboard) is
 * safe by construction rather than by each caller remembering to escape.
 */
export function sanitizeTextField(s: string): string {
  return s
    .replace(/[\r\n\t\x00-\x1F\x7F]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}
