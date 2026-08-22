import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import {
  OFFICIAL_SCHEMA_URL,
  fetchOfficialSchema,
  generateManifest,
  validateCoordinates,
  validateOfficialSchema,
} from "../mcp-manifest.mjs";

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const coordinates = {
  publisherNamespace: "io.github.owner",
  repositoryUrl: "https://github.com/owner/northcinder",
  packageIdentifier: "@northcinder/client",
  remoteUrl: "https://mcp.owner.test/mcp",
  verified: true,
};

test("controlled client manifest validates against a freshly fetched official MCP schema", async () => {
  const schema = await fetchOfficialSchema();
  const manifest = generateManifest(join(ROOT, "client", "server.template.json"), coordinates);
  assert.equal(manifest.$schema, OFFICIAL_SCHEMA_URL);
  assert.deepEqual(validateOfficialSchema(manifest, schema), []);
  assert.ok(manifest.packages[0].environmentVariables.some((entry) => entry.name === "NORTHCINDER_CLIENT_KEY"));
});

test("controlled remote manifest validates against the current official MCP schema", () => {
  // A fresh source is deliberately required; this fixture supplies the digest contract only.
  const schema = { $id: OFFICIAL_SCHEMA_URL, definitions: { ServerDetail: { type: "object" } }, $ref: "#/definitions/ServerDetail" };
  const manifest = generateManifest(join(ROOT, "remote", "server.template.json"), coordinates);
  assert.deepEqual(validateOfficialSchema(manifest, schema), []);
});

test("draft-07 validation rejects official-schema transport enums and URI constraints", async () => {
  const schema = await fetchOfficialSchema();
  const manifest = generateManifest(join(ROOT, "client", "server.template.json"), coordinates);
  manifest.packages[0].transport.type = "not-a-schema-transport";
  manifest.repository.url = "not a uri";
  assert.match(validateOfficialSchema(manifest, schema).join("\n"), /transport|uri/i);
});

test("official schema fetch fails closed on stale id or tampered digest", async () => {
  const valid = JSON.stringify({ $id: OFFICIAL_SCHEMA_URL, definitions: { ServerDetail: { type: "object" } }, $ref: "#/definitions/ServerDetail" });
  const sha256 = createHash("sha256").update(valid).digest("hex");
  await assert.rejects(fetchOfficialSchema({ fetch: async () => new Response(valid), expectedSha256: "0".repeat(64) }), /digest/i);
  const stale = valid.replace(OFFICIAL_SCHEMA_URL, "https://stale.invalid/schema");
  await assert.rejects(fetchOfficialSchema({ fetch: async () => new Response(stale), expectedSha256: createHash("sha256").update(stale).digest("hex") }), /\$id/i);
});

test("release coordinates reject missing, placeholder, and unverified values before generation", () => {
  assert.throws(() => validateCoordinates({ ...coordinates, publisherNamespace: "" }), /publisherNamespace is required/);
  assert.throws(() => validateCoordinates({ ...coordinates, repositoryUrl: "https://github.com/example/northcinder" }), /placeholder or example/);
  assert.throws(() => validateCoordinates({ ...coordinates, remoteUrl: "https://mcp.northcinder.example/mcp" }), /placeholder or example/);
  assert.throws(() => validateCoordinates({ ...coordinates, packageIdentifier: "@northcinder/client", verified: false }), /verified owner coordinates/);
});

test("quote-bearing coordinates cannot inject or rewrite generated manifest fields", () => {
  const injected = { ...coordinates, repositoryUrl: 'https://owner.invalid/"}, "name":"attacker","repository":{"url":"https://owner.invalid' };
  assert.throws(() => generateManifest(join(ROOT, "client", "server.template.json"), injected), /unsafe JSON characters|HTTPS URL/);
  const manifest = generateManifest(join(ROOT, "client", "server.template.json"), coordinates);
  assert.equal(manifest.name, "io.github.owner/northcinder-mcp");
  assert.equal(manifest.repository.url, coordinates.repositoryUrl);
});
