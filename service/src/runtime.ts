import { serve, type ServerType } from "@hono/node-server";
import { canonicalizeProductEnv } from "@northcinder/protocol";
import type { AddressInfo } from "node:net";
import { buildAdaptersFromEnv, discoverySourcesFromEnv } from "./adapters-from-env.js";
import { createApp, type ApiClientKey } from "./http/app.js";
import { createOrchestrator } from "./orchestrator/orchestrator.js";
import { buildTrustProviderFromEnv } from "./trust/from-env.js";

export interface OwnedLocalEngine {
  readonly origin: string;
  readonly registeredStores: string[];
  close(): Promise<void>;
}

export function parseRequiredApiKeys(raw: string | undefined): ApiClientKey[] {
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      "NORTHCINDER_API_KEYS is required (format: clientId:key[,clientId:key…]) — refusing to boot an open service",
    );
  }
  return raw.split(",").map((pair) => {
    const sep = pair.indexOf(":");
    const clientId = sep === -1 ? "" : pair.slice(0, sep).trim();
    const key = sep === -1 ? "" : pair.slice(sep + 1).trim();
    if (clientId === "" || key.length < 16) {
      throw new Error("NORTHCINDER_API_KEYS entry malformed (need clientId:key with key ≥16 chars)");
    }
    return { clientId, key };
  });
}

export async function startLocalEngine(
  env: Record<string, string | undefined> = process.env,
): Promise<OwnedLocalEngine> {
  const normalizedEnv = canonicalizeProductEnv(env);
  const adapters = buildAdaptersFromEnv(normalizedEnv);
  const discoverySources = discoverySourcesFromEnv(normalizedEnv);
  const orchestrator = createOrchestrator(adapters);
  const app = createApp({
    orchestrator,
    trust: buildTrustProviderFromEnv(normalizedEnv),
    auth: { kind: "local-loopback", clientId: "local" },
    discoverySources,
  });

  const server = await new Promise<ServerType>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    const candidate = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
      () => {
        candidate.off("error", onError);
        resolve(candidate);
      },
    );
    candidate.once("error", onError);
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("local engine did not bind an IPv4 loopback socket");
  }

  let closePromise: Promise<void> | undefined;
  return {
    origin: `http://127.0.0.1:${(address as AddressInfo).port}`,
    registeredStores: orchestrator.registeredStoreIds(),
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return closePromise;
    },
  };
}
