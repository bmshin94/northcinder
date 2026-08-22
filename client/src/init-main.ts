#!/usr/bin/env node
/**
 * `northcinder init` — interactive by default, fully flag-driven for CI/testing.
 *
 * Non-interactive (CI) usage:
 *   northcinder init --non-interactive --mode self-hosted \
 *     --service-url http://127.0.0.1:8790 --client-key <16+ chars> \
 *     [--shop www.example.com ...] [--ntfy-topic <topic>] [--config-dir <dir>]
 *
 * With no --non-interactive flag and no piped stdin, prompts for each value.
 * All output the buyer needs (config path and generic MCP host JSON) goes to
 * stdout; errors go to stderr with a non-zero exit code.
 */
import { createInterface } from "node:readline/promises";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveConfigDir } from "@northcinder/protocol";
import { BRAND_NAME, BRAND_SLUG } from "./brand.js";
import { InitAnswersError, runInit, type InitAnswers, type InitResult } from "./init-wizard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER_ENTRY = join(HERE, "main.js");

interface ParsedArgs {
  nonInteractive: boolean;
  mode?: "self-hosted" | "local";
  serviceUrl?: string;
  clientKey?: string;
  shops: string[];
  shopifyProfileUrl?: string;
  ntfyTopic?: string;
  configDir?: string;
  serverEntry?: string;
  persistRuntime: boolean;
}

export function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { nonInteractive: false, shops: [], persistRuntime: false };
  const next = (i: number): string => argv[i] ?? "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--non-interactive":
      case "--yes":
      case "-y":
        out.nonInteractive = true;
        break;
      case "--mode":
        out.mode = next(++i) as "self-hosted" | "local";
        break;
      case "--service-url":
        out.serviceUrl = next(++i);
        break;
      case "--client-key":
        out.clientKey = next(++i);
        break;
      case "--shop":
        out.shops.push(next(++i));
        break;
      case "--shopify-profile-url":
        out.shopifyProfileUrl = next(++i);
        break;
      case "--ntfy-topic":
        out.ntfyTopic = next(++i);
        break;
      case "--config-dir":
        out.configDir = next(++i);
        break;
      case "--server-entry":
        out.serverEntry = next(++i);
        break;
      case "--persist-runtime":
        out.persistRuntime = true;
        break;
      default:
        // Unknown flags are ignored rather than fatal — forward-compatible CLI.
        break;
    }
  }
  return out;
}

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  rl.close();
  return answer || defaultValue || "";
}

async function collectInteractive(parsed: ParsedArgs): Promise<InitAnswers> {
  process.stdout.write(`\n${BRAND_NAME} init — set up your local client\n\n`);
  const modeAnswer = (
    await prompt("Mode: 'local' (recommended) or 'self-hosted' (an engine you deploy)", "local")
  ).toLowerCase();
  if (modeAnswer !== "local" && modeAnswer !== "self-hosted") {
    throw new InitAnswersError("mode must be 'local' or 'self-hosted'");
  }
  const mode: "self-hosted" | "local" = modeAnswer;
  const serviceUrl =
    mode === "self-hosted" ? await prompt("URL of the NorthCinder engine you operate", parsed.serviceUrl) : undefined;
  const clientKey =
    mode === "self-hosted"
      ? await prompt("Buyer-generated NorthCinder engine key (≥16 chars)", parsed.clientKey)
      : undefined;
  const shopsRaw =
    mode === "local"
      ? await prompt("Optional Shopify storefront hosts (comma-separated; blank = none)", parsed.shops.join(","))
      : "";
  const shopifyProfileUrl = mode === "local"
    ? await prompt("Optional Shopify UCP agent profile URL (HTTPS; required when storefront hosts are configured)", parsed.shopifyProfileUrl)
    : undefined;
  const ntfyTopic = await prompt("ntfy topic for approval pushes (blank = disabled)", parsed.ntfyTopic ?? "");
  const configDir = await prompt("Local config directory", parsed.configDir ?? resolveConfigDir());
  return {
    mode,
    ...(serviceUrl ? { serviceUrl } : {}),
    ...(clientKey ? { clientKey } : {}),
    shops: shopsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    ...(shopifyProfileUrl ? { shopifyProfileUrl } : {}),
    ...(ntfyTopic ? { ntfyTopic } : {}),
    configDir,
    serverEntry: parsed.serverEntry ?? DEFAULT_SERVER_ENTRY,
  };
}

