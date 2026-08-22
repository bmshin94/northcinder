// The public launcher package has no runtime dependency: this entry is bundled from
// the real client dispatcher during `build`/`prepack`, so a packed `npx`
// journey cannot fall back to the registry for @northcinder/client.
const ROOT_USAGE = `Usage: northcinder [command] [options]

Run the buyer-owned NorthCinder MCP server, or initialize its local configuration.

Commands:
  northcinder init       Configure NorthCinder for local or self-hosted use
  northcinder service    Run the buyer-owned aggregation engine

Options:
  -h, --help       Show this help
  -v, --version    Show the installed version
`;

const INIT_USAGE = `Usage: northcinder init [options]

Configure the buyer-owned NorthCinder client and aggregation engine.

Options:
  --mode <local|self-hosted>  Choose where your engine runs (default: local)
  --client-key <key>          Required only for self-hosted mode (at least 16 characters)
  --service-url <url>         Engine URL for self-hosted mode
  --shop <host>               Optional Shopify Storefront Catalog host; repeat for more
  --shopify-profile-url <url> HTTPS UCP agent profile URL (required with --shop)
  --config-dir <path>         Buyer-local configuration directory
  -y, --non-interactive       Do not prompt for missing values
  -h, --help                  Show this help
`;

const SERVICE_USAGE = `Usage: northcinder service

Run the buyer-owned NorthCinder aggregation engine.

Environment:
  NORTHCINDER_API_KEYS    Buyer-generated client keys in clientId:key form (required)
  PORT              Loopback HTTP port (default: 8790)

Options:
  -h, --help        Show this help
  -v, --version     Show the installed service version
`;

async function runLocalMcpServer(): Promise<void> {
  const { materializeOwnedLocalEngineEnv } = await import("../../client/src/init-wizard.ts");
  const { startLocalEngine } = await import("../../service/src/runtime.ts");
  const engine = await startLocalEngine(materializeOwnedLocalEngineEnv(process.env));
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= engine.close();
    return cleanupPromise;
  };
  const exitAfterCleanup = (code: number): void => {
    void cleanup()
      .catch(() => {})
      .finally(() => process.exit(code));
  };

  process.once("SIGINT", () => exitAfterCleanup(130));
  process.once("SIGTERM", () => exitAfterCleanup(143));
  process.once("beforeExit", () => {
    void cleanup().catch(() => {});
  });

  process.env.NORTHCINDER_MODE = "local";
  process.env.NORTHCINDER_SERVICE_URL = engine.origin;
  if (process.env.NORTHCINDER_CLIENT_KEY?.trim() === "") {
    delete process.env.NORTHCINDER_CLIENT_KEY;
  }

  try {
    await import("../../client/src/cli.ts");
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}

const READINESS_START_TIMEOUT_MS = 4_000;
const READINESS_HEALTH_TIMEOUT_MS = 2_000;
const READINESS_CLOSE_TIMEOUT_MS = 2_000;

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("local readiness deadline exceeded")), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function probeLocalRuntime(
  env: Record<string, string | undefined>,
): Promise<Array<{ store: string; status: "ready" | "not_configured" | "invalid_configuration" }>> {
  const { materializeOwnedLocalEngineEnv } = await import("../../client/src/init-wizard.ts");
  const { createServiceClient } = await import("../../client/src/service-client.ts");
  const { startLocalEngine } = await import("../../service/src/runtime.ts");
  const starting = startLocalEngine(materializeOwnedLocalEngineEnv(env));
  let engine: Awaited<ReturnType<typeof startLocalEngine>> | undefined;
  try {
    engine = await withDeadline(starting, READINESS_START_TIMEOUT_MS);
    const health = await createServiceClient({
      serviceUrl: engine.origin,
      timeoutMs: READINESS_HEALTH_TIMEOUT_MS,
    }).health();
    if (!health.ok) throw new Error("local client health check failed");
    const discoverySources = health.data.discoverySources;
    if (discoverySources === undefined) throw new Error("local discovery source statuses are missing");
    const expectedStores = ["amazon", "ebay", "etsy", "shopify", "woocommerce"];
    const actualStores = discoverySources.map((source) => source.store);
    if (
      actualStores.length !== expectedStores.length ||
      actualStores.some((store, index) => store !== expectedStores[index])
    ) {
      throw new Error("local discovery source set is invalid");
    }
    return discoverySources;
  } finally {
    if (engine !== undefined) {
      await withDeadline(engine.close(), READINESS_CLOSE_TIMEOUT_MS);
    } else {
      void starting.then((lateEngine) => lateEngine.close()).catch(() => {});
    }
  }
}

