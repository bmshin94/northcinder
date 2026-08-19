import type { APIRoute } from 'astro';
import { REPOSITORY_URL, SITE_URL } from '../public-coordinates';
import { INDEXABLE_PAGES } from '../site-content';

export const prerender = true;

export const GET: APIRoute = () => {
  const pageLinks = SITE_URL
    ? INDEXABLE_PAGES.map((page) => `- ${page.label}: ${new URL(page.path, `${SITE_URL}/`).href}`).join('\n')
    : '- Canonical site pages are omitted because no production origin is configured.';
  const sourceLinks = REPOSITORY_URL
    ? `Source: ${REPOSITORY_URL}\nRanking specification: ${REPOSITORY_URL}/blob/main/docs/RANKING.md\nTrust specification: ${REPOSITORY_URL}/blob/main/docs/TRUST.md\nSecurity reports: ${REPOSITORY_URL}/security/advisories/new`
    : 'Source coordinates are omitted because no verified repository URL is configured for this build.';
  const body = `# NorthCinder

NorthCinder is open-source, buyer-run shopping-agent MCP software. It ranks disclosed offers against the buyer's brief, explains the ordering, reports store coverage, and requires explicit approval before automated checkout.

## Canonical pages

${pageLinks}

## Source and evidence

${sourceLinks}

Package: https://www.npmjs.com/package/northcinder

## Product contract

1. Ranking inputs are buyer criteria, never seller payment.
2. Sponsored offers are labeled and rank below organic offers.
3. Checkout requires a signed, single-use, per-purchase human approval.
4. Recommendations include machine-readable reasons persisted locally.
5. Missing merchant history remains unknown; only deny-grade evidence produces flagged status.
6. Raw payment-card fields are rejected.
7. The repository maintainer operates no NorthCinder endpoint, account system, telemetry, or control plane.
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
