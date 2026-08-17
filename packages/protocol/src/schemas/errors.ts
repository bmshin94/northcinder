import { z } from "zod";

/**
 * Structured error vocabulary for store/adapter failures. Adapters NEVER
 * throw across the SDK boundary — they resolve with one of these (graceful
 * degradation: one store failing never fails the search).
 */
export const StoreErrorCodeSchema = z.enum([
  "timeout",
  "unavailable",
  "not_configured",
  "blocked",
  "not_found",
  "invalid_response",
  "rate_limited",
  "permission_denied",
  "internal",
]);
export type StoreErrorCode = z.infer<typeof StoreErrorCodeSchema>;

export const StoreErrorSchema = z.object({
  code: StoreErrorCodeSchema,
  message: z.string().min(1),
  /** Which store/adapter produced the error (AdapterManifest.id). */
  store: z.string().min(1),
  /** Whether the caller may sensibly retry (with backoff). */
  retryable: z.boolean(),
  /** Optional structured context (never secrets, never raw credentials). */
  details: z.record(z.string(), z.unknown()).optional(),
});
export type StoreError = z.infer<typeof StoreErrorSchema>;

/** Structured error shape for the client↔service HTTP API. */
export const ServiceErrorSchema = z.object({
  code: z.enum(["unauthorized", "invalid_request", "payload_too_large", "not_found", "rate_limited", "internal"]),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ServiceError = z.infer<typeof ServiceErrorSchema>;

/** Convenience constructor keeping error creation uniform across adapters. */
export function storeError(
  store: string,
  code: StoreErrorCode,
  message: string,
  opts?: { retryable?: boolean; details?: Record<string, unknown> },
): StoreError {
  const retryable = opts?.retryable ?? (code === "timeout" || code === "rate_limited" || code === "unavailable");
  return {
    code,
    message,
    store,
    retryable,
    ...(opts?.details !== undefined ? { details: opts.details } : {}),
  };
}
