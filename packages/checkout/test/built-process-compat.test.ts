/** Real child processes import checkout/dist and coordinate only through IPC. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fork } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const RENAMED_WORKER = join(ROOT, "packages/checkout/test/fixtures/built-process-worker.mjs");
const LEGACY_WORKER = join(ROOT, "packages/checkout/test/fixtures/legacy-caf5310-process-worker.mjs");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function child(kind: "legacy" | "renamed", mode: string, mandate: string, rail: string, env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("EMPTOR_") && !key.startsWith("THENAGAIN_") && !key.startsWith("BRIER_") && !key.startsWith("NORTHCINDER_") && key !== "HOME" && key !== "XDG_CONFIG_HOME"));
  const childProc = fork(kind === "legacy" ? LEGACY_WORKER : RENAMED_WORKER, [mode, mandate, rail], { cwd: ROOT, env: { ...clean, ...env }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; childProc.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const message = new Promise<any>((resolveMessage, rejectMessage) => {
    childProc.once("message", resolveMessage);
    childProc.once("exit", (code) => rejectMessage(new Error(`built ${mode} child exited ${code}: ${stderr}`)));
  });
  return { process: childProc, message };
}

describe("built checkout compatibility across old and renamed processes", () => {
  for (const strategy of ["explicit", "xdg", "home"] as const) it(`${strategy}: the current process rejects an old underbound mandate while the old process can finish its own attempt`, async () => {
    const root = mkdtempSync(join(tmpdir(), `northcinder-built-${strategy}-`)); roots.push(root);
    const legacy = strategy === "xdg" ? join(root, "xdg", "emptor") : strategy === "home" ? join(root, "home", ".config", "emptor") : join(root, "old-custom");
    const mandate = join(root, "mandate.json"); const rail = join(root, "rail"); mkdirSync(legacy, { recursive: true }); writeFileSync(rail, "0");
    const oldEnv = strategy === "explicit" ? { EMPTOR_CONFIG_DIR: legacy } : strategy === "xdg" ? { XDG_CONFIG_HOME: join(root, "xdg"), HOME: join(root, "home") } : { HOME: join(root, "home") };
    const issued = child("legacy", "issue", mandate, rail, oldEnv); expect(await issued.message).toMatchObject({ type: "issued", state: legacy, normalNewValid: false, normalOldValid: true, provenance: "caf5310df3f277e54f54574c6f12f38bdbcbc9f4" });
    const renamedEnv = strategy === "explicit" ? { EMPTOR_CONFIG_DIR: legacy } : oldEnv;
    const old = child("legacy", "race", mandate, rail, oldEnv); const renamed = child("renamed", "race", mandate, rail, renamedEnv);
    const [oldReady, renamedReady] = await Promise.all([old.message, renamed.message]);
    expect([oldReady.state, renamedReady.state]).toEqual([legacy, legacy]);
    const oldResult = new Promise<any>((resolveMessage) => old.process.once("message", resolveMessage));
    const renamedResult = new Promise<any>((resolveMessage) => renamed.process.once("message", resolveMessage));
    old.process.send({ type: "go" }); renamed.process.send({ type: "go" });
    const results = await Promise.all([oldResult, renamedResult]);
    expect(results.filter((x) => x.result.ok)).toHaveLength(1);
    expect(results.filter((x) => !x.result.ok && x.result.error.code === "malformed")).toHaveLength(1);
    expect(readdirSync(join(legacy, "nonce-ledger.json.markers"))).toHaveLength(1);
    expect(readFileSync(rail, "utf8")).toBe("1");
  });

  it("a fresh current process rejects an old underbound mandate before key lookup, marker, or rail", async () => {
    const root = mkdtempSync(join(tmpdir(), "northcinder-built-key-")); roots.push(root);
    const legacy = join(root, "legacy"); const fresh = join(root, "fresh"); const mandate = join(root, "mandate.json"); const rail = join(root, "rail"); writeFileSync(rail, "0");
    await child("legacy", "issue", mandate, rail, { EMPTOR_CONFIG_DIR: legacy }).message;
    const candidate = child("renamed", "race", mandate, rail, { NORTHCINDER_CONFIG_DIR: fresh, HOME: root }); await candidate.message;
    const outcome = new Promise<any>((resolveMessage) => candidate.process.once("message", resolveMessage)); candidate.process.send({ type: "go" });
    expect((await outcome).result).toMatchObject({ ok: false, stage: "mandate", error: { code: "malformed" } });
    expect(existsSync(join(fresh, "nonce-ledger.json.markers"))).toBe(false); expect(readFileSync(rail, "utf8")).toBe("0");
  });
});