function collectNonInteractive(parsed: ParsedArgs): InitAnswers {
  return {
    mode: parsed.mode ?? "local",
    ...(parsed.serviceUrl ? { serviceUrl: parsed.serviceUrl } : {}),
    ...(parsed.clientKey ? { clientKey: parsed.clientKey } : {}),
    shops: parsed.shops,
    ...(parsed.shopifyProfileUrl ? { shopifyProfileUrl: parsed.shopifyProfileUrl } : {}),
    ...(parsed.ntfyTopic ? { ntfyTopic: parsed.ntfyTopic } : {}),
    configDir: parsed.configDir ?? resolveConfigDir(),
    serverEntry: parsed.serverEntry ?? DEFAULT_SERVER_ENTRY,
  };
}

export interface MainIo {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

function materializePackedRuntime(sourceEntry: string, configDir: string): string {
  const runtimeDir = join(configDir, "runtime");
  const runtimeEntry = join(runtimeDir, "northcinder.js");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);
  try {
    if (lstatSync(runtimeEntry).isSymbolicLink()) {
      throw new InitAnswersError(`refusing to replace symlinked runtime entry: ${runtimeEntry}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(runtimeDir, `.northcinder-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o700);
    writeSync(fd, readFileSync(sourceEntry));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, runtimeEntry);
    chmodSync(runtimeEntry, 0o700);
    // Windows may reject syncing a directory handle. The file itself was
    // synchronously flushed before the atomic rename; accept only that known
    // platform limitation, never a file-sync failure.
    let dirFd: number | undefined;
    try {
      dirFd = openSync(runtimeDir, "r");
      fsyncSync(dirFd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "EPERM" && code !== "ENOTSUP") throw error;
    } finally {
      if (dirFd !== undefined) closeSync(dirFd);
    }
    return runtimeEntry;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* no partial runtime survives */ }
    throw error;
  }
}

const RESEARCH_SKILL_IDS = ["product-research", "seller-research"] as const;

function rejectSymlink(path: string, label: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new InitAnswersError(`refusing to replace symlinked ${label}: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function materializePackedResearchSkills(sourceEntry: string, configDir: string): void {
  const sourceRoot = join(dirname(sourceEntry), "..", "research-skills");
  const targetRoot = join(configDir, "research-skills");
  const sources = RESEARCH_SKILL_IDS.map((id) => join(sourceRoot, id, "SKILL.md"));
  const targets = RESEARCH_SKILL_IDS.map((id) => join(targetRoot, id, "SKILL.md"));

  const contents = sources.map((source) => readFileSync(source));
  rejectSymlink(targetRoot, "research skill directory");
  for (let index = 0; index < RESEARCH_SKILL_IDS.length; index++) {
    rejectSymlink(join(targetRoot, RESEARCH_SKILL_IDS[index]!), "research skill directory");
    rejectSymlink(targets[index]!, "research skill");
  }

  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  chmodSync(targetRoot, 0o700);
  for (let index = 0; index < RESEARCH_SKILL_IDS.length; index++) {
    const targetDir = join(targetRoot, RESEARCH_SKILL_IDS[index]!);
    const target = targets[index]!;
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    chmodSync(targetDir, 0o700);
    const temporary = join(targetDir, `.SKILL-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeSync(fd, contents[index]!);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, target);
      chmodSync(target, 0o600);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch { /* no partial skill file survives */ }
      throw error;
    }
  }
}

const defaultIo: MainIo = {
  stdout: (chunk) => {
    process.stdout.write(chunk);
  },
  stderr: (chunk) => {
    process.stderr.write(chunk);
  },
};

const STDIO_PROBE_TIMEOUT_MS = 4_000;
const STDIO_EXIT_TIMEOUT_MS = 2_000;

function withProbeDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("local MCP readiness deadline exceeded")), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function emittedMcpEntry(result: InitResult): { command: string; args: string[]; env: Record<string, string> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.mcpHostSnippet);
  } catch {
    throw new Error("emitted MCP configuration is invalid");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("emitted MCP configuration is invalid");
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (typeof servers !== "object" || servers === null) throw new Error("emitted MCP configuration is invalid");
  const entry = (servers as Record<string, unknown>)[BRAND_SLUG];
  if (typeof entry !== "object" || entry === null) throw new Error("emitted MCP configuration is invalid");
  const candidate = entry as { command?: unknown; args?: unknown; env?: unknown };
  if (
    typeof candidate.command !== "string" ||
    !Array.isArray(candidate.args) ||
    !candidate.args.every((arg) => typeof arg === "string") ||
    typeof candidate.env !== "object" ||
    candidate.env === null ||
    !Object.values(candidate.env).every((value) => typeof value === "string")
  ) {
    throw new Error("emitted MCP configuration is invalid");
  }
  return {
    command: candidate.command,
    args: candidate.args,
    env: candidate.env as Record<string, string>,
  };
}

