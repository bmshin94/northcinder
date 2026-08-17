/**
 * Structural validator for an MCPB (Desktop Extension) manifest.json against
 * the field shape documented at anthropics/dxt MANIFEST.md (manifest_version
 * 0.3/0.4): required root fields, server.type/entry_point, and per the spec
 * "the sensitive flag applies exclusively to string-type configurations".
 * This is not a full JSON Schema; it checks the fields NorthCinder relies on to reject a broken manifest.
 */
const VALID_SERVER_TYPES = new Set(["node", "python", "binary", "uv"]);
const VALID_CONFIG_TYPES = new Set(["string", "number", "boolean", "directory", "file"]);

export function validateMcpbManifest(manifest) {
  const errors = [];
  const require_ = (field, type) => {
    if (manifest[field] === undefined) errors.push(`missing required field: ${field}`);
    else if (type && typeof manifest[field] !== type) errors.push(`field ${field} must be a ${type}`);
  };

  require_("manifest_version", "string");
  require_("name", "string");
  require_("version", "string");
  require_("description", "string");
  require_("author");
  require_("server");

  if (manifest.author !== undefined && typeof manifest.author !== "object") {
    errors.push("author must be an object");
  }

  const server = manifest.server;
  if (server && typeof server === "object") {
    if (!VALID_SERVER_TYPES.has(server.type)) {
      errors.push(`server.type must be one of ${[...VALID_SERVER_TYPES].join(", ")}, got ${server.type}`);
    }
    if (typeof server.entry_point !== "string" || server.entry_point.length === 0) {
      errors.push("server.entry_point is required and must be a non-empty string");
    }
    if (server.mcp_config) {
      if (typeof server.mcp_config.command !== "string") errors.push("server.mcp_config.command must be a string");
      if (!Array.isArray(server.mcp_config.args)) errors.push("server.mcp_config.args must be an array");
    }
  }

  if (manifest.user_config !== undefined) {
    for (const [key, def] of Object.entries(manifest.user_config)) {
      if (!VALID_CONFIG_TYPES.has(def.type)) {
        errors.push(`user_config.${key}.type must be one of ${[...VALID_CONFIG_TYPES].join(", ")}, got ${def.type}`);
      }
      if (def.sensitive !== undefined) {
        if (def.type !== "string") errors.push(`user_config.${key}: "sensitive" is only valid on type "string"`);
        if (typeof def.sensitive !== "boolean") errors.push(`user_config.${key}.sensitive must be a boolean`);
      }
    }
  }

  return errors;
}
