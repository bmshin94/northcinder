import type { StoreStatus } from "@northcinder/protocol";

export interface StoreCoverageVerification {
  verified: boolean | "not_applicable";
  missing: string[];
  unexpected: string[];
}

export function verifyStoreCoverage(
  registeredStores: readonly string[] | undefined,
  statuses: readonly StoreStatus[],
): StoreCoverageVerification {
  if (registeredStores === undefined) return { verified: "not_applicable", missing: [], unexpected: [] };
  const registered = new Set(registeredStores);
  const present = new Set(statuses.map((status) => status.store));
  const missing = [...registered].filter((store) => !present.has(store)).sort();
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status.store, (counts.get(status.store) ?? 0) + 1);
  const unexpected = [...present].filter((store) => !registered.has(store) || (counts.get(store) ?? 0) !== 1).sort();
  return { verified: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}
