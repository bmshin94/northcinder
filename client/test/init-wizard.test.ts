import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InitAnswersError,
  buildMcpHostSnippet,
  materializeOwnedLocalEngineEnv,
  resolveInitAnswers,
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

function withXdgConfigHome<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.XDG_CONFIG_HOME;
  if (value === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
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

  it("requires HTTPS for a self-hosted engine except explicit loopback HTTP", () => {
    expect(() => resolveInitAnswers(baseAnswers({ serviceUrl: "http://engine.example" }))).toThrow(/HTTPS|loopback/i);
    expect(() => resolveInitAnswers(baseAnswers({ serviceUrl: "http://localhost:8790" }))).not.toThrow();
    expect(() => resolveInitAnswers(baseAnswers({ serviceUrl: "https://engine.example/base" }))).not.toThrow();
    expect(() => resolveInitAnswers(baseAnswers({ serviceUrl: "https://engine.example?other=1" }))).toThrow(/query/i);
    expect(() => resolveInitAnswers(baseAnswers({ serviceUrl: "https://engine.example#other" }))).toThrow(/fragment/i);
  });

  it("rejects a short client key in self-hosted mode", () => {
    expect(() => resolveInitAnswers(baseAnswers({ clientKey: "short" }))).toThrow(/16 characters/);
  });

  it("accepts local mode without a client key and omits remote credentials from the record", () => {
    const record = resolveInitAnswers(
      baseAnswers({ mode: "local", serviceUrl: undefined, clientKey: undefined, shops: [] }),
    );
    expect(record).not.toHaveProperty("serviceUrl");
    expect(record).not.toHaveProperty("clientKey");
    expect(record.shops).toEqual([]);
  });

  it("rejects local storefront hosts without their required UCP profile before an init record can be written", () => {
    const answers = baseAnswers({ mode: "local", serviceUrl: undefined, clientKey: undefined, shops: ["www.allbirds.com"] });
    expect(() => runInit(answers)).toThrow(/shopify-profile-url/i);
    expect(() => readFileSync(join(answers.configDir, "northcinder-init.json"), "utf8")).toThrow();
  });

  it("rejects malformed local Shopify hosts without echoing the host", () => {
    const malformed = "https://operator-secret.invalid/path";
    try {
      runInit(baseAnswers({
        mode: "local", serviceUrl: undefined, clientKey: undefined, shops: [malformed],
        shopifyProfileUrl: "https://agent.example/ucp-profile.json",
      }));
      expect.unreachable("expected invalid host");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/shop/i);
      expect(message).not.toContain(malformed);
    }
  });

  it("persists a valid Shopify UCP profile URL for local owned-engine configuration", () => {
    const record = resolveInitAnswers(
      baseAnswers({
        mode: "local",
        serviceUrl: undefined,
        clientKey: undefined,
        shopifyProfileUrl: "https://agent.example/ucp-profile.json",
      }),
    );
    expect(record.shopifyProfileUrl).toBe("https://agent.example/ucp-profile.json");
  });

  it("omits ntfyTopic when not provided", () => {
    const record = resolveInitAnswers(baseAnswers());
    expect(record.ntfyTopic).toBeUndefined();
    expect(record.brand).toBe("NorthCinder");
  });
});

describe("buildMcpHostSnippet", () => {
  it("produces an explicit self-hosted mcpServers environment with URL and key", () => {
    const answers = baseAnswers();
    const record = resolveInitAnswers(answers);
    const snippet = buildMcpHostSnippet(answers, record);
    const parsed = JSON.parse(snippet);
    expect(parsed.mcpServers.northcinder.command).toBe("node");
    expect(parsed.mcpServers.northcinder.args).toEqual(["/abs/path/to/client/dist/main.js"]);
    expect(parsed.mcpServers.northcinder.env.NORTHCINDER_MODE).toBe("self-hosted");
    expect(parsed.mcpServers.northcinder.env.NORTHCINDER_SERVICE_URL).toBe("http://127.0.0.1:8790");
    expect(parsed.mcpServers.northcinder.env.NORTHCINDER_CLIENT_KEY).toBe("a-key-that-is-16chars-plus");
  });

  it("omits XDG_CONFIG_HOME from a keyless local environment when init did not receive it", () => {
    withXdgConfigHome(undefined, () => {
      const answers = baseAnswers({ mode: "local", serviceUrl: undefined, clientKey: undefined });
      const parsed = JSON.parse(buildMcpHostSnippet(answers, resolveInitAnswers(answers)));
      expect(parsed.mcpServers.northcinder.env).toEqual({
        NORTHCINDER_MODE: "local",
        NORTHCINDER_CONFIG_DIR: answers.configDir,
      });
    });
  });

  it("retains XDG_CONFIG_HOME in a keyless local environment when init received it", () => {
    withXdgConfigHome("/tmp/northcinder-xdg-config", () => {
      const answers = baseAnswers({ mode: "local", serviceUrl: undefined, clientKey: undefined });
      const parsed = JSON.parse(buildMcpHostSnippet(answers, resolveInitAnswers(answers)));
      expect(parsed.mcpServers.northcinder.env).toEqual({
        NORTHCINDER_MODE: "local",
        NORTHCINDER_CONFIG_DIR: answers.configDir,
        XDG_CONFIG_HOME: "/tmp/northcinder-xdg-config",
      });
    });
  });
});

