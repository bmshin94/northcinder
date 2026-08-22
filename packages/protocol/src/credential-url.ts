export type CredentialedUrlIssue =
  | "invalid"
  | "unsupported_protocol"
  | "insecure_transport"
  | "userinfo"
  | "query"
  | "fragment";

export type CredentialedUrlValidation =
  | { ok: true; url: URL }
  | { ok: false; issue: CredentialedUrlIssue };

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

/** Validate a base URL before a bearer credential can be attached to it. */
export function validateCredentialedBaseUrl(
  value: string,
  options: { allowLoopbackHttp: boolean },
): CredentialedUrlValidation {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, issue: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, issue: "unsupported_protocol" };
  }
  if (url.username !== "" || url.password !== "") return { ok: false, issue: "userinfo" };
  if (url.search !== "") return { ok: false, issue: "query" };
  if (url.hash !== "") return { ok: false, issue: "fragment" };
  if (url.protocol !== "https:" && !(options.allowLoopbackHttp && isLoopbackHostname(url.hostname))) {
    return { ok: false, issue: "insecure_transport" };
  }
  return { ok: true, url };
}
