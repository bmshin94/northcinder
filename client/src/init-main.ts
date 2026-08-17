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
 * All output the buyer needs (config path, local engine command, and generic MCP host JSON) goes to
 * stdout; errors go to stderr with a non-zero exit code.
 */
import { createInterface } from "node:readline/promises";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveConfigDir } from "@northcinder/protocol";
import { BRAND_NAME } from "./brand.js";
import { InitAnswersError, runInit, type InitAnswers } from "./init-wizard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER_ENTRY = join(HERE, "main.js");

interface ParsedArgs {
  nonInteractive: boolean;
  mode?: "self-hosted" | "local";
  serviceUrl?: string;
  clientKey?: string;
  shops: string[];
  ntfyTopic?: string;
  configDir?: string;
  serverEntry?: string;
  serviceEntry?: string;
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
      case "--ntfy-topic":
        out.ntfyTopic = next(++i);
        break;
      case "--config-dir":
        out.configDir = next(++i);
        break;
      case "--server-entry":
        out.serverEntry = next(++i);
        break;
      case "--service-entry":
        out.serviceEntry = next(++i);
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
  const clientKey = await prompt("Buyer-generated NorthCinder engine key (≥16 chars)", parsed.clientKey);
  const shopsRaw =
    mode === "local"
      ? await prompt("Optional legacy Shopify shop hosts (comma-separated; blank = none)", parsed.shops.join(","))
      : "";
  const ntfyTopic = await prompt("ntfy topic for approval pushes (blank = disabled)", parsed.ntfyTopic ?? "");
  const configDir = await prompt("Local config directory", parsed.configDir ?? resolveConfigDir());
  return {
    mode,
    ...(serviceUrl ? { serviceUrl } : {}),
    clientKey,
    shops: shopsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    ...(ntfyTopic ? { ntfyTopic } : {}),
    configDir,
    serverEntry: parsed.serverEntry ?? DEFAULT_SERVER_ENTRY,
    ...(parsed.serviceEntry ? { serviceEntry: parsed.serviceEntry } : {}),
  };
}

function collectNonInteractive(parsed: ParsedArgs): InitAnswers {
  return {
    mode: parsed.mode ?? "local",
    ...(parsed.serviceUrl ? { serviceUrl: parsed.serviceUrl } : {}),
    clientKey: parsed.clientKey ?? "",
    shops: parsed.shops,
    ...(parsed.ntfyTopic ? { ntfyTopic: parsed.ntfyTopic } : {}),
    configDir: parsed.configDir ?? resolveConfigDir(),
    serverEntry: parsed.serverEntry ?? DEFAULT_SERVER_ENTRY,
    ...(parsed.serviceEntry ? { serviceEntry: parsed.serviceEntry } : {}),
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

const defaultIo: MainIo = {
  stdout: (chunk) => {
    process.stdout.write(chunk);
  },
  stderr: (chunk) => {
    process.stderr.write(chunk);
  },
};

/** `io` is injectable so tests can assert on printed output without relying on
 * spying process.stdout (unreliable across vitest's worker-thread pool). */
export async function main(argv: string[] = process.argv.slice(3), io: MainIo = defaultIo): Promise<void> {
  const parsed = parseArgv(argv);
  let result;
  try {
    const isTty = process.stdin.isTTY === true;
    const answers =
      parsed.nonInteractive || !isTty ? collectNonInteractive(parsed) : await collectInteractive(parsed);

    // npx's package directory is an implementation cache, not a durable MCP
    // executable location. The packed launcher asks us to copy its self-contained
    // bundle into the local buyer-only state domain before printing instructions.
    if (parsed.persistRuntime) {
      const runtimeEntry = materializePackedRuntime(answers.serverEntry, answers.configDir);
      answers.serverEntry = runtimeEntry;
      answers.serviceEntry = runtimeEntry;
    }
    result = runInit(answers);
  } catch (err) {
    if (err instanceof InitAnswersError) {
      io.stderr(`[${BRAND_NAME} init] ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  io.stdout(
    [
      ``,
      `Wrote config: ${result.configPath}`,
      ...(result.serviceCommand !== undefined
        ? [
            ``,
            `— Step 1: start NorthCinder locally (buyer-run process; POSIX shell) —`,
            result.serviceCommand,
            ``,
            `— Step 2: plug the client into your agent —`,
          ]
        : []),
      ``,
      `— Your AI app's MCP configuration (cross-platform "mcpServers" JSON) —`,
      result.mcpHostSnippet,
      ``,
    ].join("\n"),
  );
}

// Never auto-runs on import — the `northcinder` bin (cli.ts) calls main()
// explicitly for the `init` subcommand, which keeps this module side-effect
// free and safely importable from tests.
