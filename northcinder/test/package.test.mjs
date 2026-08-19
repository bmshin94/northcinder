import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const serviceManifest = JSON.parse(readFileSync(new URL("../../service/package.json", import.meta.url), "utf8"));
const packageReadme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const rootReadme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

assert.equal(manifest.name, "northcinder", "public npm coordinate must match the NorthCinder CLI name");
assert.equal(manifest.version, "0.1.2", "NorthCinder must continue the public release sequence");
assert.deepEqual(manifest.bin, { northcinder: "bin/northcinder.js" }, "package and executable must share the canonical slug");
for (const [label, readme] of [["packed README", packageReadme], ["root README", rootReadme]]) {
  assert.match(readme, /npx northcinder init/, `${label} must use the public npm coordinate`);
  assert.doesNotMatch(readme, /npx brier-agent init/, `${label} must not send users to the former npm coordinate`);
}
assert.match(manifest.description, /buyer.*shopping agent/i);
assert.equal(manifest.repository?.url, "git+https://github.com/cinderline/northcinder.git");
assert.equal(manifest.homepage, "https://github.com/cinderline/northcinder#readme");
assert.equal(manifest.bugs?.url, "https://github.com/cinderline/northcinder/issues");
assert.equal(serviceManifest.private, true);
assert.equal(serviceManifest.bin, undefined, "private service must not advertise unbuilt workspace bins");

const packed = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageDir,
    encoding: "utf8",
  }),
)[0];
const files = new Set(packed.files.map((file) => file.path));

assert.equal(files.has("README.md"), true, "published package must include README.md");
assert.equal(files.has("LICENSE"), true, "published package must include LICENSE");
