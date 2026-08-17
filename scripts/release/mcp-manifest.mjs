import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Validator } from "jsonschema";

export const OFFICIAL_SCHEMA_URL = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
// Updating this pin is a deliberate review event: an upstream schema change must not silently pass.
export const OFFICIAL_SCHEMA_SHA256 = "3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0";
const PLACEHOLDER = /(?:^|[./-])(example|placeholder|replace[-_]?me|your[-_]?org|your[-_]?repo)(?:$|[./-])/i;

export async function fetchOfficialSchema({ fetch: fetchImpl = globalThis.fetch, expectedSha256 = OFFICIAL_SCHEMA_SHA256 } = {}) {
  const response = await fetchImpl(OFFICIAL_SCHEMA_URL);
  if (!response?.ok) throw new Error(`official MCP schema fetch failed: HTTP ${response?.status ?? "no response"}`);
  const body = await response.text();
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== expectedSha256) throw new Error(`official MCP schema digest mismatch: expected ${expectedSha256}, got ${digest}`);
  let schema;
  try { schema = JSON.parse(body); } catch { throw new Error("official MCP schema is not valid JSON"); }
  if (schema.$id !== OFFICIAL_SCHEMA_URL) throw new Error(`official MCP schema $id mismatch: expected ${OFFICIAL_SCHEMA_URL}, got ${schema.$id}`);
  return schema;
}

export function validateCoordinates(coordinates) {
  const required = ["publisherNamespace", "repositoryUrl", "packageIdentifier"];
  for (const key of required) if (!coordinates[key]) throw new Error(`${key} is required for a release manifest`);
  if (coordinates.verified !== true) throw new Error("verified owner coordinates are required for a release manifest");
  for (const [key, value] of Object.entries(coordinates)) {
    if (typeof value !== "string") continue;
    if (/["\\\u0000-\u001f]/.test(value)) throw new Error(`${key} contains unsafe JSON characters`);
    if (PLACEHOLDER.test(value)) throw new Error(`${key} contains a placeholder or example coordinate`);
  }
  if (!/^https:\/\//.test(coordinates.repositoryUrl)) throw new Error("repositoryUrl must be an HTTPS URL");
  if (!/^[a-z0-9.-]+$/i.test(coordinates.publisherNamespace)) throw new Error("publisherNamespace must be a reverse-DNS namespace");
  if (!coordinates.packageIdentifier.startsWith("@northcinder/")) throw new Error("packageIdentifier must be a @northcinder package coordinate");
  if (coordinates.remoteUrl && !/^https:\/\//.test(coordinates.remoteUrl)) throw new Error("remoteUrl must be an HTTPS URL");
}

export function generateManifest(templatePath, coordinates) {
  validateCoordinates(coordinates);
  const raw = readFileSync(templatePath, "utf8");
  const requiredTokens = [...new Set([...raw.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]))];
  if (!requiredTokens.length) throw new Error(`${templatePath} is not a controlled MCP manifest template`);
  const output = raw.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (coordinates[key] === undefined) throw new Error(`${key} is required by ${templatePath}`);
    // Tokens are permitted only inside JSON string literals. Escaping their
    // content (rather than splicing raw text) prevents member injection.
    return JSON.stringify(String(coordinates[key])).slice(1, -1);
  });
  if (/\{\{\w+\}\}/.test(output)) throw new Error(`${templatePath} has unresolved coordinate tokens`);
  const manifest = JSON.parse(output);
  const client = templatePath.includes("client/");
  if (manifest.name !== `${coordinates.publisherNamespace}/${client ? "northcinder-mcp" : "northcinder-mcp-remote"}` || manifest.repository?.url !== coordinates.repositoryUrl) throw new Error("generated manifest fixed identity shape mismatch");
  if (client ? manifest.packages?.[0]?.identifier !== coordinates.packageIdentifier : manifest.remotes?.[0]?.url !== coordinates.remoteUrl) throw new Error("generated manifest controlled coordinate shape mismatch");
  return manifest;
}

/** Uses jsonschema 1.5.0's complete draft-07 and format support; errors retain schema paths. */
export function validateOfficialSchema(value, schema) {
  const validator = new Validator();
  return validator.validate(value, schema, { nestedErrors: true }).errors.map((error) => `${error.property || "$"}: ${error.message}`);
}
