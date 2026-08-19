import type { APIRoute } from 'astro';
import { SITE_URL } from '../public-coordinates';
import { INDEXABLE_PAGES } from '../site-content';

export const prerender = true;

const priorities = new Map([
  ['/', '1.0'],
  ['/install/', '0.9'],
  ['/ranking/', '0.9'],
  ['/checkout-safety/', '0.8'],
  ['/store-coverage/', '0.8'],
  ['/evidence/', '0.8'],
  ['/about/', '0.6'],
]);

export const GET: APIRoute = () => {
  const entries = SITE_URL ? INDEXABLE_PAGES.map((page) => `
  <url>
    <loc>${new URL(page.path, `${SITE_URL}/`).href}</loc>
    <lastmod>${page.modified}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>${priorities.get(page.path) ?? '0.5'}</priority>
  </url>`).join('') : '';
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}
</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
