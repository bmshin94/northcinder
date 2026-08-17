import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createZip, readZipEntries } from "../scripts/zip-lite.mjs";
import { validateMcpbManifest } from "../scripts/validate-mcpb-manifest.mjs";
import { buildMcpb, buildMcpbEntries, bundleMainEntry, collectDistFiles } from "../scripts/build-mcpb.mjs";

const CLIENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

describe("zip-lite", () => {
  it("round-trips text and binary entries through createZip/readZipEntries", () => {
    const entries = [
      { name: "manifest.json", data: Buffer.from(JSON.stringify({ a: 1 })) },
      { name: "server/main.js", data: Buffer.from("console.log('hi');\n".repeat(50)) },
    ];
    const zip = createZip(entries);
    // A real ZIP: PK\x03\x04 local file header signature at byte 0.
    expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const read = readZipEntries(zip);
    expect(read.map((e) => e.name)).toEqual(["manifest.json", "server/main.js"]);
    expect(JSON.parse(read[0].data.toString("utf8"))).toEqual({ a: 1 });
    expect(read[1].data.toString("utf8")).toBe("console.log('hi');\n".repeat(50));
  });
});

describe("validateMcpbManifest against client/mcpb/manifest.json", () => {
  it("has zero validation errors", () => {
    const manifest = JSON.parse(readFileSync(join(CLIENT_DIR, "mcpb", "manifest.json"), "utf8"));
    expect(validateMcpbManifest(manifest)).toEqual([]);
  });

  it("marks the client API key as sensitive (never plain-text in the UI)", () => {
    const manifest = JSON.parse(readFileSync(join(CLIENT_DIR, "mcpb", "manifest.json"), "utf8"));
    expect(manifest.user_config.clientKey.sensitive).toBe(true);
    expect(manifest.user_config.clientKey.type).toBe("string");
  });

  it("flags a manifest with sensitive on a non-string field", () => {
    const bad = {
      manifest_version: "0.3",
      name: "x",
      version: "0.1.0",
      description: "d",
      author: { name: "a" },
      server: { type: "node", entry_point: "server/main.js" },
      user_config: { port: { type: "number", sensitive: true } },
    };
    const errors = validateMcpbManifest(bad);
    expect(errors).toContain('user_config.port: "sensitive" is only valid on type "string"');
  });

  it("flags a missing required field", () => {
    const errors = validateMcpbManifest({ name: "x" });
    expect(errors).toEqual(
      expect.arrayContaining([
        "missing required field: manifest_version",
        "missing required field: version",
        "missing required field: description",
        "missing required field: author",
        "missing required field: server",
      ]),
    );
  });
});

describe("buildMcpb", () => {
  let fakeClientDir: string;

  afterEach(() => {
    if (fakeClientDir) rmSync(fakeClientDir, { recursive: true, force: true });
  });

  function makeFakeClientDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "northcinder-mcpb-"));
    mkdirSync(join(dir, "mcpb"), { recursive: true });
    writeFileSync(
      join(dir, "mcpb", "manifest.json"),
      JSON.stringify(JSON.parse(readFileSync(join(CLIENT_DIR, "mcpb", "manifest.json"), "utf8"))),
    );
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "main.js"), "console.log('fake server');\n");
    mkdirSync(join(dir, "dist", "nested"), { recursive: true });
    writeFileSync(join(dir, "dist", "nested", "helper.js"), "export const x = 1;\n");
    return dir;
  }

  it("collectDistFiles walks nested directories", () => {
    fakeClientDir = makeFakeClientDir();
    const files = collectDistFiles(join(fakeClientDir, "dist"));
    expect(files.length).toBe(2);
  });

  it("produces a zip whose manifest.json validates and whose server/ carries the bundled entry", () => {
    fakeClientDir = makeFakeClientDir();
    const { entries } = buildMcpbEntries(fakeClientDir);
    const names = entries.map((e) => e.name).sort();
    // No node_modules-dependent unbundled dist/ is shipped anymore — only the
    // manifest + the single self-contained bundle esbuild produces.
    expect(names).toEqual(["manifest.json", "server/main.bundle.js"]);

    const zip = createZip(entries);
    const read = readZipEntries(zip);
    const manifestEntry = read.find((e) => e.name === "manifest.json")!;
    const manifest = JSON.parse(manifestEntry.data.toString("utf8"));
    expect(validateMcpbManifest(manifest)).toEqual([]);
    expect(manifest.server.entry_point).toBe("server/main.bundle.js");
    const bundleEntry = read.find((e) => e.name === "server/main.bundle.js")!;
    expect(bundleEntry.data.toString("utf8")).toContain("fake server");
  });

  it("buildMcpb() writes northcinder.mcpb to disk as a valid, readable zip", () => {
    fakeClientDir = makeFakeClientDir();
    const outPath = join(fakeClientDir, "northcinder.mcpb");
    const written = buildMcpb(fakeClientDir, outPath);
    expect(written).toBe(outPath);
    const zip = readFileSync(outPath);
    const read = readZipEntries(zip);
    expect(read.some((e) => e.name === "manifest.json")).toBe(true);
  });

  it("throws a clear error when dist/ is missing (build not run yet)", () => {
    const dir = mkdtempSync(join(tmpdir(), "northcinder-mcpb-nodist-"));
    mkdirSync(join(dir, "mcpb"), { recursive: true });
    writeFileSync(join(dir, "mcpb", "manifest.json"), readFileSync(join(CLIENT_DIR, "mcpb", "manifest.json")));
    try {
      expect(() => buildMcpbEntries(dir)).toThrow(/dist\/ not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bundleMainEntry — esbuild-bundles the real compiled client, no vendored node_modules needed", () => {
  it("dist/main.js (pre-bundle) still requires workspace packages — sanity check the fixture is real", () => {
    const mainJs = readFileSync(join(CLIENT_DIR, "dist", "main.js"), "utf8");
    expect(mainJs).toMatch(/@northcinder\//);
  });

  it("produces dist/main.bundle.js with every @northcinder/* workspace import inlined — none left unresolved", () => {
    const outfile = bundleMainEntry(CLIENT_DIR);
    expect(outfile).toBe(join(CLIENT_DIR, "dist", "main.bundle.js"));
    const bundled = readFileSync(outfile, "utf8");
    // No unresolved require/import of a workspace package survives bundling
    // (doc comments mentioning "@northcinder/x" in prose are fine — only a live
    // module specifier would mean node_modules is still needed at runtime).
    expect(bundled).not.toMatch(/\bfrom\s+["']@northcinder\//);
    expect(bundled).not.toMatch(/\brequire\(\s*["']@northcinder\//);
    expect(bundled).not.toMatch(/\bimport\(\s*["']@northcinder\//);
    // A real, substantial bundle — not an empty/truncated file.
    expect(bundled.length).toBeGreaterThan(10_000);
  });
});
