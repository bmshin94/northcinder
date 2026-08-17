import { describe, expect, it } from "vitest";
import { authenticate, parseRemoteApiKeys } from "../src/auth.js";

describe("parseRemoteApiKeys", () => {
  it("parses clientId:key pairs", () => {
    const keys = parseRemoteApiKeys("acme:aaaaaaaaaaaaaaaaaaaa,beta:bbbbbbbbbbbbbbbbbbbb");
    expect(keys).toEqual([
      { clientId: "acme", key: "aaaaaaaaaaaaaaaaaaaa" },
      { clientId: "beta", key: "bbbbbbbbbbbbbbbbbbbb" },
    ]);
  });

  it("throws on missing env", () => {
    expect(() => parseRemoteApiKeys(undefined)).toThrow(/NORTHCINDER_REMOTE_API_KEYS/);
  });

  it("throws on a key shorter than 16 chars", () => {
    expect(() => parseRemoteApiKeys("acme:short")).toThrow(/malformed/);
  });
});

describe("authenticate", () => {
  const keys = [{ clientId: "acme", key: "aaaaaaaaaaaaaaaaaaaa" }];

  it("rejects a missing Authorization header", () => {
    const result = authenticate(undefined, keys);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-Bearer header", () => {
    const result = authenticate("Basic xyz", keys);
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown key", () => {
    const result = authenticate("Bearer nope", keys);
    expect(result.ok).toBe(false);
  });

  it("accepts a valid key and returns the clientId", () => {
    const result = authenticate("Bearer aaaaaaaaaaaaaaaaaaaa", keys);
    expect(result).toEqual({ ok: true, clientId: "acme" });
  });
});
