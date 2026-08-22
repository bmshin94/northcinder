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

  it("requires HTTPS except for an explicit loopback HTTP engine", () => {
    expect(() => parseRemoteServiceUrl("http://service.internal/api")).toThrow(/HTTPS|loopback/i);
    expect(parseRemoteServiceUrl("http://127.0.0.1:8790")).toBe("http://127.0.0.1:8790/");
    expect(parseRemoteServiceUrl("https://service.internal/api")).toBe("https://service.internal/api");
    expect(() => parseRemoteServiceUrl("https://service.internal/api?other=1")).toThrow(/query/i);
    expect(() => parseRemoteServiceUrl("https://service.internal/api#other")).toThrow(/fragment/i);
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
