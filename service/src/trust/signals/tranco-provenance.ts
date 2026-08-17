import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type TrancoSourceClass = "development_noncommercial" | "commercial_clean";
export const TRANCO_PROVENANCE_SCHEMA_VERSION = 1;

export interface TrancoProvenance {
  schemaVersion: 1;
  sourceClass: TrancoSourceClass;
  listId: string;
  sourceUrl: string;
  ingestedAt: string;
  sha256: string;
}

export function normalizeTrancoSourceUrl(sourceUrl: string): string | undefined {
  try {
    const url = new URL(sourceUrl);
    // Corpus provenance is a durable, client-visible assertion. Restrict it to
    // a stable HTTPS resource without any credential-bearing component rather
    // than risking signed query strings or userinfo reaching sidecars/evidence.
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString();
  } catch { return undefined; }
}

export function isTrancoHostedUrl(sourceUrl: string): boolean {
  try {
    // Host ownership must be identified even when another component (for
    // example a query string) makes the URL unsafe for provenance.
    const hostname = new URL(sourceUrl).hostname.toLowerCase();
    return hostname === "tranco-list.eu" || hostname.endsWith(".tranco-list.eu");
  } catch { return false; }
}

export function provenancePath(listPath: string): string { return `${listPath}.provenance.json`; }
export function sha256File(listPath: string): string { return createHash("sha256").update(readFileSync(listPath)).digest("hex"); }

export function writeTrancoProvenance(listPath: string, input: Omit<TrancoProvenance, "schemaVersion" | "sha256">): void {
  const sourceUrl = normalizeTrancoSourceUrl(input.sourceUrl);
  if (!sourceUrl) throw new Error("Tranco provenance source URL is invalid or unsafe");
  const metadata: TrancoProvenance = { schemaVersion: TRANCO_PROVENANCE_SCHEMA_VERSION, ...input, sourceUrl, sha256: sha256File(listPath) };
  const path = provenancePath(listPath);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function hasMatchingTrancoProvenance(listPath: string, expected: Pick<TrancoProvenance, "sourceClass" | "listId" | "sourceUrl">): boolean {
  const path = provenancePath(listPath);
  if (!existsSync(listPath) || !existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TrancoProvenance>;
    return parsed.schemaVersion === TRANCO_PROVENANCE_SCHEMA_VERSION
      && parsed.sourceClass === expected.sourceClass
      && parsed.listId === expected.listId
      && parsed.sourceUrl === expected.sourceUrl
      && parsed.sha256 === sha256File(listPath);
  } catch { return false; }
}
