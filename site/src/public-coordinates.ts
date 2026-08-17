const PLACEHOLDER_TOKENS = new Set([
  'changeme',
  'example',
  'examplecom',
  'exampleorg',
  'owner',
  'placeholder',
  'repo',
  'repository',
  'northcinderdev',
  'todo',
  'yourdomain',
  'yourorg',
]);

function normalizedToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPlaceholderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (
    host === 'example.com' ||
    host === 'example.net' ||
    host === 'example.org' ||
    ['.example', '.invalid', '.localhost', '.test'].some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
  ) return true;
  return host.split('.').some((label) => PLACEHOLDER_TOKENS.has(normalizedToken(label)));
}

function wellShapedGithubRepository(url: URL): boolean {
  if (url.hostname.toLowerCase() !== 'github.com' || url.port !== '') return false;
  if (!/^\/[^/]+\/[^/]+\/?$/.test(url.pathname)) return false;
  let owner: string;
  let repository: string;
  try {
    [owner, repository] = url.pathname.slice(1).replace(/\/$/, '').split('/').map(decodeURIComponent) as [string, string];
  } catch {
    return false;
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return false;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(repository)) return false;
  return !PLACEHOLDER_TOKENS.has(normalizedToken(owner)) && !PLACEHOLDER_TOKENS.has(normalizedToken(repository));
}

function configuredHttpsUrl(
  name: string,
  value: string | undefined,
  kind: 'origin' | 'repository',
): string | undefined {
  const configured = value?.trim();
  if (!configured) return undefined;

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`${name} must be an HTTPS ${kind === 'origin' ? 'origin' : 'repository URL'}`);
  }

  const sharedInvalid =
    url.protocol !== 'https:' ||
    Boolean(url.username || url.password || url.search || url.hash);
  const kindInvalid = kind === 'origin'
    ? url.pathname !== '/' || isPlaceholderHost(url.hostname)
    : !wellShapedGithubRepository(url);
  if (sharedInvalid || kindInvalid) {
    throw new Error(`${name} must be an HTTPS ${kind === 'origin' ? 'origin' : 'repository URL'}`);
  }

  return kind === 'origin' ? url.origin : url.href.replace(/\/$/, '');
}

export const SITE_URL = configuredHttpsUrl(
  'NORTHCINDER_SITE_URL',
  process.env.NORTHCINDER_SITE_URL,
  'origin',
);

export const REPOSITORY_URL = configuredHttpsUrl(
  'NORTHCINDER_REPOSITORY_URL',
  process.env.NORTHCINDER_REPOSITORY_URL,
  'repository',
);
