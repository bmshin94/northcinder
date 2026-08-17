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
  --client-key <key>          Buyer-generated engine key (at least 16 characters)
  --service-url <url>         Engine URL for self-hosted mode
  --shop <host>               Optional legacy Shopify host; repeat for more
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

if (process.argv[2] === "--help" || process.argv[2] === "-h") {
  process.stdout.write(ROOT_USAGE);
} else if (process.argv[2] === "init" && (process.argv.includes("--help") || process.argv.includes("-h"))) {
  process.stdout.write(INIT_USAGE);
} else if (process.argv[2] === "service" && (process.argv.includes("--help") || process.argv.includes("-h"))) {
  process.stdout.write(SERVICE_USAGE);
} else if (process.argv[2] === "service" && (process.argv.includes("--version") || process.argv.includes("-v"))) {
  process.stdout.write("northcinder service 0.1.2\n");
} else if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("northcinder 0.1.2\n");
} else if (process.argv[2] !== undefined && process.argv[2] !== "init" && process.argv[2] !== "service") {
  process.stderr.write(`Unknown command: ${process.argv[2]}\n\n${ROOT_USAGE}`);
  process.exitCode = 1;
} else {
  // The real wizard derives its default from its module location. In a bundle
  // that would be an internal virtual module, so make the installed launcher
  // itself the MCP command it prints (normal invocation delegates to main).
  if (process.argv[2] === "service") {
    await import("../../service/src/main.ts");
  } else if (process.argv[2] === "init" && !process.argv.includes("--server-entry")) {
    process.argv.push("--server-entry", process.argv[1]);
    process.argv.push("--service-entry", process.argv[1]);
    process.argv.push("--persist-runtime");
    await import("../../client/src/cli.ts");
  } else {
    await import("../../client/src/cli.ts");
  }
}
