import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const siteDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function runBuild(env = {}) {
  const { NORTHCINDER_SITE_URL: _site, NORTHCINDER_REPOSITORY_URL: _repo, ...cleanEnv } = process.env;
  return spawnSync("corepack", ["pnpm", "exec", "astro", "build"], {
    cwd: siteDir,
    encoding: "utf8",
    env: { ...cleanEnv, ...env },
  });
}

function buildSite(env = {}) {
  const run = runBuild(env);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  return readFileSync(join(siteDir, "dist", "index.html"), "utf8");
}

function builtPublicTextAssets(dir = join(siteDir, "dist")) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return builtPublicTextAssets(path);
    return /\.(?:html|txt)$/.test(entry.name) ? [[path, readFileSync(path, "utf8")]] : [];
  });
}

function builtHtmlPages() {
  return builtPublicTextAssets().filter(([path]) => path.endsWith(".html"));
}

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]);
}

const placeholderTokens = new Set([
  "changeme", "example", "examplecom", "exampleorg", "owner", "placeholder",
  "repo", "repository", "northcinderdev", "todo", "yourdomain", "yourorg",
]);

function placeholderCoordinates(text) {
  const hits = [];
  for (const raw of text.match(/https?:\/\/[^\s"'<>),]+/g) ?? []) {
    let url;
    try { url = new URL(raw); } catch { continue; }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const hostLabels = host.split(".").map((label) => label.replace(/[^a-z0-9]/g, ""));
    const reservedHost = ["example.com", "example.net", "example.org"].includes(host) ||
      [".example", ".invalid", ".localhost", ".test"].some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
    const placeholderHost = reservedHost || hostLabels.some((label) => placeholderTokens.has(label));
    const githubParts = host === "github.com" ? url.pathname.split("/").filter(Boolean).slice(0, 2) : [];
    const placeholderGithub = githubParts.some((part) => placeholderTokens.has(decodeURIComponent(part).toLowerCase().replace(/[^a-z0-9]/g, "")));
    if (placeholderHost || placeholderGithub) hits.push(raw);
  }
  return hits;
}

test("the copied-asset scanner rejects every public-coordinate placeholder vocabulary", () => {
  const fakeUrls = [
    "https://example.com", "https://example.net", "https://example.org",
    "https://shop.example", "https://shop.invalid", "https://shop.localhost", "https://shop.test",
    ...[...placeholderTokens].map((token) => `https://${token}.com`),
    ...[...placeholderTokens].map((token) => `https://github.com/${token}/northcinder`),
    ...[...placeholderTokens].map((token) => `https://github.com/acme-labs/${token}`),
  ];
  assert.equal(placeholderCoordinates(fakeUrls.join("\n")).length, fakeUrls.length);
  assert.deepEqual(placeholderCoordinates("https://launch-42.net https://github.com/acme-labs/northcinder"), []);
});

test("an unconfigured local build fails closed without fake coordinates or indexable pages", () => {
  const html = buildSite();
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.doesNotMatch(html, /northcinder\.example|github\.com\/northcinder-dev/);
  assert.doesNotMatch(html, /rel="canonical"|property="og:url"/);
  assert.match(html, /npx northcinder init/);
  for (const [path, page] of builtHtmlPages()) {
    assert.match(page, /<meta name="robots" content="noindex, nofollow">/, `${path} must be noindex`);
    assert.doesNotMatch(page, /rel="canonical"|property="og:url"|application\/ld\+json/, `${path} leaked public metadata`);
  }
  assert.match(readFileSync(join(siteDir, "dist", "robots.txt"), "utf8"), /Disallow: \//);
  assert.equal((readFileSync(join(siteDir, "dist", "sitemap.xml"), "utf8").match(/<url>/g) ?? []).length, 0);
  for (const [path, asset] of builtPublicTextAssets()) {
    assert.deepEqual(placeholderCoordinates(asset), [], `${path} contains placeholder public coordinates`);
  }
});

test("a configured public build emits consistent metadata, schema, crawler, and sitemap contracts", () => {
  const origin = "https://launch-42.net";
  const repository = "https://github.com/acme-labs/northcinder";
  const html = buildSite({
    NORTHCINDER_SITE_URL: origin,
    NORTHCINDER_REPOSITORY_URL: repository,
  });

  assert.equal((html.match(/rel="canonical"/g) ?? []).length, 1);
  assert.match(html, new RegExp(`<link rel="canonical" href="${origin}/">`));
  assert.match(html, new RegExp(`<meta property="og:url" content="${origin}/">`));
  assert.match(html, /<meta property="og:type" content="website">/);
  assert.match(html, /<meta property="og:site_name" content="NorthCinder">/);
  assert.match(html, new RegExp(`<meta property="og:image" content="${origin}/social-card.png">`));
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<meta name="twitter:image:alt" content="NorthCinder: buyer-loyal, ad-neutral, auditable shopping">/);
  assert.match(html, /<meta name="robots" content="index, follow">/);
  assert.match(html, /<script type="application\/ld\+json">/);
  assert.match(html, new RegExp(`"url":"${origin}/"`));
  assert.match(html, new RegExp(`"codeRepository":"${repository}"`));
  assert.match(html, new RegExp(`href="${repository}`));
  assert.match(readFileSync(join(siteDir, "public", "social-card.svg"), "utf8"), /NorthCinder/);
  assert.match(readFileSync(join(siteDir, "public", "social-card.png.provenance.json"), "utf8"), /project-authored-vector/);

  const pages = builtHtmlPages();
  const indexable = pages.filter(([path]) => !path.endsWith("404.html"));
  const expectedSchemaTypes = new Map([
    ["/", ["Organization", "Person", "WebSite", "SoftwareApplication", "FAQPage"]],
    ["/install/", ["Organization", "Person", "TechArticle", "BreadcrumbList", "FAQPage", "HowTo"]],
    ["/ranking/", ["Organization", "Person", "TechArticle", "BreadcrumbList", "FAQPage"]],
    ["/checkout-safety/", ["Organization", "Person", "TechArticle", "BreadcrumbList", "FAQPage"]],
    ["/store-coverage/", ["Organization", "Person", "TechArticle", "BreadcrumbList", "FAQPage"]],
    ["/evidence/", ["Organization", "Person", "TechArticle", "BreadcrumbList", "FAQPage", "Dataset"]],
    ["/about/", ["Organization", "Person", "AboutPage", "BreadcrumbList", "FAQPage"]],
  ]);
  assert.equal(indexable.length, 7);
  const titles = new Set();
  const canonicals = new Set();
  for (const [path, page] of indexable) {
    assert.match(page, /<meta name="robots" content="index, follow">/, `${path} must be indexable`);
    assert.equal((page.match(/rel="canonical"/g) ?? []).length, 1, `${path} canonical count`);
    assert.equal((page.match(/property="og:url"/g) ?? []).length, 1, `${path} og:url count`);
    const canonical = page.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
    const ogUrl = page.match(/<meta property="og:url" content="([^"]+)">/)?.[1];
    assert.ok(canonical, `${path} missing canonical`);
    assert.equal(ogUrl, canonical, `${path} canonical and og:url disagree`);
    canonicals.add(canonical);
    const title = page.match(/<title>([^<]+)<\/title>/)?.[1];
    assert.ok(title, `${path} missing title`);
    titles.add(title);
    const blocks = jsonLdBlocks(page);
    assert.equal(blocks.length, 1, `${path} JSON-LD block count`);
    assert.doesNotMatch(blocks[0], /<\/script>/i, `${path} JSON-LD breakout`);
    const parsedSchema = JSON.parse(blocks[0]);
    const schemaTypes = new Set(parsedSchema["@graph"].map((entry) => entry["@type"]));
    for (const expectedType of expectedSchemaTypes.get(new URL(canonical).pathname) ?? []) {
      assert.ok(schemaTypes.has(expectedType), `${path} missing ${expectedType} schema`);
    }
  }
  assert.equal(titles.size, indexable.length);
  assert.equal(canonicals.size, indexable.length);

  const notFound = readFileSync(join(siteDir, "dist", "404.html"), "utf8");
  assert.match(notFound, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(notFound, /rel="canonical"|property="og:url"|application\/ld\+json/);

  const robots = readFileSync(join(siteDir, "dist", "robots.txt"), "utf8");
  assert.match(robots, /Allow: \//);
  assert.match(robots, new RegExp(`Sitemap: ${origin}/sitemap\\.xml`));
  const sitemap = readFileSync(join(siteDir, "dist", "sitemap.xml"), "utf8");
  assert.equal((sitemap.match(/<url>/g) ?? []).length, 7);
  for (const canonical of canonicals) assert.match(sitemap, new RegExp(`<loc>${canonical}</loc>`));
  const llms = readFileSync(join(siteDir, "dist", "llms.txt"), "utf8");
  assert.match(llms, new RegExp(`${origin}/ranking/`));
  assert.match(llms, new RegExp(`Source: ${repository}`));

  for (const [sourcePath, page] of pages) {
    for (const match of page.matchAll(/href="([^"]+)"/g)) {
      const href = match[1];
      if (!href.startsWith("/")) continue;
      const parsed = new URL(href, origin);
      const relativePath = parsed.pathname === "/"
        ? "index.html"
        : parsed.pathname.endsWith("/")
          ? join(parsed.pathname.slice(1), "index.html")
          : parsed.pathname.slice(1);
      assert.ok(existsSync(join(siteDir, "dist", relativePath)), `${sourcePath} has broken internal link ${href}`);
    }
  }
});

test("invalid public coordinates fail closed instead of leaking ambiguous metadata", () => {
  for (const [name, value] of [
    ["NORTHCINDER_SITE_URL", "http://northcinder.test"],
    ["NORTHCINDER_SITE_URL", "https://user:secret@northcinder.test"],
    ["NORTHCINDER_SITE_URL", "https://northcinder.test/path"],
    ["NORTHCINDER_SITE_URL", "https://northcinder.example"],
    ["NORTHCINDER_SITE_URL", "https://example.com"],
    ["NORTHCINDER_REPOSITORY_URL", "https://github.com/example/northcinder?tab=readme"],
    ["NORTHCINDER_REPOSITORY_URL", "ssh://github.com/example/northcinder"],
    ["NORTHCINDER_REPOSITORY_URL", "https://evil.example/not-github"],
    ["NORTHCINDER_REPOSITORY_URL", "https://github.com/example/northcinder"],
    ["NORTHCINDER_REPOSITORY_URL", "https://github.com/owner/repo"],
    ["NORTHCINDER_REPOSITORY_URL", "https://github.com/northcinder-dev/legacy-shopping"],
    ["NORTHCINDER_REPOSITORY_URL", "https://github.com/acme-labs"],
    ["NORTHCINDER_REPOSITORY_URL", "https://github.com/acme-labs/northcinder/issues"],
  ]) {
    const run = runBuild({ [name]: value });
    assert.notEqual(run.status, 0, `${name}=${value} unexpectedly built successfully`);
    assert.match(`${run.stdout}\n${run.stderr}`, /must be an HTTPS origin|must be an HTTPS repository URL/);
  }
});

test("the release page preserves landmarks, heading order, keyboard focus, and preference-responsive CSS", () => {
  const html = buildSite();
  const cssDir = join(siteDir, "dist", "_astro");
  const css = readdirSync(cssDir)
    .filter((name) => name.endsWith(".css"))
    .map((name) => readFileSync(join(cssDir, name), "utf8"))
    .join("\n");
  assert.match(html, /<a class="skip-link" href="#main-content">Skip to main content<\/a>/);
  assert.match(html, /<nav class="top" aria-label="Primary"[^>]*>/);
  assert.match(html, /<main id="main-content" tabindex="-1"[^>]*>/);
  assert.match(html, /<section class="features" id="features" aria-labelledby="features-title"[^>]*>/);
  assert.match(html, /<h2 id="features-title" class="visually-hidden">Capabilities<\/h2>/);
  assert.equal((html.match(/<h1(?:\s|>)/g) ?? []).length, 1);
  assert.match(html, /aria-label="NorthCinder mark"/);
  assert.match(html, />NorthCinder<\/span>/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-color-scheme:dark/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(css, /font-family:[^}]*Inter|font-family:[^}]*JetBrains Mono/);
  assert.match(css, /min-height:44px/);
  for (const [path, page] of builtHtmlPages()) {
    assert.match(page, /<a class="skip-link" href="#main-content">Skip to main content<\/a>/, `${path} skip link`);
    assert.match(page, /<nav class="top" aria-label="Primary"[^>]*>/, `${path} primary nav`);
    assert.match(page, /<main id="main-content" tabindex="-1"[^>]*>/, `${path} main landmark`);
    assert.equal((page.match(/<h1(?:\s|>)/g) ?? []).length, 1, `${path} h1 count`);
  }
});
