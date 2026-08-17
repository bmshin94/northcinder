/**
 * ARCHITECTURAL TEST (safety contract law): watches NOTIFY, they never buy. There must be
 * NO code path from @northcinder/watches to @northcinder/checkout:
 *   1. @northcinder/checkout is unreachable in the WORKSPACE DEPENDENCY GRAPH
 *      rooted at @northcinder/watches (BFS over workspace package.jsons).
 *   2. No source file in this package imports @northcinder/checkout (or any
 *      checkout module) directly.
 * If a future change adds such a path, this test fails the build.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");

interface Pkg {
  name: string;
  deps: string[];
}

/** All workspace packages (per pnpm-workspace.yaml: client, service, adapters/*, packages/*). */
function workspacePackages(): Map<string, Pkg> {
  const dirs: string[] = [join(repoRoot, "client"), join(repoRoot, "service")];
  for (const group of ["adapters", "packages"]) {
    for (const entry of readdirSync(join(repoRoot, group))) {
      dirs.push(join(repoRoot, group, entry));
    }
  }
  const map = new Map<string, Pkg>();
  for (const dir of dirs) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, "package.json"), "utf8");
    } catch {
      continue;
    }
    const pkg = JSON.parse(raw) as {
      name?: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    if (!pkg.name) continue;
    map.set(pkg.name, {
      name: pkg.name,
      deps: [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
      ],
    });
  }
  return map;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|js|mts|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("no code path from watch to checkout (safety contract: watches notify, never buy)", () => {
  it("@northcinder/checkout is absent from the entire workspace dependency tree of @northcinder/watches", () => {
    const packages = workspacePackages();
    expect(packages.has("@northcinder/watches")).toBe(true);
    expect(packages.has("@northcinder/checkout")).toBe(true); // the forbidden package really exists

    const reachable = new Set<string>();
    const queue = ["@northcinder/watches"];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const dep of packages.get(current)?.deps ?? []) {
        if (packages.has(dep)) queue.push(dep);
      }
    }
    expect([...reachable]).not.toContain("@northcinder/checkout");
    // The runtime graph is exactly the audited one — no surprise workspace deps.
    expect([...reachable].sort()).toEqual(["@northcinder/adapter-kit", "@northcinder/protocol", "@northcinder/watches"]);
  });

  it("no source file in @northcinder/watches imports @northcinder/checkout (or any checkout module)", () => {
    for (const file of sourceFiles(join(packageRoot, "src"))) {
      const content = readFileSync(file, "utf8");
      expect(content, `${file} must not reference @northcinder/checkout`).not.toContain("@northcinder/checkout");
      const importSpecifiers = [...content.matchAll(/from\s+"([^"]+)"|import\s*\(\s*"([^"]+)"\s*\)/g)]
        .map((m) => m[1] ?? m[2] ?? "")
        .filter(Boolean);
      for (const spec of importSpecifiers) {
        expect(spec, `${file} imports "${spec}" — watches must have no checkout import`).not.toMatch(/checkout/i);
      }
    }
  });

  it("the northcinder-watch RUNNABLE (client/src/watch-main.ts + everything it imports) has no runtime checkout import", () => {
    // The law must hold for the scheduler PROCESS, not just this package:
    // walk the client bin's relative import graph. `import type …` lines are
    // stripped first — they are erased at compile time and carry no runtime
    // code path (the client's config keeps a checkout TYPE for the MCP
    // server's own wiring; the watch runnable must load no checkout CODE).
    const clientSrc = join(repoRoot, "client", "src");
    const runtimeImports = (content: string): string[] =>
      [...content.replace(/import\s+type\s[^;]*;/g, "").matchAll(/from\s+"([^"]+)"|import\s*\(\s*"([^"]+)"\s*\)/g)]
        .map((m) => m[1] ?? m[2] ?? "")
        .filter(Boolean);
    const queue = ["watch-main.ts"];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const content = readFileSync(join(clientSrc, file), "utf8");
      for (const spec of runtimeImports(content)) {
        expect(spec, `client/src/${file} imports "${spec}" at runtime — the watch runnable must load no checkout code`).not.toMatch(
          /checkout/i,
        );
        if (spec.startsWith("./")) queue.push(spec.replace(/^\.\//, "").replace(/\.js$/, ".ts"));
      }
    }
    // Sanity: the walk really covered the runnable's wiring, not an empty graph.
    expect([...visited]).toEqual(expect.arrayContaining(["watch-main.ts", "watch-runner.ts", "config.ts", "service-client.ts"]));
  });

  it("package.json declares no checkout dependency of any kind", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = (pkg[field] ?? {}) as Record<string, string>;
      expect(Object.keys(deps)).not.toContain("@northcinder/checkout");
    }
  });
});