if (process.argv[2] === "--help" || process.argv[2] === "-h") {
  process.stdout.write(ROOT_USAGE);
} else if (process.argv[2] === "init" && (process.argv.includes("--help") || process.argv.includes("-h"))) {
  process.stdout.write(INIT_USAGE);
} else if (process.argv[2] === "service" && (process.argv.includes("--help") || process.argv.includes("-h"))) {
  process.stdout.write(SERVICE_USAGE);
} else if (process.argv[2] === "service" && (process.argv.includes("--version") || process.argv.includes("-v"))) {
  process.stdout.write("northcinder service 0.2.0\n");
} else if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("northcinder 0.2.0\n");
} else if (process.argv[2] !== undefined && process.argv[2] !== "init" && process.argv[2] !== "service") {
  process.stderr.write(`Unknown command: ${process.argv[2]}\n\n${ROOT_USAGE}`);
  process.exitCode = 1;
} else {
  // The real wizard derives its default from its module location. In a bundle
  // that would be an internal virtual module, so make the installed launcher
  // itself the MCP command it prints (normal invocation delegates to main).
  if (process.argv[2] === "service") {
    await import("../../service/src/main.ts");
  } else if (process.argv[2] === "init") {
    if (!process.argv.includes("--server-entry")) {
      const { realpathSync } = await import("node:fs");
      process.argv.push("--server-entry", realpathSync(process.argv[1]));
      process.argv.push("--persist-runtime");
    }
    const initArgv = process.argv.slice(3);
    // The dependency-free ESM bundle includes the MCP SDK's stdio client,
    // whose cross-spawn dependency retains CommonJS built-in loads. Provide
    // Node's native require binding before that bundled module initializes.
    const { createRequire } = await import("node:module");
    (globalThis as { require?: ReturnType<typeof createRequire> }).require ??= createRequire(import.meta.url);
    const { emittedMcpEnvironment, main, probeEmittedMcpServer } = await import("../../client/src/init-main.ts");
    let initResult;
    try {
      initResult = await main(initArgv);
    } catch (error) {
      process.stderr.write(`[NorthCinder init] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
    if ((process.exitCode ?? 0) === 0 && initResult?.record.mode === "local") {
      try {
        const discoverySources = await probeLocalRuntime(emittedMcpEnvironment(initResult));
        await probeEmittedMcpServer(initResult);
        process.stdout.write(
          `Discovery sources: ${discoverySources.map((source) => `${source.store}=${source.status}`).join(", ")}\n`,
        );
        if (discoverySources.some((source) => source.status === "invalid_configuration")) {
          throw new Error("local discovery configuration is invalid");
        }
        process.stdout.write("Local runtime check: ready on loopback\n");
      } catch {
        process.stderr.write("[NorthCinder init] Local runtime check failed; retry init and check loopback access.\n");
        process.exitCode = 1;
      }
    }
  } else if (process.env.NORTHCINDER_MODE?.trim() === "local") {
    try {
      await runLocalMcpServer();
    } catch {
      process.stderr.write("[NorthCinder-mcp] fatal: startup failed; check buyer-local configuration\n");
      process.exitCode = 1;
    }
  } else {
    await import("../../client/src/cli.ts");
  }
}
