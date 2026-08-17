import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, parseArgv } from "../src/init-main.js";

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
    stdout,
    stderr,
  };
}

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "northcinder-init-main-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseArgv", () => {
  it("parses repeatable --shop flags and the non-interactive switch", () => {
    const parsed = parseArgv([
      "--non-interactive",
      "--mode",
      "local",
      "--shop",
      "www.allbirds.com",
      "--shop",
      "www.rothys.com",
      "--client-key",
      "abcdefghijklmnopqrstuv",
    ]);
    expect(parsed.nonInteractive).toBe(true);
    expect(parsed.mode).toBe("local");
    expect(parsed.shops).toEqual(["www.allbirds.com", "www.rothys.com"]);
    expect(parsed.clientKey).toBe("abcdefghijklmnopqrstuv");
  });

  it("ignores unknown flags instead of throwing", () => {
    expect(() => parseArgv(["--some-future-flag", "value"])).not.toThrow();
  });
});

describe("main() — non-interactive path (CI/testing)", () => {
  it("materializes a packed launcher into owner-only stable config runtime instead of persisting an npx cache path", async () => {
    const configDir = tmpDir();
    const sourceEntry = join(tmpDir(), "northcinder.js");
    writeFileSync(sourceEntry, "#!/usr/bin/env node\nprocess.stdout.write('packed')\n");
    const { io, stdout } = captureIo();
    await main([
      "--non-interactive", "--mode", "local", "--client-key", "ci-test-key-0123456789", "--shop", "example.invalid",
      "--config-dir", configDir, "--server-entry", sourceEntry, "--service-entry", sourceEntry, "--persist-runtime",
    ], io);
    const runtimeEntry = join(configDir, "runtime", "northcinder.js");
    expect(readFileSync(runtimeEntry, "utf8")).toContain("packed");
    expect(statSync(runtimeEntry).mode & 0o777).toBe(0o700);
    expect(stdout.join("")).toContain(runtimeEntry);
    expect(stdout.join("")).not.toContain(sourceEntry);
  });

  it("writes a config for an explicitly self-hosted engine without implying a maintainer service", async () => {
    const configDir = tmpDir();
    const { io, stdout } = captureIo();
    await main(
      [
        "--non-interactive",
        "--mode",
        "self-hosted",
        "--service-url",
        "http://127.0.0.1:8790",
        "--client-key",
        "ci-test-key-0123456789",
        "--config-dir",
        configDir,
        "--server-entry",
        "/abs/client/dist/main.js",
      ],
      io,
    );
    const printed = stdout.join("");
    expect(printed).toContain("Your AI app's MCP configuration");
    expect(printed).toContain('"NORTHCINDER_SERVICE_URL": "http://127.0.0.1:8790"');
    expect(printed).toContain('"command": "node"');
    expect(printed).not.toMatch(/hosted operator|NorthCinder-operated|someone else/i);

    const onDisk = JSON.parse(readFileSync(join(configDir, "northcinder-init.json"), "utf8"));
    expect(onDisk.serviceUrl).toBe("http://127.0.0.1:8790");
    expect(onDisk.clientKey).toBe("ci-test-key-0123456789");
  });

  it("exits non-zero with a message and writes nothing when required flags are missing", async () => {
    const configDir = tmpDir();
    const { io, stderr, stdout } = captureIo();
    await main(
      ["--non-interactive", "--mode", "self-hosted", "--service-url", "http://127.0.0.1:8790", "--config-dir", configDir],
      io,
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("clientKey is required");
  });

  it("defaults non-interactive setup to buyer-run local mode", async () => {
    const configDir = tmpDir();
    const { io, stdout } = captureIo();
    await main([
      "--non-interactive",
      "--client-key", "ci-test-key-0123456789",
      "--config-dir", configDir,
      "--server-entry", "/abs/client/dist/main.js",
      "--service-entry", "/abs/service/dist/main.js",
    ], io);
    const onDisk = JSON.parse(readFileSync(join(configDir, "northcinder-init.json"), "utf8"));
    expect(onDisk.mode).toBe("local");
    expect(onDisk.serviceUrl).toBe("http://127.0.0.1:8790");
    expect(onDisk.shops).toEqual([]);
    expect(stdout.join("")).toContain("start NorthCinder locally");
    expect(stdout.join("")).not.toContain("SHOPIFY_MCP_SHOPS");
  });

  it("describes interactive Shopify hosts as optional legacy configuration", () => {
    const source = readFileSync(new URL("../src/init-main.ts", import.meta.url), "utf8");
    expect(source).toContain("Optional legacy Shopify shop hosts");
  });

  it("rejects the old hosted-operator mode name", async () => {
    const { io, stderr, stdout } = captureIo();
    await main([
      "--non-interactive",
      "--mode", "hosted",
      "--service-url", "https://example.invalid",
      "--client-key", "ci-test-key-0123456789",
      "--config-dir", tmpDir(),
    ], io);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("mode must be 'local' or 'self-hosted'");
  });
});
