import { z } from "zod";

/**
 * Permission-scope host entry: a bare hostname ("catalog.shopify.com",
 * "localhost") or a subdomain wildcard ("*.myshopify.com"). Never a scheme,
 * path, port, or global wildcard — an adapter's network reach is explicit
 * and narrow (spec §6 security standard).
 */
const HOSTNAME_LABEL = "[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?";
const HOST_PATTERN = new RegExp(
  `^(\\*\\.)?${HOSTNAME_LABEL}(\\.${HOSTNAME_LABEL})*$`,
);

export const AllowedHostSchema = z
  .string()
  .min(1)
  .refine(
    (h) =>
      h !== "*" &&
      !h.startsWith("*.*") &&
      HOST_PATTERN.test(h) &&
      // A wildcard must scope at least two labels after "*." (e.g.
      // "*.myshopify.com", not the effectively-unbounded "*.com").
      (!h.startsWith("*.") || h.slice(2).split(".").length >= 2),
    {
      message:
        "allowedHosts entries must be bare hostnames or subdomain wildcards scoped to ≥2 labels (e.g. \"api.ebay.com\", \"*.myshopify.com\") — no schemes, paths, ports, global wildcards, or bare-TLD wildcards like \"*.com\"",
    },
  );

export const AdapterPermissionsSchema = z.object({
  /**
   * Hosts this adapter is allowed to contact. Empty array = no network access
   * (e.g. an in-memory or fixture-only adapter).
   */
  allowedHosts: z.array(AllowedHostSchema),
  /**
   * Whether the adapter may act inside the user's own logged-in browser
   * session (spec §3A — e.g. the Amazon edge adapter). Must be declared
   * explicitly; there is no default.
   */
  userSession: z.boolean(),
});
export type AdapterPermissions = z.infer<typeof AdapterPermissionsSchema>;

/**
 * Adapter identity + permission scope. Every adapter ships one, and the
 * conformance harness gates on it.
 */
export const AdapterManifestSchema = z.object({
  /**
   * Stable adapter/store id (lowercase slug). Every Offer the adapter emits
   * must carry this exact value as `sourceStore` (provenance).
   */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase slug"),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "semver"),
  description: z.string().optional(),
  permissions: AdapterPermissionsSchema,
  capabilities: z.object({
    /** search + getOffer are mandatory for every adapter; checkout is opt-in. */
    checkout: z.boolean(),
  }),
});
export type AdapterManifest = z.infer<typeof AdapterManifestSchema>;