describe("materializeOwnedLocalEngineEnv", () => {
  it("materializes persisted local Shopify UCP shops and profile only into the owned engine environment", () => {
    const answers = baseAnswers({
      mode: "local",
      serviceUrl: undefined,
      clientKey: undefined,
      shops: ["www.allbirds.com", "www.rothys.com"],
      shopifyProfileUrl: "https://agent.example/ucp-profile.json",
    });
    const result = runInit(answers);

    expect(materializeOwnedLocalEngineEnv({ HOME: answers.configDir, NORTHCINDER_CONFIG_DIR: answers.configDir })).toEqual({
      HOME: answers.configDir,
      NORTHCINDER_CONFIG_DIR: answers.configDir,
      SHOPIFY_MCP_SHOPS: "www.allbirds.com,www.rothys.com",
      SHOPIFY_UCP_AGENT_PROFILE_URL: "https://agent.example/ucp-profile.json",
    });
    expect(JSON.parse(result.mcpHostSnippet).mcpServers.northcinder.env).not.toHaveProperty("SHOPIFY_MCP_SHOPS");
  });

  it("materializes a persisted Shopify UCP profile only into the owned engine environment", () => {
    const answers = baseAnswers({
      mode: "local",
      serviceUrl: undefined,
      clientKey: undefined,
      shopifyProfileUrl: "https://agent.example/ucp-profile.json",
    });
    runInit(answers);
    expect(materializeOwnedLocalEngineEnv({ HOME: answers.configDir, NORTHCINDER_CONFIG_DIR: answers.configDir }).SHOPIFY_UCP_AGENT_PROFILE_URL)
      .toBe("https://agent.example/ucp-profile.json");
  });

  it("preserves an explicit Shopify environment value instead of replacing it from the record", () => {
    const answers = baseAnswers({
      mode: "local",
      serviceUrl: undefined,
      clientKey: undefined,
      shops: ["record.example"],
      shopifyProfileUrl: "https://agent.example/ucp-profile.json",
    });
    runInit(answers);

    expect(materializeOwnedLocalEngineEnv({
      HOME: answers.configDir,
      NORTHCINDER_CONFIG_DIR: answers.configDir,
      SHOPIFY_MCP_SHOPS: "explicit.example",
    }).SHOPIFY_MCP_SHOPS).toBe("explicit.example");
  });

  it("leaves an uninitialized local environment unconfigured", () => {
    const configDir = tmpConfigDir();
    expect(materializeOwnedLocalEngineEnv({ HOME: configDir, NORTHCINDER_CONFIG_DIR: configDir })).toEqual({
      HOME: configDir,
      NORTHCINDER_CONFIG_DIR: configDir,
    });
  });

  it("rejects a malformed local record without leaking its path or content", () => {
    const configDir = tmpConfigDir();
    const secret = "operator-secret-shop-value";
    writeFileSync(join(configDir, "northcinder-init.json"), JSON.stringify({
      brand: "NorthCinder",
      mode: "local",
      shops: secret,
      configDir,
      createdAt: new Date().toISOString(),
    }));

    try {
      materializeOwnedLocalEngineEnv({ HOME: configDir, NORTHCINDER_CONFIG_DIR: configDir });
      expect.unreachable("expected malformed local record rejection");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/local init record is invalid/i);
      expect(message).not.toContain(configDir);
      expect(message).not.toContain(secret);
    }
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

  it("returns no local service command", () => {
    const answers = baseAnswers({ mode: "local", serviceUrl: undefined, clientKey: undefined });
    const result = runInit(answers);
    expect(result).not.toHaveProperty("serviceCommand");
  });
});
