import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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
  it("normalizes a relative config directory before persisting the record and MCP entry", async () => {
    const originalCwd = process.cwd();
    const workingDir = tmpDir();
    const { io, stdout } = captureIo();
    try {
      process.chdir(workingDir);
      await main([
        "--non-interactive", "--mode", "local", "--config-dir", "relative-config",
        "--server-entry", "/abs/northcinder.js",
      ], io);
    } finally {
      process.chdir(originalCwd);
    }

    const record = JSON.parse(readFileSync(join(workingDir, "relative-config", "northcinder-init.json"), "utf8"));
    const printed = stdout.join("");
    expect(isAbsolute(record.configDir)).toBe(true);
    expect(record.configDir).toBe(join(workingDir, "relative-config"));
    expect(printed).toContain(`"NORTHCINDER_CONFIG_DIR": "${join(workingDir, "relative-config")}"`);
  });

  it("materializes a packed launcher into owner-only stable config runtime instead of persisting an npx cache path", async () => {
    const configDir = tmpDir();
    const packageDir = tmpDir();
    const sourceEntry = join(packageDir, "bin", "northcinder.js");
    mkdirSync(join(packageDir, "bin"), { recursive: true });
    mkdirSync(join(packageDir, "research-skills", "product-research"), { recursive: true });
    mkdirSync(join(packageDir, "research-skills", "seller-research"), { recursive: true });
    writeFileSync(sourceEntry, "#!/usr/bin/env node\nprocess.stdout.write('packed')\n");
    writeFileSync(
      join(packageDir, "research-skills", "product-research", "SKILL.md"),
      readFileSync(new URL("../research-skills/product-research/SKILL.md", import.meta.url)),
    );
    writeFileSync(
      join(packageDir, "research-skills", "seller-research", "SKILL.md"),
      readFileSync(new URL("../research-skills/seller-research/SKILL.md", import.meta.url)),
    );
    const { io, stdout } = captureIo();
    await main([
      "--non-interactive", "--mode", "local", "--shop", "example.invalid",
      "--shopify-profile-url", "https://agent.example/ucp-profile.json",
      "--config-dir", configDir, "--server-entry", sourceEntry, "--persist-runtime",
    ], io);
    const runtimeEntry = join(configDir, "runtime", "northcinder.js");
    expect(readFileSync(runtimeEntry, "utf8")).toContain("packed");
    expect(statSync(runtimeEntry).mode & 0o777).toBe(0o700);
    for (const id of ["product-research", "seller-research"]) {
      const materialized = join(configDir, "research-skills", id, "SKILL.md");
      expect(readFileSync(materialized, "utf8")).toBe(
        readFileSync(join(packageDir, "research-skills", id, "SKILL.md"), "utf8"),
      );
      expect(statSync(materialized).mode & 0o777).toBe(0o600);
      expect(statSync(join(configDir, "research-skills", id)).mode & 0o777).toBe(0o700);
    }
    expect(stdout.join("")).toContain(runtimeEntry);
    expect(stdout.join("")).not.toContain(sourceEntry);
  });

  it("refuses a symlinked persisted research-skill target", async () => {
    const configDir = tmpDir();
    const packageDir = tmpDir();
    const sourceEntry = join(packageDir, "bin", "northcinder.js");
    mkdirSync(join(packageDir, "bin"), { recursive: true });
    mkdirSync(join(packageDir, "research-skills", "product-research"), { recursive: true });
    mkdirSync(join(packageDir, "research-skills", "seller-research"), { recursive: true });
    writeFileSync(sourceEntry, "#!/usr/bin/env node\n");
    for (const id of ["product-research", "seller-research"]) {
      writeFileSync(join(packageDir, "research-skills", id, "SKILL.md"), `---\nname: ${id}\n---\n`);
    }
    const outside = join(tmpDir(), "outside.md");
    writeFileSync(outside, "must not be replaced");
    mkdirSync(join(configDir, "research-skills", "product-research"), { recursive: true });
    symlinkSync(outside, join(configDir, "research-skills", "product-research", "SKILL.md"));

    const { io, stderr, stdout } = captureIo();
    await main([
      "--non-interactive", "--mode", "local", "--config-dir", configDir,
      "--server-entry", sourceEntry, "--persist-runtime",
    ], io);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("refusing to replace symlinked research skill");
    expect(readFileSync(outside, "utf8")).toBe("must not be replaced");
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
      "--config-dir", configDir,
      "--server-entry", "/abs/client/dist/main.js",
    ], io);
    const onDisk = JSON.parse(readFileSync(join(configDir, "northcinder-init.json"), "utf8"));
    expect(onDisk.mode).toBe("local");
    expect(onDisk).not.toHaveProperty("serviceUrl");
    expect(onDisk).not.toHaveProperty("clientKey");
    expect(onDisk.shops).toEqual([]);
    const printed = stdout.join("");
    expect(printed.match(/Your AI app's MCP configuration/g)).toHaveLength(1);
    expect(printed).not.toContain("start NorthCinder locally");
    expect(printed).not.toContain("NORTHCINDER_SERVICE_URL");
    expect(printed).not.toContain("NORTHCINDER_CLIENT_KEY");
    expect(printed).toContain('"NORTHCINDER_MODE": "local"');
  });

  it("describes interactive Shopify storefront hosts and their required UCP profile", () => {
    const source = readFileSync(new URL("../src/init-main.ts", import.meta.url), "utf8");
    expect(source).toContain("Optional Shopify storefront hosts");
    expect(source).toContain("Shopify UCP agent profile URL");
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