/** The effective environment the SDK stdio transport gives the emitted child:
 * its fixed safe-default allowlist plus the explicit MCP entry values. */
export function emittedMcpEnvironment(result: InitResult): Record<string, string | undefined> {
  return { ...getDefaultEnvironment(), ...emittedMcpEntry(result).env };
}

/** Execute the emitted MCP entry exactly as a host would, from a cwd that is
 * independent of the shell that ran init. The transient child must initialize,
 * expose the native-search and host-discovery handoff tools, and exit cleanly. */
export async function probeEmittedMcpServer(result: InitResult): Promise<void> {
  const entry = emittedMcpEntry(result);
  const client = new Client({ name: "northcinder-init-readiness", version: "0.2.1" });
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: entry.env,
    cwd: result.record.configDir,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  let closed = false;
  try {
    await withProbeDeadline(client.connect(transport, { timeout: STDIO_PROBE_TIMEOUT_MS }), STDIO_PROBE_TIMEOUT_MS);
    const child = (transport as unknown as { _process?: ChildProcess })._process;
    if (child === undefined) throw new Error("emitted MCP child did not start");
    const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    const listed = await withProbeDeadline(
      client.listTools(undefined, { timeout: STDIO_PROBE_TIMEOUT_MS }),
      STDIO_PROBE_TIMEOUT_MS,
    );
    const toolNames = new Set(listed.tools.map((tool) => tool.name));
    if (!toolNames.has("search_products") || !toolNames.has("submit_browser_observations")) {
      throw new Error("emitted MCP server is missing discovery tools");
    }
    await withProbeDeadline(client.close(), STDIO_PROBE_TIMEOUT_MS);
    closed = true;
    const exit = await withProbeDeadline(childExit, STDIO_EXIT_TIMEOUT_MS);
    if (exit.code !== 0 || exit.signal !== null) throw new Error("emitted MCP child did not exit cleanly");
  } finally {
    if (!closed) {
      await withProbeDeadline(client.close(), STDIO_PROBE_TIMEOUT_MS).catch(() => {});
      await withProbeDeadline(transport.close(), STDIO_PROBE_TIMEOUT_MS).catch(() => {});
    }
  }
}

/** `io` is injectable so tests can assert on printed output without relying on
 * spying process.stdout (unreliable across vitest's worker-thread pool). */
export async function main(
  argv: string[] = process.argv.slice(3),
  io: MainIo = defaultIo,
): Promise<InitResult | undefined> {
  const parsed = parseArgv(argv);
  let result;
  try {
    const isTty = process.stdin.isTTY === true;
    const answers =
      parsed.nonInteractive || !isTty ? collectNonInteractive(parsed) : await collectInteractive(parsed);
    answers.configDir = resolve(answers.configDir);

    // npx's package directory is an implementation cache, not a durable MCP
    // executable location. The packed launcher asks us to copy its self-contained
    // bundle into the local buyer-only state domain before printing instructions.
    if (parsed.persistRuntime) {
      materializePackedResearchSkills(answers.serverEntry, answers.configDir);
      const runtimeEntry = materializePackedRuntime(answers.serverEntry, answers.configDir);
      answers.serverEntry = runtimeEntry;
    }
    result = runInit(answers);
  } catch (err) {
    if (err instanceof InitAnswersError) {
      io.stderr(`[${BRAND_NAME} init] ${err.message}\n`);
      process.exitCode = 1;
      return undefined;
    }
    throw err;
  }

  io.stdout(
    [
      ``,
      `Wrote config: ${result.configPath}`,
      ``,
      `— Your AI app's MCP configuration (cross-platform "mcpServers" JSON) —`,
      result.mcpHostSnippet,
      ``,
    ].join("\n"),
  );
  return result;
}

// Never auto-runs on import — the `northcinder` bin (cli.ts) calls main()
// explicitly for the `init` subcommand, which keeps this module side-effect
// free and safely importable from tests.
