#!/usr/bin/env node

const rawOrigin = process.argv[2];
if (!rawOrigin) {
  process.stderr.write('usage: pnpm seo:live -- https://your-production-origin\n');
  process.exit(2);
}

let origin;
try {
  const parsed = new URL(rawOrigin);
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('not an HTTPS origin');
  }
  origin = parsed.origin;
} catch {
  process.stderr.write('origin must be a bare HTTPS origin with no path, credentials, query, or fragment\n');
  process.exit(2);
}

const crawlerAgents = [
  ['browser', 'Mozilla/5.0 (compatible; NorthCinderLiveCheck/1.0)'],
  ['OAI-SearchBot', 'OAI-SearchBot/1.0; +https://openai.com/searchbot'],
  ['ChatGPT-User', 'ChatGPT-User/1.0; +https://openai.com/bot'],
  ['GPTBot', 'GPTBot/1.0; +https://openai.com/gptbot'],
  ['PerplexityBot', 'PerplexityBot/1.0; +https://perplexity.ai/perplexitybot'],
  ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
  ['Bingbot', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'],
];

const requiredPaths = ['/', '/install/', '/ranking/', '/checkout-safety/', '/store-coverage/', '/evidence/', '/about/'];
const findings = [];
const results = [];

function challengeDetected(response, body) {
  return response.headers.has('cf-mitigated') || /checking your browser|verify you are human|attention required|captcha/i.test(body);
}

for (const [name, userAgent] of crawlerAgents) {
  try {
    const response = await fetch(origin, { headers: { 'User-Agent': userAgent }, redirect: 'follow' });
    const body = await response.text();
    const challenged = challengeDetected(response, body);
    results.push({ check: 'crawler', name, status: response.status, challenged });
    if (!response.ok || challenged) findings.push(`${name} received ${response.status}${challenged ? ' with a challenge page' : ''}`);
  } catch (error) {
    findings.push(`${name} request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const path of requiredPaths) {
  try {
    const response = await fetch(new URL(path, origin), { redirect: 'follow' });
    const body = await response.text();
    const canonical = body.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
    const expected = new URL(path, `${origin}/`).href;
    const cacheControl = response.headers.get('cache-control') ?? '';
    const schemas = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    results.push({ check: 'page', path, status: response.status, canonical, schemas: schemas.length, cacheControl });
    if (!response.ok) findings.push(`${path} returned ${response.status}`);
    if (canonical !== expected) findings.push(`${path} canonical is ${canonical ?? 'missing'}, expected ${expected}`);
    if (/noindex/i.test(body)) findings.push(`${path} is noindex`);
    if (/\b(?:no-store|private)\b/i.test(cacheControl)) findings.push(`${path} uses non-public cache-control: ${cacheControl}`);
    if (schemas.length !== 1) findings.push(`${path} has ${schemas.length} JSON-LD blocks, expected 1`);
    for (const schema of schemas) {
      try { JSON.parse(schema[1]); } catch { findings.push(`${path} contains invalid JSON-LD`); }
    }
  } catch (error) {
    findings.push(`${path} request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const assetPath of ['/robots.txt', '/sitemap.xml', '/llms.txt', '/social-card.png']) {
  try {
    const response = await fetch(new URL(assetPath, origin), { redirect: 'follow' });
    const body = assetPath === '/social-card.png' ? '' : await response.text();
    results.push({ check: 'asset', path: assetPath, status: response.status, contentType: response.headers.get('content-type') });
    if (!response.ok) findings.push(`${assetPath} returned ${response.status}`);
    if (assetPath === '/robots.txt' && /Disallow:\s*\/(?:\s|$)/i.test(body)) findings.push('/robots.txt disallows the site root');
    if (assetPath === '/robots.txt' && !body.includes(`${origin}/sitemap.xml`)) findings.push('/robots.txt does not declare the canonical sitemap');
    if (assetPath === '/sitemap.xml') {
      for (const path of requiredPaths) {
        const expected = new URL(path, `${origin}/`).href;
        if (!body.includes(`<loc>${expected}</loc>`)) findings.push(`/sitemap.xml is missing ${expected}`);
      }
    }
  } catch (error) {
    findings.push(`${assetPath} request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.stdout.write(`${JSON.stringify({ origin, checkedAt: new Date().toISOString(), results, findings }, null, 2)}\n`);
if (findings.length > 0) process.exitCode = 1;
