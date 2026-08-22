import { validateCredentialedBaseUrl } from "@northcinder/protocol";

/**
 * Configuration and logging boundary for the remote bridge's upstream URL.
 * Userinfo is not supported: the bridge authenticates with NORTHCINDER_SERVICE_KEY,
 * and accepting credentials in an URL risks exposing them through diagnostics.
 */
export function parseRemoteServiceUrl(value: string): string {
  const validated = validateCredentialedBaseUrl(value, { allowLoopbackHttp: true });
  if (!validated.ok) {
    throw new Error(
      "NORTHCINDER_SERVICE_URL must use HTTPS, except explicit loopback HTTP, and must not contain URL userinfo, query, or fragment; use NORTHCINDER_SERVICE_KEY",
    );
  }
  return validated.url.toString();
}

/** Keep the self-hoster's topology and any future URL components out of startup logs. */
export function remoteUpstreamLogLine(_serviceUrl: string): string {
  return "[northcinder-remote] deployer-owned engine configured";
}

/** Report only a count; configured client identifiers may be account-identifying. */
export function remoteClientKeyLogLine(count: number): string {
  return `[northcinder-remote] registered client keys: ${count}`;
}
