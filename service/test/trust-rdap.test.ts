import { describe, expect, it } from "vitest";
import { probeRdap } from "../src/trust/signals/rdap.js";

const NOW = () => new Date("2026-07-11T00:00:00.000Z");

/** A fetch stub routing by URL substring to a canned Response (or a thrower). */
function routeFetch(routes: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [needle, make] of Object.entries(routes)) {
      if (url.includes(needle)) return make();
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("probeRdap — domain-age signal (spec §6, live-verified shape)", () => {
  it("parses the registration event from a .com Verisign response into age days + a re-checkable line", async () => {
    const fetchImpl = routeFetch({
      "rdap.verisign.com/com/v1/domain/allbirds.com": () =>
        json({ events: [{ eventAction: "registration", eventDate: "2002-01-09T15:24:37Z" }] }),
    });
    const res = await probeRdap("allbirds.com", { now: NOW, fetchImpl });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.measurement.registrationDate).toBe("2002-01-09T15:24:37.000Z");
    // 2002-01-09 → 2026-07-11 is > 20 years.
    expect(res.measurement.domainAgeDays).toBeGreaterThan(365 * 20);
    expect(res.evidence.source).toBe("rdap");
    expect(res.evidence.detail).toBe("domain registered 2002-01-09 (RDAP, Verisign)");
    expect(res.evidence.url).toContain("rdap.verisign.com/com/v1/domain/allbirds.com");
    expect(res.evidence.fetchedAt).toBe("2026-07-11T00:00:00.000Z");
  });

  it("resolves a non-com/net TLD via the IANA bootstrap file, then queries that registry", async () => {
    const fetchImpl = routeFetch({
      "data.iana.org/rdap/dns.json": () =>
        json({ services: [[["org", "info"], ["https://rdap.publicinterestregistry.org/rdap/"]]] }),
      "rdap.publicinterestregistry.org/rdap/domain/example.org": () =>
        json({ events: [{ eventAction: "registration", eventDate: "2015-03-02T00:00:00Z" }] }),
    });
    const res = await probeRdap("example.org", { now: NOW, fetchImpl });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.evidence.detail).toContain("domain registered 2015-03-02");
    expect(res.evidence.detail).toContain("rdap.publicinterestregistry.org");
  });

  it("degrades honestly on 404 (domain not found)", async () => {
    const fetchImpl = routeFetch({ "rdap.verisign.com": () => new Response("", { status: 404 }) });
    const res = await probeRdap("missing.com", { now: NOW, fetchImpl });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("404");
  });

  it("degrades honestly on a redirect / unexpected status", async () => {
    const fetchImpl = routeFetch({
      "rdap.verisign.com": () => new Response("", { status: 301, headers: { location: "https://elsewhere" } }),
    });
    const res = await probeRdap("redir.com", { now: NOW, fetchImpl });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("301");
  });

  it("degrades honestly on non-JSON body", async () => {
    const fetchImpl = routeFetch({ "rdap.verisign.com": () => new Response("<html>nope</html>", { status: 200 }) });
    const res = await probeRdap("weird.com", { now: NOW, fetchImpl });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("not JSON");
  });

  it("degrades honestly when the registration event is absent", async () => {
    const fetchImpl = routeFetch({
      "rdap.verisign.com": () => json({ events: [{ eventAction: "last changed", eventDate: "2020-01-01T00:00:00Z" }] }),
    });
    const res = await probeRdap("noreg.com", { now: NOW, fetchImpl });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("no registration event");
  });

  it("degrades honestly on timeout (a fetch that only rejects on abort)", async () => {
    const fetchImpl = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const res = await probeRdap("slow.com", { now: NOW, fetchImpl, timeoutMs: 30 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("unavailable");
  });
});
