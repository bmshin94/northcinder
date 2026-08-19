import type { APIRoute } from 'astro';
import { SITE_URL } from '../public-coordinates';

export const prerender = true;

export const GET: APIRoute = () => {
  const body = SITE_URL
    ? `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n';
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
