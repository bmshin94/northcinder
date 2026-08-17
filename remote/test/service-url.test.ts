import { describe, expect, it } from "vitest";
import { parseRemoteServiceUrl, remoteClientKeyLogLine, remoteUpstreamLogLine } from "../src/service-url.js";

describe("remote upstream service URL", () => {
  it.each([
    "https://operator:secret@service.internal/v1",
    "https://operator@service.internal/v1",
  ])("rejects URL userinfo rather than accepting or logging it: %s", (value) => {
    expect(() => parseRemoteServiceUrl(value)).toThrow(/userinfo/i);
  });

  it.each(["ftp://service.internal", "not a URL"])("rejects a non-HTTP(S) upstream URL: %s", (value) => {
    expect(() => parseRemoteServiceUrl(value)).toThrow(/HTTP/i);
  });

  it("never includes an upstream coordinate or credentials in its startup log", () => {
    const configured = parseRemoteServiceUrl("https://service.internal:8443/api");
    const line = remoteUpstreamLogLine(configured);
    expect(line).toBe("[northcinder-remote] deployer-owned engine configured");
    expect(line).not.toContain("service.internal");
    expect(line).not.toContain("secret");
  });

  it("logs only the number of remote client keys, never their identifiers", () => {
    const line = remoteClientKeyLogLine(2);
    expect(line).toBe("[northcinder-remote] registered client keys: 2");
    expect(line).not.toContain("buyer-account");
  });
});
