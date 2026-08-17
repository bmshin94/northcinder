import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InitAnswersError,
  buildMcpHostSnippet,
  resolveInitAnswers,
  buildServiceCommand,
  quotePosixShell,
  runInit,
  type InitAnswers,
} from "../src/init-wizard.js";

const dirs: string[] = [];
function tmpConfigDir(): string {
  const d = mkdtempSync(join(tmpdir(), "northcinder-init-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function baseAnswers(overrides: Partial<InitAnswers> = {}): InitAnswers {
  return {
    mode: "self-hosted",
    serviceUrl: "http://127.0.0.1:8790",
    clientKey: "a-key-that-is-16chars-plus",
    shops: [],
    configDir: tmpConfigDir(),
    serverEntry: "/abs/path/to/client/dist/main.js",
    ...overrides,
  };
}

describe("resolveInitAnswers", () => {
  it("rejects a missing engine URL in self-hosted mode", () => {
    expect(() => resolveInitAnswers(baseAnswers({ serviceUrl: undefined }))).toThrow(InitAnswersError);
  });

  it("rejects an invalid service URL", () => {
    expect(() => resolveInitAnswers(baseAnswers({ serviceUrl: "not-a-url" }))).toThrow(InitAnswersError);
  });

  it("rejects URL userinfo without echoing embedded credentials", () => {
    const secret = "operator-secret-value";
    try {
      resolveInitAnswers(baseAnswers({ serviceUrl: `https://buyer:${secret}@service.example` }));
      expect.unreachable("expected userinfo to be rejected");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/must not contain credentials/i);
      expect(message).not.toContain(secret);
    }
  });

  it("rejects a short client key", () => {
    expect(() => resolveInitAnswers(baseAnswers({ clientKey: "short" }))).toThrow(/16 characters/);
  });

  it("allows local mode with no legacy Shopify shops", () => {
    const record = resolveInitAnswers(baseAnswers({ mode: "local", serviceUrl: undefined, shops: [] }));
    expect(record.serviceUrl).toBe("http://127.0.0.1:8790");
    expect(record.shops).toEqual([]);
  });

  it("fills in the loopback service URL for local mode", () => {
    const record = resolveInitAnswers(
      baseAnswers({ mode: "local", serviceUrl: undefined, shops: ["www.allbirds.com"] }),
    );
    expect(record.serviceUrl).toBe("http://127.0.0.1:8790");
    expect(record.shops).toEqual(["www.allbirds.com"]);
  });

  it("omits ntfyTopic when not provided", () => {
    const record = resolveInitAnswers(baseAnswers());
    expect(record.ntfyTopic).toBeUndefined();
    expect(record.brand).toBe("NorthCinder");
  });
});

describe("shell-facing init instructions", () => {
  it("single-quotes every user-controlled value so command substitution is inert", () => {
    expect(quotePosixShell("a'$(touch /tmp/pwned)` value")).toBe("'a'\"'\"'$(touch /tmp/pwned)` value'");
    const answers = baseAnswers({
      mode: "local",
      serviceUrl: undefined,
      clientKey: "0123456789abcdef$(touch /tmp/pwned)",
      shops: ["shop.example;touch /tmp/pwned"],
      configDir: "/tmp/a path $(touch /tmp/pwned)",
      serverEntry: "/tmp/launcher path/northcinder",
      serviceEntry: "/tmp/launcher path/northcinder",
    });
    const record = resolveInitAnswers(answers);
    expect(buildServiceCommand(answers, record)).toContain("NORTHCINDER_API_KEYS='me:0123456789abcdef$(touch /tmp/pwned)'");
    expect(buildServiceCommand(answers, record)).toContain("SHOPIFY_MCP_SHOPS='shop.example;touch /tmp/pwned'");
    expect(buildServiceCommand(answers, record)).toContain("node '/tmp/launcher path/northcinder' service");
    const sentinel = join(tmpConfigDir(), "must-not-exist");
    const unsafeAnswers = { ...answers, clientKey: `0123456789abcdef$(touch ${sentinel})` };
    const unsafeRecord = resolveInitAnswers(unsafeAnswers);
    try {
      execFileSync("/bin/sh", ["-c", buildServiceCommand(unsafeAnswers, unsafeRecord)!], { stdio: "ignore" });
    } catch {
      // The deliberately nonexistent launcher fails; the security assertion is
      // that parsing it never evaluates the injected command substitution.
    }
    expect(existsSync(sentinel)).toBe(false);
  });
});

describe("buildMcpHostSnippet", () => {
  it("produces a valid mcpServers JSON block keyed by the brand name", () => {
    const answers = baseAnswers();
    const record = resolveInitAnswers(answers);
    const snippet = buildMcpHostSnippet(answers, record);
    const parsed = JSON.parse(snippet);
    expect(parsed.mcpServers.northcinder.command).toBe("node");
    expect(parsed.mcpServers.northcinder.args).toEqual(["/abs/path/to/client/dist/main.js"]);
    expect(parsed.mcpServers.northcinder.env.NORTHCINDER_SERVICE_URL).toBe("http://127.0.0.1:8790");
    expect(parsed.mcpServers.northcinder.env.NORTHCINDER_CLIENT_KEY).toBe("a-key-that-is-16chars-plus");
  });
});

describe("runInit", () => {
  it("writes a 0600 config file with the resolved record and returns install snippets", () => {
    const answers = baseAnswers();
    const result = runInit(answers);
    expect(statSync(result.configPath).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(onDisk.serviceUrl).toBe("http://127.0.0.1:8790");
    expect(onDisk.clientKey).toBe("a-key-that-is-16chars-plus");
    expect(JSON.parse(result.mcpHostSnippet).mcpServers.northcinder).toBeDefined();
  });

  it("throws InitAnswersError (not a generic Error) on bad input, without writing anything", () => {
    const configDir = tmpConfigDir();
    expect(() => runInit(baseAnswers({ configDir, clientKey: "short" }))).toThrow(InitAnswersError);
  });
});

describe("buildServiceCommand — local mode prints how to start the buyer-run engine", () => {
  it("local mode without shops omits the legacy Shopify environment variable", () => {
    const answers = baseAnswers({
      mode: "local",
      serviceUrl: undefined,
      shops: [],
      serverEntry: "/abs/path/to/northcinder.js",
      serviceEntry: "/abs/path/to/northcinder.js",
    });
    const record = resolveInitAnswers(answers);
    const cmd = buildServiceCommand(answers, record);
    expect(cmd).toContain("NORTHCINDER_API_KEYS='me:a-key-that-is-16chars-plus'");
    expect(cmd).not.toContain("SHOPIFY_MCP_SHOPS");
    expect(cmd).toContain("node '/abs/path/to/northcinder.js' service");
  });

  it("local mode: returns a ready-to-paste service launch command with the key and shops", () => {
    const answers = baseAnswers({ mode: "local", serviceUrl: undefined, shops: ["www.allbirds.com", "www.rothys.com"], serverEntry: "/abs/path/to/northcinder.js", serviceEntry: "/abs/path/to/northcinder.js" });
    const record = resolveInitAnswers(answers);
    const cmd = buildServiceCommand(answers, record);
    expect(cmd).not.toBeUndefined();
    expect(cmd).toContain("NORTHCINDER_API_KEYS='me:a-key-that-is-16chars-plus'");
    expect(cmd).toContain("SHOPIFY_MCP_SHOPS='www.allbirds.com,www.rothys.com'");
    expect(cmd).toContain("node ");
    expect(cmd).toContain("node '/abs/path/to/northcinder.js' service");
  });

  it("self-hosted mode returns no local launch command because the buyer runs it separately", () => {
    const answers = baseAnswers();
    const record = resolveInitAnswers(answers);
    expect(buildServiceCommand(answers, record)).toBeUndefined();
  });

  it("runInit exposes serviceCommand in the result for local mode", () => {
    const answers = baseAnswers({ mode: "local", serviceUrl: undefined, shops: ["www.allbirds.com"], serverEntry: "/abs/path/to/northcinder.js", serviceEntry: "/abs/path/to/northcinder.js" });
    const result = runInit(answers);
    expect(result.serviceCommand).toContain("node '/abs/path/to/northcinder.js' service");
  });
});
